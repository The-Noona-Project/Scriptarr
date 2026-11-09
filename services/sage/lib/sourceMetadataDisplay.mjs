/** @file Safe metadata facts and provenance for title details and admin repair. */
const text = (value, max = 512) => typeof value === "string" ? value.trim().slice(0, max) : "";
const list = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string").map((entry) => text(entry)).filter(Boolean).slice(0, 200) : [];
const url = (value) => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ""; }
  catch { return ""; }
};

const lifecycle = (value) => {
  const normalized = text(value).toLowerCase();
  return ({canceled: "cancelled", finished: "completed", complete: "completed", publishing: "ongoing", releasing: "ongoing"})[normalized] || normalized;
};

/**
 * Project only public metadata facts; raw provider responses never reach the browser.
 * @param {Record<string, any> | null} match Durable metadata match.
 * @returns {Record<string, any>} Metadata and source display facts.
 */
export const sourceMetadataDisplay = (match) => {
  const details = match?.details || {};
  const binding = details.sourceBinding || {};
  const source = binding.source || {};
  const groups = new Map();
  if (text(details.demographic)) groups.set("demographic", [text(details.demographic)]);
  for (const row of Array.isArray(details.tagGroups) ? details.tagGroups.slice(0, 200) : []) {
    const group = text(row.group) || "other";
    const tag = text(row.tag);
    if (tag) groups.set(group, [...(groups.get(group) || []), tag]);
  }
  const grouped = new Set([...groups.values()].flat().map((tag) => tag.normalize("NFKC").toLowerCase()));
  for (const tag of list(details.tags)) {
    const key = tag.normalize("NFKC").toLowerCase();
    if (!grouped.has(key)) {
      const group = ["seinen", "josei", "shoujo", "shonen", "shounen", "shōnen", "shōjo"].includes(key) ? "demographic" : "other";
      groups.set(group, [...(groups.get(group) || []), tag]); grouped.add(key);
    }
  }
  const conflicts = [];
  if (text(source.status) && text(details.status) && lifecycle(source.status) !== lifecycle(details.status)) conflicts.push("Publication status differs between source and metadata provider.");
  return {
    decision: ["verified-provider", "source-backed"].includes(binding.decision) ? binding.decision : "unverified",
    provider: {id: text(match?.provider), seriesId: text(match?.providerSeriesId), title: text(details.title), url: url(details.url), year: text(details.releaseLabel), status: text(details.status), author: text(details.author), artists: list(details.artists), aliases: list(details.aliases)},
    source: {provider: text(source.provider), title: text(source.title), url: url(source.url), year: text(source.year), status: text(source.status), type: text(source.type), authors: list(source.authors), aliases: list(source.aliases), tags: list(source.tags), adultContent: typeof source.adultContent === "boolean" ? source.adultContent : null},
    tagGroups: [...groups].map(([group, tags]) => ({group, tags: [...new Set(tags)]})),
    tagOrigins: (Array.isArray(details.tagOrigins) ? details.tagOrigins : []).slice(0, 400).map((row) => ({tag: text(row.tag), provider: text(row.provider)})),
    verifiedAt: text(binding.verifiedAt), conflicts
  };
};
