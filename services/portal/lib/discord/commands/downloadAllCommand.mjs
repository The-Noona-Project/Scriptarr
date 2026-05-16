import {
  executeDownloadAll,
  executeDownloadAllRunAction,
  formatBulkQueueSummary,
  formatBulkRunSummary,
  formatDownloadAllUsage
} from "../downloadAllShared.mjs";
import {sendInteractionReply} from "../utils.mjs";
import {createBrandNameGetter} from "../branding.mjs";

const SUBCOMMAND_TYPE = 1;
const STRING_OPTION_TYPE = 3;
const INTEGER_OPTION_TYPE = 4;
const BOOLEAN_OPTION_TYPE = 5;

const TYPE_CHOICES = Object.freeze([
  {name: "All", value: "all"},
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

const integerOption = (name, description, required = false, minValue = undefined, maxValue = undefined) => ({
  type: INTEGER_OPTION_TYPE,
  name,
  description,
  required,
  ...(minValue == null ? {} : {min_value: minValue}),
  ...(maxValue == null ? {} : {max_value: maxValue})
});

const subcommand = (name, description, options = []) => ({
  type: SUBCOMMAND_TYPE,
  name,
  description,
  options
});

export const createDownloadAllCommand = ({
  sage,
  getBrandName,
  getSettings,
  logger,
  onRuntimeEvent
}) => {
  const brandName = createBrandNameGetter(getBrandName);
  return {
  definition: {
    name: "downloadall",
    description: "Owner-only DM downloadall runs for WeebCentral titles.",
    dm_permission: true,
    options: [
      subcommand("run", "Start a durable WeebCentral downloadall run.", [
        stringOption("type", "Library type to browse.", true, TYPE_CHOICES),
        booleanOption("nsfw", "Whether adult titles are allowed.", true),
        stringOption("titlegroup", "Enter a single letter a-z, or all.", true),
        integerOption("groupsize", "Batch groups to run before pausing for approval.", false, 1, 25)
      ]),
      subcommand("continue", "Continue the next batch for a paused mega downloadall run.", [
        stringOption("runid", "Run id returned by /downloadall run.", true)
      ]),
      subcommand("resume", "Alias for continue on a paused mega downloadall run.", [
        stringOption("runid", "Run id returned by /downloadall run.", true)
      ]),
      subcommand("status", "Inspect a mega downloadall run.", [
        stringOption("runid", "Run id returned by /downloadall run.", true)
      ]),
      subcommand("cancel", "Cancel a mega downloadall run.", [
        stringOption("runid", "Run id returned by /downloadall run.", true)
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
    if (["continue", "resume", "status", "cancel"].includes(subcommandName)) {
      try {
        const result = await executeDownloadAllRunAction({
          getSettings,
          sage,
          requestedBy,
          runId: interaction.options?.getString?.("runid"),
          action: subcommandName
        });
        const failure = result?.ok === false
          ? result.payload?.error || result.payload?.message || `The service returned ${result.status || "an error"}.`
          : "";
        if (failure) {
          throw new Error(failure);
        }
        await sendInteractionReply(interaction, {
          content: formatBulkRunSummary(result.payload || result),
          ephemeral: true
        });
      } catch (error) {
        await sendInteractionReply(interaction, {
          content: `${brandName()} downloadall ${subcommandName} failed: ${error?.message || String(error)}`,
          ephemeral: true
        });
      }
      return;
    }

    const filters = {
      type: interaction.options?.getString?.("type"),
      nsfw: interaction.options?.getBoolean?.("nsfw"),
      titlePrefix: interaction.options?.getString?.("titlegroup"),
      batchesPerApproval: interaction.options?.getInteger?.("groupsize") || 1
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
        content: result?.payload?.runId || result?.runId
          ? formatBulkRunSummary(result.payload || result)
          : formatBulkQueueSummary(result.payload || result),
        ephemeral: true
      });
    } catch (error) {
      await sendInteractionReply(interaction, {
        content: `${brandName()} downloadall run failed: ${error?.message || String(error)}`,
        ephemeral: true
      });
    }
  }
  };
};

export default createDownloadAllCommand;
