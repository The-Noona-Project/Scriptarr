/**
 * @file Sage-owned Appa admin chat and Noona public-reply review helpers.
 */

import {appendDurableEvent, buildServiceActor} from "./adminEvents.mjs";
import {proposeAiAction} from "./aiTools.mjs";
import {buildNoonaVisualIdentityContext} from "./noonaVisualIdentity.mjs";

export const APPA_CHAT_PROPOSAL_TOOL_IDS = Object.freeze([
  "status_check",
  "trivia_start",
  "trivia_stop"
]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const DISCORD_AI_CHAT_TIMEOUT_MS = 90000;
const DISCORD_AI_REVIEW_TIMEOUT_MS = 60000;

const isActionPrompt = (message) => /\b(start|stop|cancel|end|run|check|probe)\b/i.test(normalizeString(message));

const redactExcerpt = (value, limit = 220) => normalizeString(value)
  .replace(/\b(token|secret|password|passwd|api[_ -]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
  .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
  .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_ -]{12,}\b/gi, "[redacted-token]")
  .replace(/https?:\/\/\S+/gi, "[redacted-url]")
  .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, "[redacted-mention]")
  .replace(/@(everyone|here)\b/gi, "@[redacted]")
  .replace(/\s+/g, " ")
  .slice(0, limit)
  .trim();

const normalizeDiagnosticSnippet = (entry = {}) => ({
  messageId: normalizeString(entry.messageId),
  author: redactExcerpt(entry.author, 64),
  createdAt: normalizeString(entry.createdAt),
  snippet: redactExcerpt(entry.snippet, 180),
  attachmentCount: Math.max(0, Number.parseInt(String(entry.attachmentCount ?? 0), 10) || 0)
});

const proposalReply = (planned) => {
  if (planned?.ok === false) {
    if (planned.status === 403) {
      return "Appa cannot draft that from Discord. Use the admin AI page for higher-risk work.";
    }
    return planned.error || "Appa could not draft that proposal from Discord.";
  }
  return planned?.proposal
    ? `Appa drafted a ${planned.tool?.label || "Scriptarr"} proposal for admin confirmation. Proposal id: ${planned.proposal.id}.`
    : "";
};

const buildServiceHealthContext = async ({config, serviceJson}) => {
  const services = [
    ["warden", config.wardenBaseUrl, "/health"],
    ["oracle", config.oracleBaseUrl, "/health"],
    ["raven", config.ravenBaseUrl, "/health"],
    ["portal", config.portalBaseUrl, "/health"]
  ].filter(([, baseUrl]) => normalizeString(baseUrl));
  const entries = await Promise.all(services.map(async ([service, baseUrl, path]) => {
    try {
      const result = await serviceJson(baseUrl, path, {timeoutMs: 2500});
      return [service, {
        ok: result.ok !== false,
        status: result.status || 200,
        summary: normalizeString(result.payload?.status || result.payload?.service || result.payload?.message)
      }];
    } catch (error) {
      return [service, {
        ok: false,
        status: 503,
        summary: error instanceof Error ? error.message : String(error)
      }];
    }
  }));
  return Object.fromEntries(entries);
};

const buildAppaReadContext = async ({config, serviceJson, triviaService, readPortalDiscordSettings}) => {
  const [serviceHealth, discord, trivia] = await Promise.all([
    buildServiceHealthContext({config, serviceJson}).catch(() => null),
    readPortalDiscordSettings?.().catch(() => null),
    triviaService?.getState?.().catch(() => null)
  ]);
  return {
    serviceHealth,
    discord: discord ? {
      guildId: normalizeString(discord.guildId),
      noonaChatEnabled: discord.noonaChat?.enabled === true,
      appaEnabled: discord.appa?.enabled === true,
      appaReviewEnabled: discord.appa?.reviewEnabled === true,
      triviaEnabled: discord.trivia?.enabled === true
    } : null,
    trivia,
    visualIdentity: buildNoonaVisualIdentityContext()
  };
};

const fallbackAppaReply = (message) => {
  if (/\b(status|health|alive|up|down|broken|working)\b/i.test(normalizeString(message))) {
    return "Appa is watching the admin side. Oracle is quiet, so use the admin status page for exact live probes.";
  }
  return "Appa is here for admin review. Oracle is quiet right now, so I will stay conservative.";
};

const normalizeReviewDecision = (value = {}) => {
  const source = normalizeObject(value, {}) || {};
  const verdict = normalizeString(source.verdict || source.decision, "ok").toLowerCase();
  const severity = normalizeString(source.severity, verdict === "correct" ? "serious" : "none").toLowerCase();
  const normalizedVerdict = ["ok", "correct"].includes(verdict) ? verdict : "ok";
  const normalizedSeverity = ["none", "low", "medium", "serious", "high", "critical"].includes(severity) ? severity : "none";
  const reasonsSource = Array.isArray(source.reasons) ? source.reasons : source.reason ? [source.reason] : [];
  return {
    verdict: normalizedVerdict,
    severity: normalizedSeverity,
    score: Math.max(0, Math.min(1, Number(source.score ?? (normalizedVerdict === "correct" ? 1 : 0)) || 0)),
    reasons: normalizeArray(reasonsSource)
      .map((entry) => normalizeString(entry))
      .filter(Boolean)
      .slice(0, 5),
    correctionText: normalizeString(source.correctionText || source.correction || source.text).slice(0, 900)
  };
};

