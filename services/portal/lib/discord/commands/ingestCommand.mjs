import {EPHEMERAL_FLAG, INGEST_CONFIRM_TTL_MS} from "../constants.mjs";
import {createSessionStore} from "../sessionStore.mjs";
import {normalizeString, resolveDiscordId, sendInteractionReply, truncate} from "../utils.mjs";
import {createBrandNameGetter} from "../branding.mjs";

const STRING_OPTION_TYPE = 3;
const CONFIRM_PREFIX = "portal:ingest-confirm:";

const TYPE_CHOICES = Object.freeze([
  {name: "Manga", value: "manga"},
  {name: "Manhwa", value: "manhwa"},
  {name: "Manhua", value: "manhua"},
  {name: "Webtoon", value: "webtoon"},
  {name: "Comic", value: "comic"},
  {name: "OEL", value: "oel"}
]);

const TYPE_LABELS = new Map(TYPE_CHOICES.map((choice) => [choice.value, choice.name]));
const ALLOWED_TYPES = new Set(TYPE_CHOICES.map((choice) => choice.value));

const option = (name, description, required = false, choices = undefined) => ({
  type: STRING_OPTION_TYPE,
  name,
  description,
  required,
  ...(Array.isArray(choices) ? {choices} : {})
});

const buildButtonRow = (buttons = []) => ({
  type: 1,
  components: buttons
});

const buildButton = ({customId, label, style = 2, disabled = false}) => ({
  type: 2,
  custom_id: customId,
  label,
  style,
  disabled
});

const normalizeObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeType = (value) => normalizeString(value).toLowerCase();

const typeLabel = (type) => TYPE_LABELS.get(normalizeType(type)) || normalizeString(type, "Manga");

