/** @file Bounded catalogue discovery and damaged-chapter hydration for Missing Content. */

const damaged = chapter => chapter?.available === false || Number(chapter?.missingPageCount) > 0
  || ["missing_content", "possible_missing_page", "bad_source"].includes(chapter?.qualityStatus);
const affected = title => Number(title.chapterCount) > Number(title.chaptersDownloaded)
  || Number(title.partialChapterCount) > 0 || Number(title.missingContentCount) > 0 || damaged(title);

/**
 * Keep ordinary catalogue rows compact and hydrate only titles needing chapter repair.
 * Failed or repeated pagination must not silently hide later damaged titles.
 * @param {(path: string) => Promise<any>} fetchJson Authenticated Raven broker request.
 * @param {(title: any) => any} summarize Browser-safe title and chapter projection.
 * @returns {Promise<any[]>} Complete title census with only affected chapter details.
 */
export const loadMissingContentTitles = async (fetchJson, summarize) => {
  const cards = new Map(), cursors = new Set();
  let cursor = "";
  for (;;) {
    const query = new URLSearchParams({view: "card", pageSize: "100"});
    if (cursor) query.set("cursor", cursor);
    const page = await fetchJson(`/v1/library?${query}`);
    if (!Array.isArray(page?.titles)) throw new Error("Missing Content catalogue page is incomplete.");
    for (const title of page.titles) {
      if (!title?.id || cards.has(title.id)) throw new Error("Missing Content catalogue page repeated a title.");
      cards.set(title.id, title);
    }
    if (!page.pageInfo?.hasMore) break;
    const next = page.pageInfo.nextCursor;
    if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("Missing Content catalogue pagination did not advance.");
    cursors.add(next);
    cursor = next;
  }
  const titles = [...cards.values()];
  const results = new Array(titles.length);
  for (let offset = 0; offset < titles.length; offset += 4) {
    await Promise.all(titles.slice(offset, offset + 4).map(async (card, index) => {
      const title = affected(card) ? await fetchJson(`/v1/library/${encodeURIComponent(card.id)}`) : card;
      if (!title || title.id !== card.id || (affected(card) && !Array.isArray(title.chapters))) {
        throw new Error("Missing Content chapter details are incomplete.");
      }
      const projected = summarize(title);
      results[offset + index] = {...projected, chapters: projected.chapters.filter(damaged)};
    }));
  }
  return results;
};
