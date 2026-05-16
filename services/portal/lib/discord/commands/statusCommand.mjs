import {sendInteractionReply, truncate} from "../utils.mjs";
import {createBrandNameGetter} from "../branding.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

export const createStatusCommand = ({sage, getBrandName}) => {
  const brandName = createBrandNameGetter(getBrandName);
  return {
  definition: {
    name: "status",
    description: "Read a Scriptarr status summary."
  },
  async execute(interaction) {
    const siteName = brandName();
    await interaction.deferReply?.({flags: 64});
    const response = await sage.getStatusSummary();
    if (!response.ok) {
      await sendInteractionReply(interaction, {
        content: response.payload?.error || `${siteName} status is unavailable right now.`,
        ephemeral: true
      });
      return;
    }

    const payload = response.payload || {};
    const serviceLines = Object.entries(payload.services || {}).map(([name, service]) => {
      const normalized = service && typeof service === "object" ? service : {};
      const status = normalizeString(
        normalized.service
        || normalized.status
        || (normalized.ok === true ? "ok" : ""),
        "unknown"
      );
      return `- ${name}: ${status}`;
    });
    const lines = [
      `${siteName} status summary:`,
      ...serviceLines,
      `Pending requests: ${Number(payload.requests?.pending || 0)}`,
      `Unavailable requests: ${Number(payload.requests?.unavailable || 0)}`,
      `Queued downloads: ${Number(payload.tasks?.queued || 0)}`,
      `Running downloads: ${Number(payload.tasks?.running || 0)}`,
      `Followers: ${Number(payload.followers || 0)}`
    ];

    await sendInteractionReply(interaction, {
      content: truncate(lines.join("\n"), 1800),
      ephemeral: true
    });
  }
  };
};