const coerceNumber = (...values) => {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const maybeCount = (label, value) => value == null ? null : `${label}: ${value}`;

const previewTitleCount = (payload = {}) => {
  const summary = normalizeObject(payload.summary);
  return coerceNumber(payload.titleCount, payload.totalTitles, summary.totalTitles, summary.total);
};

const extractPreviewReference = (payload = {}) => ({
  previewId: normalizeString(payload.previewId || payload.planId || payload.id),
  previewToken: normalizeString(payload.previewToken || payload.confirmationToken || payload.token)
});

const buildIngestRequest = (interaction, type) => ({
  type,
  requestedBy: resolveDiscordId(interaction),
  guildId: normalizeString(interaction?.guildId),
  channelId: normalizeString(interaction?.channelId),
  source: "discord-appa-slash"
});

const formatPreviewMessage = ({brandName, type, payload, customId}) => {
  const summary = normalizeObject(payload.summary);
  const hardware = normalizeObject(payload.hardware || summary.hardware);
  const activeRun = normalizeObject(payload.activeRun);
  const titleCount = previewTitleCount(payload);
  const queued = coerceNumber(
    payload.queuedCount,
    payload.queueCount,
    payload.runnableCount,
    summary.queued,
    summary.runnable,
    summary.pending,
    summary.pendingTitles
  );
  const pending = coerceNumber(payload.pendingCount, payload.pendingTitles, summary.pending, summary.pendingTitles);
  const failed = coerceNumber(payload.failedCount, payload.failedTitles, summary.failed, summary.failedTitles);
  const ready = coerceNumber(payload.readyCount, payload.readyTitles, summary.ready, summary.readyTitles);
  const warnings = normalizeArray(payload.warnings || summary.warnings)
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .slice(0, 3);
  const details = [
    maybeCount("Titles", titleCount),
    hardware.state || hardware.status ? `Hardware: ${truncate(normalizeString(hardware.state || hardware.status), 80)}` : null,
    maybeCount("Ready now", ready),
    maybeCount("Pending", pending),
    maybeCount("Queued by run", queued),
    maybeCount("Failed/retryable", failed)
  ].filter(Boolean);
  const message = normalizeString(payload.message);

  return {
    content: [
      `${brandName} ingest preview for **${typeLabel(type)}**.`,
      message ? truncate(message, 280) : "",
      details.length ? details.join(" | ") : "Sage prepared an ingest run preview.",
      activeRun?.runId || activeRun?.jobId ? `Active run: ${truncate(normalizeString(activeRun.runId || activeRun.jobId), 90)}` : "",
      warnings.length ? `Warnings: ${warnings.map((entry) => truncate(entry, 90)).join(" | ")}` : "",
      titleCount === 0
        ? "No eligible titles are ready for this ingest type."
        : "Confirm within 5 minutes to start the Sage-run ingest job."
    ].filter(Boolean).join("\n"),
    ephemeral: true,
    components: titleCount === 0 ? [] : [
      buildButtonRow([
        buildButton({
          customId,
          label: "Run ingest",
          style: 1
        })
      ])
    ]
  };
};

const formatRunMessage = ({brandName, type, response}) => {
  const payload = normalizeObject(response?.payload || response);
  const runId = normalizeString(payload.runId || payload.jobId || payload.taskId || payload.id);
  const status = normalizeString(payload.status, response?.ok ? "started" : "failed");
  const queued = coerceNumber(payload.queuedCount, payload.queueCount, payload.startedCount, payload.titleCount);
  const message = normalizeString(payload.message || payload.detail);
  return [
    `${brandName} ingest ${status} for **${typeLabel(type)}**.`,
    runId ? `Run ID: ${runId}` : "",
    queued == null ? "" : `Queued: ${queued}`,
    message ? truncate(message, 360) : "",
    "Appa will DM you progress at 25%, 50%, 75%, and when it finishes."
  ].filter(Boolean).join("\n");
};

export const createIngestCommand = ({sage, getBrandName}) => {
  const confirmStore = createSessionStore({ttlMs: INGEST_CONFIRM_TTL_MS});
  const brandName = createBrandNameGetter(getBrandName);

  return {
    definition: {
      name: "ingest",
      description: "Preview and run reader ingest for one library type.",
      dm_permission: false,
      options: [
        option("type", "Library type to ingest.", true, TYPE_CHOICES)
      ]
    },
    async execute(interaction) {
      await interaction.deferReply?.({flags: EPHEMERAL_FLAG});
      const type = normalizeType(interaction.options?.getString?.("type"));
      if (!ALLOWED_TYPES.has(type)) {
        await sendInteractionReply(interaction, {
          content: "Choose one of: manga, manhwa, manhua, webtoon, comic, or oel.",
          ephemeral: true,
          components: []
        });
        return;
      }

      const request = buildIngestRequest(interaction, type);
      try {
        const response = await sage.previewIngestRun(request);
        if (!response?.ok) {
          await sendInteractionReply(interaction, {
            content: response?.payload?.error || response?.payload?.message || "Sage could not prepare an ingest preview.",
            ephemeral: true,
            components: []
          });
          return;
        }

        const preview = normalizeObject(response.payload);
        const titleCount = previewTitleCount(preview);
        const {previewId, previewToken} = extractPreviewReference(preview);
        const sessionId = titleCount === 0
          ? ""
          : confirmStore.create({
            discordUserId: resolveDiscordId(interaction),
            request,
            previewId,
            previewToken
          });
        await sendInteractionReply(interaction, formatPreviewMessage({
          brandName: brandName(),
          type,
          payload: preview,
          customId: `${CONFIRM_PREFIX}${sessionId}`
        }));
      } catch (error) {
        await sendInteractionReply(interaction, {
          content: `${brandName()} ingest preview failed: ${error?.message || String(error)}`,
          ephemeral: true,
          components: []
        });
      }
    },
    async handleComponent(interaction) {
      const customId = normalizeString(interaction?.customId);
      if (!customId.startsWith(CONFIRM_PREFIX)) {
        return false;
      }
      await interaction.deferReply?.({flags: EPHEMERAL_FLAG});

      const sessionId = customId.slice(CONFIRM_PREFIX.length);
      const session = confirmStore.read(sessionId);
      if (!session) {
        await sendInteractionReply(interaction, {
          content: "That ingest confirmation expired. Run `/ingest` again for a fresh preview.",
          ephemeral: true,
          components: []
        });
        return true;
      }

      const userId = resolveDiscordId(interaction);
      if (userId !== session.discordUserId) {
        await sendInteractionReply(interaction, {
          content: "Only the user who opened this ingest preview can confirm it.",
          ephemeral: true,
          components: []
        });
        return true;
      }

      confirmStore.delete(sessionId);
      try {
        const response = await sage.runIngest({
          ...session.request,
          confirmedBy: userId,
          confirmedAt: new Date().toISOString(),
          ...(session.previewId ? {previewId: session.previewId} : {}),
          ...(session.previewToken ? {previewToken: session.previewToken} : {})
        });
        if (!response?.ok) {
          await sendInteractionReply(interaction, {
            content: response?.payload?.error || response?.payload?.message || "Sage could not start the ingest run.",
            ephemeral: true,
            components: []
          });
          return true;
        }

        await sendInteractionReply(interaction, {
          content: formatRunMessage({
            brandName: brandName(),
            type: session.request.type,
            response
          }),
          ephemeral: true,
          components: []
        });
      } catch (error) {
        await sendInteractionReply(interaction, {
          content: `${brandName()} ingest run failed: ${error?.message || String(error)}`,
          ephemeral: true,
          components: []
        });
      }
      return true;
    }
  };
};

export default createIngestCommand;
