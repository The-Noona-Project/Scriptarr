/**
 * @file Sage-owned public Noona chat orchestration for Portal mentions.
 */

import {proposeAiAction} from "./aiTools.mjs";
import {
  GITHUB_UPDATE_DIGEST_SETTING_KEY,
  normalizeGithubUpdateDigestState
} from "./githubUpdateDigest.mjs";
import {
  applyNoonaMemoryCommand,
  buildNoonaMemoryContext,
  readNoonaChatMemory,
  writeNoonaChatMemory
} from "./noonaChatMemory.mjs";
import {
  buildNoonaVisualIdentityContext,
  buildNoonaVisualIdentityReply,
  isVisualIdentityPrompt
} from "./noonaVisualIdentity.mjs";

export const NOONA_CHAT_READ_TOOL_IDS = Object.freeze([
  "stack_status",
  "service_health",
  "discord_runtime",
  "trivia_status",
  "library_search"
]);

export const NOONA_CHAT_PROPOSAL_TOOL_IDS = Object.freeze([
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
const DISCORD_AI_CHAT_TIMEOUT_MS = 85000;
const NOONA_DISCORD_PERSONA_STYLE = [
  "Noona is Scriptarr's public Discord big-sister persona: warm, playful, attentive, specific, and a little cheeky without sounding like a support ticket.",
  "Reply like a present person in the channel. Use one short paragraph, or 2-3 tight bullets when that is clearer.",
  "When context names a real update, title, request, or status, mention the concrete thing that matters instead of sounding like a raw changelog.",
  "Do not start with stray punctuation, echo the bot mention, tag Noona, include character counts, raw commit rows, SHAs, authors, timestamps, or code fences.",
  "Avoid stiff customer-service closers like 'let me know if you have any questions' or 'ask me anything'. Invite follow-up only when it sounds natural.",
  "Use LONG LIVE NOONA sparingly as a celebration, not as every sign-off. For status or admin topics, stay clear and professional."
].join(" ");

const isActionPrompt = (message) => /\b(start|stop|cancel|end|run|check|probe)\b/i.test(normalizeString(message));

const isStatusPrompt = (message) => /\b(status|health|healthy|alive|online|offline|available|responding|connected|reachable|there|up|down|broken|working|callback|boot)\b/i.test(normalizeString(message));
const isTriviaPrompt = (message) => /\btrivia\b/i.test(normalizeString(message));
const isLibraryPrompt = (message) => /\b(library|search|find|have|manga|comic|manhwa|webtoon)\b/i.test(normalizeString(message));
const isUpdatePrompt = (message) => /\b(update|updates|updated|changelog|change\s*log|release\s+notes?|what\s+changed|new\s+commit|github|how\s+(do|can)\s+i\s+use)\b/i.test(normalizeString(message));
const shouldUseDeterministicStatusReply = (message) => isStatusPrompt(message)
  && !isActionPrompt(message)
  && !isTriviaPrompt(message)
  && !isLibraryPrompt(message)
  && !isUpdatePrompt(message)
  && !isVisualIdentityPrompt(message);

const buildServiceHealthContext = async ({config, serviceJson}) => {
  const services = [
    ["warden", config.wardenBaseUrl, "/health"],
    ["oracle", config.oracleBaseUrl, "/health"],
    ["raven", config.ravenBaseUrl, "/health"],
    ["portal", config.portalBaseUrl, "/health"]
  ].filter(([, baseUrl]) => normalizeString(baseUrl));
  const results = await Promise.all(services.map(async ([service, baseUrl, path]) => {
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
  return {
    checkedAt: new Date().toISOString(),
    freshness: "live probe from Sage",
    ...Object.fromEntries(results)
  };
};

const summarizePortalRuntime = (payload = {}) => {
  const discord = normalizeObject(payload.discord, null) || normalizeObject(payload.runtime, null) || {};
  const capabilities = normalizeObject(discord.capabilities, {}) || {};
  const appa = normalizeObject(discord.appa, {}) || {};
  return {
    checkedAt: new Date().toISOString(),
    mode: normalizeString(discord.mode),
    connectionState: normalizeString(discord.connectionState),
    connected: discord.connected === true,
    settingsLoaded: discord.settingsLoaded === true,
    noonaChat: {
      status: normalizeString(capabilities.noonaChat?.status),
      detail: normalizeString(capabilities.noonaChat?.detail).slice(0, 180)
    },
    appa: {
      enabled: appa.enabled === true || appa.settingsEnabled === true,
      connected: appa.connected === true,
      splitWanted: appa.splitWanted === true,
      degradedReason: normalizeString(appa.degradedReason),
      registeredGuildCount: Number.parseInt(String(appa.registeredGuildCount || 0), 10) || 0
    },
    lastNoonaMentionAt: normalizeString(discord.lastNoonaMentionAt),
    lastNoonaMentionError: normalizeString(discord.lastNoonaMentionError).slice(0, 160)
  };
};

const buildPortalRuntimeContext = async ({config, serviceJson}) => {
  if (!normalizeString(config.portalBaseUrl)) {
    return null;
  }
  try {
    const result = await serviceJson(config.portalBaseUrl, "/api/commands", {timeoutMs: 2500});
    return summarizePortalRuntime(result.payload || result);
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      connected: false,
      settingsLoaded: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const buildStatusReadContext = async ({config, serviceJson}) => {
  const [serviceHealth, discordRuntime] = await Promise.all([
    buildServiceHealthContext({config, serviceJson}).catch(() => null),
    buildPortalRuntimeContext({config, serviceJson}).catch(() => null)
  ]);
  const context = {};
  if (serviceHealth) {
    context.serviceHealth = serviceHealth;
  }
  if (discordRuntime) {
    context.discordRuntime = discordRuntime;
  }
  return Object.keys(context).length ? context : null;
};

const summarizeHealthCounts = (serviceHealth = {}) => {
  const entries = Object.entries(serviceHealth)
    .filter(([, value]) => value && typeof value === "object" && "ok" in value);
  const degraded = entries.filter(([, value]) => value.ok === false);
  return {
    total: entries.length,
    degraded: degraded.length,
    healthy: entries.length - degraded.length
  };
};

const noonaStatusReply = (readContext = {}) => {
  const counts = summarizeHealthCounts(readContext.serviceHealth || {});
  const appa = readContext.discordRuntime?.appa || {};
  const stackText = counts.total
    ? counts.degraded
      ? `I am online, but ${counts.degraded} part${counts.degraded === 1 ? "" : "s"} of the reading stack need attention.`
      : "I am online. The quick stack check answered cleanly."
    : "I am online. I could not get the full stack check in time, but this Discord path is responding.";
  const appaText = appa.connected
    ? "Appa is connected too."
    : appa.enabled || appa.splitWanted
      ? "Appa is configured, but I do not see him fully connected right now."
      : "";
  return [stackText, appaText].filter(Boolean).join(" ");
};

const buildLibraryContext = async ({vaultClient, message}) => {
  const query = normalizeString(message)
    .replace(/<@!?\d+>/g, "")
    .replace(/\b(do|we|you|noona|have|search|find|library|manga|comic|manhwa|webtoon|for|the|a|an|any)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!query || !vaultClient?.listRavenTitleCards) {
    return null;
  }
  const payload = await vaultClient.listRavenTitleCards({
    q: query,
    view: "card",
    pageSize: 5
  }).catch(() => null);
  return {
    query,
    results: normalizeArray(payload?.items || payload?.results || payload).slice(0, 5).map((title) => ({
      id: normalizeString(title.id || title.titleId),
      title: normalizeString(title.title || title.name),
      type: normalizeString(title.libraryTypeSlug || title.mediaType || title.type),
      latestChapter: normalizeString(title.latestChapter || title.latestReadableChapter)
    }))
  };
};

const buildLatestUpdateContext = async ({vaultClient}) => {
  const state = normalizeGithubUpdateDigestState((await vaultClient.getSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY).catch(() => null))?.value);
  const latest = normalizeObject(state.latestPosted, null);
  if (!latest?.summary) {
    return null;
  }
  return {
    repository: latest.repository || `${state.repository.owner}/${state.repository.repo}`,
    branch: normalizeString(latest.branch, normalizeString(state.repository.branch)),
    summary: normalizeString(latest.summary),
    compareUrl: normalizeString(latest.compareUrl),
    commitCount: Number.parseInt(String(latest.commitCount || 0), 10) || 0,
    latestSha: normalizeString(latest.latestSha, normalizeString(state.lastPostedSha).slice(0, 12)),
    postedAt: normalizeString(latest.postedAt, normalizeString(state.lastPostedAt)),
    commits: normalizeArray(latest.commits).slice(-8).map((commit) => ({
      sha: normalizeString(commit.sha),
      title: normalizeString(commit.title),
      author: normalizeString(commit.author),
      date: normalizeString(commit.date),
      url: normalizeString(commit.url)
    }))
  };
};

const buildReadContext = async ({config, serviceJson, vaultClient, triviaService, readPortalDiscordSettings, message}) => {
  const context = {};
  if (isStatusPrompt(message)) {
    context.serviceHealth = await buildServiceHealthContext({config, serviceJson});
  }
  if (isTriviaPrompt(message)) {
    context.trivia = await triviaService?.getState?.().catch(() => null);
  }
  if (isStatusPrompt(message) || /\bdiscord\b/i.test(normalizeString(message))) {
    context.discordRuntime = await buildPortalRuntimeContext({config, serviceJson});
  }
  if (/\bdiscord\b/i.test(normalizeString(message))) {
    const settings = await readPortalDiscordSettings?.().catch(() => null);
    context.discord = settings ? {
      guildId: normalizeString(settings.guildId),
      noonaChatEnabled: settings.noonaChat?.enabled === true,
      triviaEnabled: settings.trivia?.enabled === true
    } : null;
  }
  if (isLibraryPrompt(message)) {
    context.library = await buildLibraryContext({vaultClient, message});
  }
  if (isUpdatePrompt(message)) {
    const latestUpdate = await buildLatestUpdateContext({vaultClient});
    if (latestUpdate) {
      context.latestUpdate = latestUpdate;
    }
  }
  if (isVisualIdentityPrompt(message)) {
    context.visualIdentity = buildNoonaVisualIdentityContext();
  }
  return Object.keys(context).length ? context : null;
};

const proposalReply = (planned) => {
  if (planned?.ok === false) {
    if (planned.status === 403) {
      return "I cannot draft that from public chat. Bring that one to the admin AI page.";
    }
    return planned.error || "I could not draft that proposal from Discord.";
  }
  return planned?.proposal
    ? `I drafted a ${planned.tool?.label || "Scriptarr"} proposal for admin confirmation. Proposal id: ${planned.proposal.id}.`
    : "";
};

const fallbackReply = (message) => {
  if (/long\s+live\s+noona/i.test(normalizeString(message))) {
    return "LONG LIVE NOONA. Big sister heard you loud and clear.";
  }
  if (isVisualIdentityPrompt(message)) {
    return buildNoonaVisualIdentityReply(message);
  }
  return "Noona is here. My main brain is warming up, but I am listening.";
};

/**
 * Create the Sage-owned Noona chat service used by Portal mentions.
 *
 * @param {{
 *   config: Record<string, string>,
 *   vaultClient: {getSetting: Function, setSetting: Function, upsertDiscordUser?: Function},
 *   serviceJson: Function,
 *   triviaService?: Record<string, Function>,
 *   readPortalDiscordSettings?: Function
 * }} options
 * @returns {{handlePortalMention: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>}}
 */
export const createNoonaChatService = ({
  config,
  vaultClient,
  serviceJson,
  triviaService,
  readPortalDiscordSettings
}) => {
  const handlePortalMention = async (payload = {}) => {
    const message = normalizeString(payload.message);
    const user = normalizeObject(payload.user, {}) || {};
    const discordUserId = normalizeString(user.discordUserId || user.id);
    if (!message) {
      return {ok: false, status: 400, error: "message is required."};
    }
    if (!discordUserId) {
      return {ok: false, status: 400, error: "discord user id is required."};
    }

    let memoryContext = {userFacts: [], serverFacts: [], counts: {users: 0, userFacts: 0, serverFacts: 0}};
    if (shouldUseDeterministicStatusReply(message)) {
      const readContext = await buildStatusReadContext({config, serviceJson});
      return {
        ok: true,
        reply: noonaStatusReply(readContext || {}),
        memory: memoryContext,
        readContext,
        oracle: {
          disabled: false,
          degraded: false,
          skipped: true
        },
        deterministic: true
      };
    }

    await vaultClient.upsertDiscordUser?.({
      discordUserId,
      username: normalizeString(user.username || user.displayName || user.globalName, "Discord Reader"),
      avatarUrl: normalizeString(user.avatarUrl) || null,
      role: "member"
    }).catch(() => null);

    let memory = await readNoonaChatMemory(vaultClient);
    if (payload.memoryEnabled !== false) {
      const memoryResult = applyNoonaMemoryCommand(memory, {message, user: {...user, discordUserId}});
      memory = memoryResult.memory;
      if (memoryResult.changed) {
        await writeNoonaChatMemory(vaultClient, memory);
      }
      if (memoryResult.handled) {
        return {
          ok: true,
          reply: memoryResult.reply,
          memory: buildNoonaMemoryContext(memory, discordUserId),
          action: memoryResult.action
        };
      }
      memoryContext = buildNoonaMemoryContext(memory, discordUserId);
    }

    if (normalizeString(payload.proposalMode, "conservative") === "conservative" && isActionPrompt(message)) {
      const planned = await proposeAiAction({
        vaultClient,
        prompt: message,
        user: {
          discordUserId,
          username: normalizeString(user.username || user.displayName || user.globalName, "Discord Reader")
        },
        allowedToolIds: NOONA_CHAT_PROPOSAL_TOOL_IDS
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

    const readContext = await buildReadContext({
      config,
      serviceJson,
      vaultClient,
      triviaService,
      readPortalDiscordSettings,
      message
    });
    const oracle = await serviceJson(config.oracleBaseUrl, "/api/chat", {
      method: "POST",
      body: {
        message,
        context: {
          source: "discord-mention",
          personaStyle: NOONA_DISCORD_PERSONA_STYLE,
          visualIdentity: buildNoonaVisualIdentityContext(),
          user: {
            discordUserId,
            username: normalizeString(user.username || user.displayName || user.globalName, "Reader"),
            displayName: normalizeString(user.displayName || user.globalName || user.username)
          },
          memory: memoryContext,
          readContext
        }
      },
      timeoutMs: DISCORD_AI_CHAT_TIMEOUT_MS
    }).catch((error) => ({
      ok: false,
      status: 503,
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    }));
    const oraclePayload = oracle.payload || {};
    const oracleDegraded = oracle.ok === false || oraclePayload.disabled === true || oraclePayload.degraded === true;
    const reply = isVisualIdentityPrompt(message) && oracleDegraded
      ? buildNoonaVisualIdentityReply(message)
      : normalizeString(oraclePayload.reply, fallbackReply(message));
    return {
      ok: true,
      reply,
      memory: memoryContext,
      readContext,
      oracle: {
        disabled: oraclePayload.disabled === true,
        degraded: oracleDegraded
      },
      error: normalizeString(oraclePayload.error)
    };
  };

  return {handlePortalMention};
};

export default createNoonaChatService;
