import {sendInteractionReply} from "../utils.mjs";
import {renderLeaderboard} from "../triviaRuntime.mjs";

const SUBCOMMAND_TYPE = 1;
const STRING_OPTION_TYPE = 3;

const subcommand = (name, description, options = []) => ({
  type: SUBCOMMAND_TYPE,
  name,
  description,
  options
});

const stringOption = (name, description, required = false, choices = undefined) => ({
  type: STRING_OPTION_TYPE,
  name,
  description,
  required,
  ...(Array.isArray(choices) ? {choices} : {})
});

const WINDOW_CHOICES = Object.freeze([
  {name: "All time", value: "all"},
  {name: "Daily", value: "daily"},
  {name: "Weekly", value: "weekly"},
  {name: "Monthly", value: "monthly"}
]);

export const createTriviaCommand = ({
  sage,
  onTriviaStart,
  onTriviaStop,
  onTriviaLeaderboard
}) => ({
  definition: {
    name: "trivia",
    description: "Manage Noona title-summary trivia.",
    options: [
      subcommand("status", "Show the active trivia round and settings."),
      subcommand("leaderboard", "Show the trivia leaderboard.", [
        stringOption("window", "Leaderboard window.", false, WINDOW_CHOICES)
      ]),
      subcommand("start", "Start a trivia round now."),
      subcommand("stop", "Stop the current trivia round.")
    ]
  },
  access: {
    roleManaged: true
  },
  async execute(interaction) {
    const subcommandName = interaction.options?.getSubcommand?.(false) || "status";
    await interaction.deferReply?.({flags: 64});

    if (subcommandName === "leaderboard") {
      const windowName = interaction.options?.getString?.("window") || "all";
      const result = onTriviaLeaderboard
        ? await onTriviaLeaderboard(windowName)
        : await sage.getTriviaLeaderboard(windowName, 10);
      const payload = result?.leaderboard || result?.payload || result;
      await sendInteractionReply(interaction, {
        content: renderLeaderboard(payload),
        ephemeral: true
      });
      return;
    }

    if (subcommandName === "start") {
      try {
        const result = await onTriviaStart?.({
          requestedBy: interaction.user?.id || "discord-command",
          force: true
        });
        await sendInteractionReply(interaction, {
          content: `Trivia started: ${result?.round?.id || "new round"}.`,
          ephemeral: true
        });
      } catch (error) {
        await sendInteractionReply(interaction, {
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true
        });
      }
      return;
    }

    if (subcommandName === "stop") {
      try {
        const result = await onTriviaStop?.({
          requestedBy: interaction.user?.id || "discord-command"
        });
        await sendInteractionReply(interaction, {
          content: `Trivia stopped. Answer: ${result?.round?.title || "unknown"}.`,
          ephemeral: true
        });
      } catch (error) {
        await sendInteractionReply(interaction, {
          content: error instanceof Error ? error.message : String(error),
          ephemeral: true
        });
      }
      return;
    }

    const response = await sage.getTriviaState();
    const activeRound = response.payload?.activeRound;
    await sendInteractionReply(interaction, {
      content: activeRound?.id
        ? `Trivia is active in <#${response.payload?.settings?.channelId}>. Round: ${activeRound.id}.`
        : "Trivia has no active round right now.",
      ephemeral: true
    });
  }
});

export default createTriviaCommand;
