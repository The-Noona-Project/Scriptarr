import {
  executeDownloadAll,
  formatBulkQueueSummary,
  formatDownloadAllUsage
} from "../downloadAllShared.mjs";
import {sendInteractionReply} from "../utils.mjs";

const SUBCOMMAND_TYPE = 1;
const STRING_OPTION_TYPE = 3;
const BOOLEAN_OPTION_TYPE = 5;

const TYPE_CHOICES = Object.freeze([
  {name: "Manga", value: "Manga"},
  {name: "Manhwa", value: "Manhwa"},
  {name: "Manhua", value: "Manhua"},
  {name: "OEL", value: "OEL"}
]);

const stringOption = (name, description, required = false, choices = undefined) => ({
  type: STRING_OPTION_TYPE,
  name,
  description,
  required,
  ...(Array.isArray(choices) ? {choices} : {})
});

const booleanOption = (name, description, required = false) => ({
  type: BOOLEAN_OPTION_TYPE,
  name,
  description,
  required
});

const subcommand = (name, description, options = []) => ({
  type: SUBCOMMAND_TYPE,
  name,
  description,
  options
});

export const createDownloadAllCommand = ({
  sage,
  getSettings,
  logger,
  onRuntimeEvent
}) => ({
  definition: {
    name: "downloadall",
    description: "Owner-only DM bulk queue for WeebCentral titles.",
    dm_permission: true,
    options: [
      subcommand("run", "Queue a WeebCentral bulk download for one title prefix.", [
        stringOption("type", "Library type to browse.", true, TYPE_CHOICES),
        booleanOption("nsfw", "Whether adult titles are allowed.", true),
        stringOption("titlegroup", "Title prefix letter or group, like a.", true)
      ]),
      subcommand("help", "Show downloadall usage.")
    ]
  },
  access: {
    dmOnly: true,
    ownerOnly: true
  },
  registrationScope: "global",
  async execute(interaction) {
    const subcommandName = interaction.options?.getSubcommand?.(false) || "help";
    const requestedBy = interaction.user?.id || "";

    if (subcommandName === "help") {
      onRuntimeEvent?.({
        type: "downloadall-handled",
        source: "dm-slash-help",
        requestedBy,
        status: "help"
      });
      await sendInteractionReply(interaction, {
        content: formatDownloadAllUsage(),
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply?.({flags: 64});
    const filters = {
      type: interaction.options?.getString?.("type"),
      nsfw: interaction.options?.getBoolean?.("nsfw"),
      titlePrefix: interaction.options?.getString?.("titlegroup")
    };

    try {
      const result = await executeDownloadAll({
        getSettings,
        sage,
        logger,
        onRuntimeEvent,
        requestedBy,
        filters,
        source: "dm-slash"
      });
      await sendInteractionReply(interaction, {
        content: formatBulkQueueSummary(result.payload || result),
        ephemeral: true
      });
    } catch (error) {
      await sendInteractionReply(interaction, {
        content: `Scriptarr bulk queue failed: ${error?.message || String(error)}`,
        ephemeral: true
      });
    }
  }
});

export default createDownloadAllCommand;
