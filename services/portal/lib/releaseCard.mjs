/** @file Deterministic, source-backed Discord title cards and compact chapter updates. */
const text = value => typeof value === "string" ? value.trim() : "";
const truncate = (value, limit) => value.length > limit ? value.slice(0, limit - 1).trimEnd() + "…" : value;
const escape = value => text(value).replace(/([\\*_`~|\[\]])/g, "\\$1").replace(/@/g, "＠");
const safeUrl = value => {try {const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";} catch {return "";}};

/** Strip provider appendices and markup without generating new synopsis facts.
 * @param {string} value Provider synopsis.
 * @returns {string} Compact readable synopsis.
 */
export const releaseSynopsis = value => truncate(text(value).split(/\n\s*(?:_{3,}|-{3,}|\*{0,2}(?:Links|Notes?)\s*:\*{0,2})/i)[0]
  .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").replace(/@/g, "＠").trim(), 900);

/** Render canonical notification facts once, with useful reader links and no AI appendix.
 * @param {object} event Durable release event.
 * @param {string} brand Configured public site name.
 * @returns {object} Discord message payload.
 */
export const buildReleaseCard = (event, brand = "Scriptarr") => {
  const titleUrl = safeUrl(event.titleUrl), readerUrl = safeUrl(event.readerUrl);
  const type = truncate(text(event.libraryTypeLabel), 60), siteName = truncate(text(brand), 80), title = truncate(escape(event.titleName), 230);
  const chapters = Array.isArray(event.chapters) ? event.chapters : [];
  const actions = [{label: "Open title", url: titleUrl}, {label: event.kind === "title" ? "Start reading" : "Read new chapters", url: readerUrl}]
    .filter(action => action.url).map(action => ({type: 2, style: 5, ...action}));
  if (event.kind === "chapters") {
    const lines = chapters.slice(0, 12).map(c => `[${truncate(escape(c.label), 90)}](${safeUrl(c.readerUrl)})`);
    if (chapters.length > 12) lines.push(`+${chapters.length - 12} more — see the title page.`);
    return {allowedMentions: {parse: []}, embeds: [{title: `New chapter${chapters.length === 1 ? "" : "s"} · ${title}`, url: titleUrl || undefined,
      description: truncate(lines.join(" · "), 1800), color: 0x8b5cf6,
      footer: {text: `${type} • ${siteName} • Noona`}}], components: actions.length ? [{type: 1, components: actions}] : []};
  }
  const seenTags = new Set();
  const tags = (event.tags || []).filter(t => {
    const key = text(t).normalize("NFKC").toLowerCase();
    if (!key || seenTags.has(key)) return false;
    seenTags.add(key); return true;
  }).map(text);
  const tagLine = tags.slice(0, 8).map(t => escape(t)).join(" • ");
  const chapterCount = Number(event.chapterCount) || chapters.length;
  const fields = [
    {name: "Library", value: type || "Library", inline: true},
    event.author ? {name: "Author", value: truncate(escape(event.author), 250), inline: true} : null,
    {name: "Ready to read", value: `${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`, inline: true},
    tagLine ? {name: "Tags", value: truncate(tagLine + (tags.length > 8 ? ` • +${tags.length - 8} more on the title page` : ""), 1024)} : null
  ].filter(Boolean);
  return {allowedMentions: {parse: []}, embeds: [{title, url: titleUrl || undefined,
    description: releaseSynopsis(event.summary) || "A synopsis is not available from the source yet.", color: 0x8b5cf6,
    image: event.artUrl ? {url: event.artUrl} : undefined, fields,
    footer: {text: `New ${type || "title"} • ${siteName} • Noona`}}], components: actions.length ? [{type: 1, components: actions}] : []};
};
