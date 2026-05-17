import {sendInteractionReply, truncate} from "../utils.mjs";

const SUBCOMMAND_TYPE = 1;
const CHANNEL_OPTION_TYPE = 7;
const INTEGER_OPTION_TYPE = 4;
const STRING_OPTION_TYPE = 3;

const MAX_INSPECT_LIMIT = 10;
const DEFAULT_INSPECT_LIMIT = 5;

const subcommand = (name, description, options = []) => ({
  type: SUBCOMMAND_TYPE,
  name,
  description,
  options
});

const channelOption = (name, description, required = false) => ({
  type: CHANNEL_OPTION_TYPE,
  name,
  description,
  required
});

const integerOption = (name, description, required = false, minValue = undefined, maxValue = undefined) => ({
  type: INTEGER_OPTION_TYPE,
  name,
  description,
  required,
  ...(minValue == null ? {} : {min_value: minValue}),
  ...(maxValue == null ? {} : {max_value: maxValue})
});

const stringOption = (name, description, required = false, maxLength = undefined) => ({
  type: STRING_OPTION_TYPE,
  name,
  description,
  required,
  ...(maxLength == null ? {} : {max_length: maxLength})
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const parseChannelId = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  const mention = normalized.match(/^<#(\d+)>$/);
  return mention ? mention[1] : normalized;
};

export const sanitizeDiscordDiagnosticText = (value, limit = 180) => normalizeString(value)
  .replace(/\b(token|secret|password|passwd|api[_ -]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
  .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
  .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_ -]{12,}\b/gi, "[redacted-token]")
  .replace(/https?:\/\/\S+/gi, "[redacted-url]")
  .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, "[redacted-mention]")
  .replace(/@(everyone|here)\b/gi, "@[redacted]")
  .replace(/\s+/g, " ")
  .slice(0, limit)
  .trim();

const diagnosticsChannelPolicy = (settings = {}) => {
  const noonaIds = normalizeArray(settings?.noonaChat?.allowedChannelIds)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
  const appaIds = normalizeArray(settings?.appa?.adminMentionChannelIds)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
  return {
    allowAny: (settings?.noonaChat?.enabled && noonaIds.length === 0)
      || (settings?.appa?.enabled && appaIds.length === 0),
    allowedIds: new Set([...noonaIds, ...appaIds])
  };
};

const resolveOptionChannel = (interaction, name) => {
  const optionChannel = interaction.options?.getChannel?.(name);
  if (optionChannel?.id) {
    return optionChannel;
  }
  const optionString = interaction.options?.getString?.(name);
  if (optionString) {
    return {id: parseChannelId(optionString)};
  }
  return null;
};

const fetchChannel = async (interaction, channelId, preferredChannel = null) => {
  if (preferredChannel?.id === channelId && (preferredChannel.messages || preferredChannel.send)) {
    return preferredChannel;
  }
  if (interaction.channel?.id === channelId && (interaction.channel.messages || interaction.channel.send)) {
    return interaction.channel;
  }
  if (typeof interaction.client?.channels?.fetch === "function") {
    return interaction.client.channels.fetch(channelId);
  }
  if (typeof interaction.guild?.channels?.fetch === "function") {
    return interaction.guild.channels.fetch(channelId);
  }
  throw new Error("Could not fetch that Discord channel.");
};

const toMessageArray = (messages) => {
  if (!messages) {
    return [];
  }
  if (Array.isArray(messages)) {
    return messages;
  }
  if (typeof messages.values === "function") {
    return Array.from(messages.values());
  }
  return [];
};

const formatMessageSnippet = (message = {}) => {
  const author = normalizeString(
    message.author?.globalName
    || message.author?.displayName
    || message.author?.username
    || message.member?.displayName,
    "unknown"
  );
  const createdAt = message.createdAt instanceof Date
    ? message.createdAt.toISOString()
    : normalizeString(message.createdTimestamp ? new Date(message.createdTimestamp).toISOString() : "");
  const content = sanitizeDiscordDiagnosticText(message.content, 180) || "[no text content]";
  return {
    messageId: normalizeString(message.id),
    author: sanitizeDiscordDiagnosticText(author, 48),
    createdAt,
    snippet: content,
    attachmentCount: Number(message.attachments?.size || normalizeArray(message.attachments).length || 0)
  };
};

const renderInspectReply = ({channelId, snippets}) => {
  const lines = snippets.map((entry, index) => [
    `${index + 1}. ${entry.author}${entry.createdAt ? ` at ${entry.createdAt}` : ""}`,
    `   ${entry.snippet}${entry.attachmentCount ? ` (${entry.attachmentCount} attachment${entry.attachmentCount === 1 ? "" : "s"})` : ""}`
  ].join("\n"));
  return truncate([
    `Appa inspected <#${channelId}>. Showing ${snippets.length} sanitized recent snippet${snippets.length === 1 ? "" : "s"}.`,
    ...lines
  ].join("\n"), 1800);
};

const resolveTarget = async (interaction) => {
  const optionChannel = resolveOptionChannel(interaction, "channel");
  const channelId = normalizeString(optionChannel?.id || interaction.channelId || interaction.channel?.id);
  if (!channelId) {
    throw new Error("Choose a configured channel for this diagnostic.");
  }
  return {
    channelId,
    channel: await fetchChannel(interaction, channelId, optionChannel)
  };
};

const ensureAllowedChannel = (settings, channelId) => {
  const policy = diagnosticsChannelPolicy(settings);
  if (!policy.allowAny && !policy.allowedIds.has(channelId)) {
    throw new Error("Appa diagnostics can only target configured Noona chat or Appa admin channels.");
  }
};

export const createDiscordDiagnosticsCommand = ({
  sage,
  getSettings
}) => ({
  definition: {
    name: "discord",
    description: "Run Appa-owned Discord diagnostics.",
    options: [
      subcommand("inspect", "Inspect recent sanitized snippets in an allowed channel.", [
        channelOption("channel", "Configured Noona/Appa channel to inspect.", false),
        integerOption("limit", "Number of recent messages to inspect.", false, 1, MAX_INSPECT_LIMIT)
      ]),
      subcommand("testpost", "Send a sanitized Appa diagnostic test post to an allowed channel.", [
        channelOption("channel", "Configured Noona/Appa channel to post into.", true),
        stringOption("message", "Optional sanitized diagnostic note.", false, 500)
      ])
    ]
  },
  access: {
    roleManaged: true
  },
  async execute(interaction) {
    const subcommandName = interaction.options?.getSubcommand?.(false) || "inspect";
    await interaction.deferReply?.({flags: 64});

    try {
      const settings = typeof getSettings === "function" ? getSettings() || {} : {};
      const {channelId, channel} = await resolveTarget(interaction);
      ensureAllowedChannel(settings, channelId);

      if (subcommandName === "testpost") {
        const note = sanitizeDiscordDiagnosticText(interaction.options?.getString?.("message"), 360);
        const content = [
          "Appa diagnostic test post.",
          note ? `Note: ${note}` : null
        ].filter(Boolean).join("\n");
        const posted = await channel.send({
          content,
          allowedMentions: {parse: []}
        });
        await sage.recordAppaDiscordDiagnostic?.({
          action: "testpost",
          guildId: normalizeString(interaction.guildId),
          channelId,
          requestedBy: normalizeString(interaction.user?.id),
          messageId: normalizeString(posted?.id),
          messageExcerpt: note
        });
        await sendInteractionReply(interaction, {
          content: `Appa posted a diagnostic message in <#${channelId}>.`,
          ephemeral: true
        });
        return;
      }

      const limit = Math.min(
        MAX_INSPECT_LIMIT,
        Math.max(1, Number(interaction.options?.getInteger?.("limit") || DEFAULT_INSPECT_LIMIT) || DEFAULT_INSPECT_LIMIT)
      );
      const fetched = await channel.messages?.fetch?.({limit});
      const snippets = toMessageArray(fetched).slice(0, limit).map(formatMessageSnippet);
      await sage.recordAppaDiscordDiagnostic?.({
        action: "inspect",
        guildId: normalizeString(interaction.guildId),
        channelId,
        requestedBy: normalizeString(interaction.user?.id),
        snippets
      });
      await sendInteractionReply(interaction, {
        content: renderInspectReply({channelId, snippets}),
        ephemeral: true
      });
    } catch (error) {
      await sendInteractionReply(interaction, {
        content: error instanceof Error ? error.message : String(error),
        ephemeral: true
      });
    }
  }
});

export default createDiscordDiagnosticsCommand;