const seriousSeverity = (severity) => ["serious", "high", "critical"].includes(normalizeString(severity).toLowerCase());

/**
 * Create Sage-owned Appa services used by Portal.
 *
 * @param {{
 *   config: Record<string, string>,
 *   vaultClient: {upsertDiscordUser?: Function, appendEvent?: Function},
 *   serviceJson: Function,
 *   triviaService?: Record<string, Function>,
 *   readPortalDiscordSettings?: Function,
 *   logger?: {warn?: Function}
 * }} options
 * @returns {{handlePortalAdminMention: Function, reviewNoonaPublicReply: Function, recordNoonaReviewDelivery: Function, recordDiscordDiagnostic: Function}}
 */
export const createAppaChatService = ({
  config,
  vaultClient,
  serviceJson,
  triviaService,
  readPortalDiscordSettings,
  logger
}) => {
  const handlePortalAdminMention = async (payload = {}) => {
    const message = normalizeString(payload.message);
    const user = normalizeObject(payload.user, {}) || {};
    const discordUserId = normalizeString(user.discordUserId || user.id);
    if (!message) {
      return {ok: false, status: 400, error: "message is required."};
    }
    if (!discordUserId) {
      return {ok: false, status: 400, error: "discord user id is required."};
    }

    await vaultClient.upsertDiscordUser?.({
      discordUserId,
      username: normalizeString(user.username || user.displayName || user.globalName, "Discord Admin"),
      avatarUrl: normalizeString(user.avatarUrl) || null,
      role: "admin"
    }).catch(() => null);

    if (normalizeString(payload.proposalMode, "conservative") === "conservative" && isActionPrompt(message)) {
      const planned = await proposeAiAction({
        vaultClient,
        prompt: message,
        user: {
          discordUserId,
          username: normalizeString(user.username || user.displayName || user.globalName, "Discord Admin")
        },
        allowedToolIds: APPA_CHAT_PROPOSAL_TOOL_IDS
      });
      if (planned.proposal || planned.ok === false) {
        return {
          ok: true,
          reply: proposalReply(planned),
          proposal: planned.proposal || null,
          tool: planned.tool || null,
          blocked: planned.ok === false,
          error: planned.error || ""
        };
      }
    }

    const readContext = await buildAppaReadContext({config, serviceJson, triviaService, readPortalDiscordSettings});
    const oracle = await serviceJson(config.oracleBaseUrl, "/api/chat", {
      method: "POST",
      body: {
        message,
        personaName: "Appa",
        context: {
          source: "discord-appa-admin-mention",
          personaName: "Appa",
          personaStyle: "Appa is Scriptarr's admin and review persona: calm, concise, professional, and conservative about operations.",
          user: {
            discordUserId,
            username: normalizeString(user.username || user.displayName || user.globalName, "Admin"),
            displayName: normalizeString(user.displayName || user.globalName || user.username)
          },
          readContext
        }
      },
      timeoutMs: DISCORD_AI_CHAT_TIMEOUT_MS
    }).catch((error) => ({
      ok: false,
      status: 503,
      payload: {error: error instanceof Error ? error.message : String(error)}
    }));
    const oraclePayload = oracle.payload || {};
    const oracleDegraded = oracle.ok === false || oraclePayload.disabled === true || oraclePayload.degraded === true;
    return {
      ok: true,
      reply: normalizeString(oraclePayload.reply, fallbackAppaReply(message)),
      readContext,
      oracle: {
        disabled: oraclePayload.disabled === true,
        degraded: oracleDegraded
      },
      error: normalizeString(oraclePayload.error)
    };
  };

  const reviewNoonaPublicReply = async (payload = {}) => {
    const reviewEnabled = payload.reviewEnabled !== false;
    if (!reviewEnabled) {
      return {ok: true, decision: normalizeReviewDecision(), shouldCorrect: false};
    }

    const assist = await serviceJson(config.oracleBaseUrl, "/api/assist", {
      method: "POST",
      body: {
        task: "review-noona-public-chat",
        prompt: redactExcerpt(payload.prompt, 600),
        deterministicContent: redactExcerpt(payload.reply, 1200),
        context: {
          guildId: normalizeString(payload.guildId),
          channelId: normalizeString(payload.channelId),
          messageId: normalizeString(payload.messageId),
          replyMessageId: normalizeString(payload.replyMessageId),
          user: {
            discordUserId: normalizeString(payload.user?.discordUserId),
            username: normalizeString(payload.user?.username || payload.user?.displayName)
          }
        }
      },
      timeoutMs: DISCORD_AI_REVIEW_TIMEOUT_MS
    }).catch((error) => ({
      ok: false,
      status: 503,
      payload: {
        decision: normalizeReviewDecision(),
        error: error instanceof Error ? error.message : String(error)
      }
    }));
    const decision = normalizeReviewDecision(assist.payload?.decision || assist.payload);
    const shouldCorrect = decision.verdict === "correct"
      && seriousSeverity(decision.severity)
      && normalizeString(decision.correctionText)
      && normalizeString(payload.correctionMode, "serious") !== "off";

    await appendDurableEvent(vaultClient, {
      ...buildServiceActor("scriptarr-sage", "Sage Appa review"),
      domain: "discord",
      eventType: "noona-public-review",
      severity: shouldCorrect ? "warning" : "info",
      targetType: "discord-message",
      targetId: normalizeString(payload.messageId || payload.replyMessageId),
      message: shouldCorrect
        ? "Appa recommended a serious public Noona correction."
        : "Appa reviewed a public Noona reply.",
      metadata: {
        guildId: normalizeString(payload.guildId),
        channelId: normalizeString(payload.channelId),
        userId: normalizeString(payload.user?.discordUserId),
        verdict: decision.verdict,
        severity: decision.severity,
        score: decision.score,
        reasons: decision.reasons,
        promptExcerpt: redactExcerpt(payload.prompt),
        replyExcerpt: redactExcerpt(payload.reply),
        correctionRecommended: Boolean(shouldCorrect),
        corrected: false,
        deliveryStatus: shouldCorrect ? "pending" : "not-needed",
        oracleDegraded: assist.ok === false || assist.payload?.degraded === true || assist.payload?.disabled === true,
        error: normalizeString(assist.payload?.error)
      }
    }, logger);

    return {
      ok: true,
      decision,
      shouldCorrect: Boolean(shouldCorrect),
      correctionText: shouldCorrect ? decision.correctionText : "",
      oracle: {
        degraded: assist.ok === false || assist.payload?.degraded === true,
        disabled: assist.payload?.disabled === true
      },
      error: normalizeString(assist.payload?.error)
    };
  };

  const recordNoonaReviewDelivery = async (payload = {}) => {
    const delivered = payload.delivered === true;
    await appendDurableEvent(vaultClient, {
      ...buildServiceActor("scriptarr-portal", "Portal Appa review"),
      domain: "discord",
      eventType: "noona-public-review-correction",
      severity: delivered ? "info" : "warning",
      targetType: "discord-message",
      targetId: normalizeString(payload.messageId || payload.replyMessageId),
      message: delivered
        ? "Appa posted a public Noona correction."
        : "Appa could not post a recommended public Noona correction.",
      metadata: {
        guildId: normalizeString(payload.guildId),
        channelId: normalizeString(payload.channelId),
        messageId: normalizeString(payload.messageId),
        replyMessageId: normalizeString(payload.replyMessageId),
        correctionMessageId: normalizeString(payload.correctionMessageId),
        delivered,
        error: redactExcerpt(payload.error, 220)
      }
    }, logger);
    return {ok: true, delivered};
  };

  const recordDiscordDiagnostic = async (payload = {}) => {
    const action = normalizeString(payload.action).toLowerCase();
    if (!["inspect", "testpost"].includes(action)) {
      return {ok: false, status: 400, error: "Unsupported Appa Discord diagnostic action."};
    }
    const snippets = normalizeArray(payload.snippets)
      .map((entry) => normalizeDiagnosticSnippet(normalizeObject(entry, {}) || {}))
      .filter((entry) => entry.snippet || entry.messageId)
      .slice(0, 10);
    await appendDurableEvent(vaultClient, {
      ...buildServiceActor("scriptarr-portal", "Portal Appa diagnostics"),
      domain: "discord",
      eventType: "appa-discord-diagnostic",
      severity: "info",
      targetType: "discord-channel",
      targetId: normalizeString(payload.channelId),
      message: action === "inspect"
        ? "Appa inspected an allowed Discord channel with redacted snippets."
        : "Appa posted a Discord diagnostics test message.",
      metadata: {
        action,
        guildId: normalizeString(payload.guildId),
        channelId: normalizeString(payload.channelId),
        requestedBy: normalizeString(payload.requestedBy),
        messageId: normalizeString(payload.messageId),
        messageExcerpt: redactExcerpt(payload.messageExcerpt, 220),
        snippetCount: snippets.length,
        snippets
      }
    }, logger);
    return {ok: true, action, snippetCount: snippets.length};
  };

  return {
    handlePortalAdminMention,
    reviewNoonaPublicReply,
    recordNoonaReviewDelivery,
    recordDiscordDiagnostic
  };
};

export default createAppaChatService;
