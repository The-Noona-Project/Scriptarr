/**
 * @file Calendar payload shaping for Moon admin.
 */

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

const parseIso = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const timestamp = (value) => {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const titleUrl = (title) => {
  const titleId = normalizeString(title?.id);
  if (!titleId) {
    return "";
  }
  return `/title/${encodeURIComponent(normalizeTypeSlug(title?.libraryTypeSlug || title?.mediaType))}/${encodeURIComponent(titleId)}`;
};

const readerUrl = (title, chapter) => {
  const titleId = normalizeString(title?.id);
  const chapterId = normalizeString(chapter?.id);
  if (!titleId || !chapterId || chapter?.available === false) {
    return "";
  }
  return `/reader/${encodeURIComponent(normalizeTypeSlug(title?.libraryTypeSlug || title?.mediaType))}/${encodeURIComponent(titleId)}/${encodeURIComponent(chapterId)}`;
};

const calendarTitleFields = (title = {}) => ({
  titleId: normalizeString(title.id),
  title: normalizeString(title.title, "Untitled"),
  coverUrl: normalizeString(title.coverUrl),
  libraryTypeLabel: normalizeString(title.libraryTypeLabel || title.mediaType, "Manga"),
  libraryTypeSlug: normalizeTypeSlug(title.libraryTypeSlug || title.mediaType),
  mediaType: normalizeString(title.mediaType, "manga"),
  metadataProvider: normalizeString(title.metadataProvider),
  sourceUrl: normalizeString(title.sourceUrl),
  titleStatus: normalizeString(title.status, "active"),
  titleUrl: titleUrl(title)
});

const newestChapterBy = (chapters = [], accessor) => normalizeArray(chapters)
  .map((chapter) => ({chapter, at: timestamp(accessor(chapter))}))
  .filter((entry) => entry.at > 0)
  .sort((left, right) => right.at - left.at)[0] || null;

const newestChapterForReader = (chapters = []) => [...normalizeArray(chapters)]
  .filter((chapter) => normalizeString(chapter?.id) && chapter?.available !== false)
  .sort((left, right) => {
    const dateDelta = Math.max(timestamp(right?.releaseDate), timestamp(right?.updatedAt))
      - Math.max(timestamp(left?.releaseDate), timestamp(left?.updatedAt));
    if (dateDelta !== 0) {
      return dateDelta;
    }
    const rightNumber = Number.parseFloat(String(right?.chapterNumber || "0"));
    const leftNumber = Number.parseFloat(String(left?.chapterNumber || "0"));
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return rightNumber - leftNumber;
    }
    return normalizeString(right?.label).localeCompare(normalizeString(left?.label));
  })[0] || null;

const completionEventDate = (title = {}) => {
  const chapters = normalizeArray(title.chapters);
  const releaseChapter = newestChapterBy(chapters, (chapter) => chapter?.releaseDate);
  if (releaseChapter) {
    return parseIso(releaseChapter.chapter.releaseDate);
  }
  const updatedChapter = newestChapterBy(chapters, (chapter) => chapter?.updatedAt);
  if (updatedChapter) {
    return parseIso(updatedChapter.chapter.updatedAt);
  }
  return parseIso(title.updatedAt) || parseIso(title.metadataMatchedAt);
};

const buildChapterEntry = (title, chapter, index) => {
  const eventDate = parseIso(chapter?.releaseDate);
  if (!eventDate) {
    return null;
  }
  return {
    id: `chapter:${normalizeString(title.id, "title")}:${normalizeString(chapter.id, String(index))}`,
    kind: "chapter_release",
    eventDate,
    ...calendarTitleFields(title),
    chapterId: normalizeString(chapter.id),
    chapterLabel: normalizeString(chapter.label, "Chapter"),
    chapterNumber: normalizeString(chapter.chapterNumber),
    pageCount: Number.parseInt(String(chapter.pageCount || 0), 10) || 0,
    releaseDate: eventDate,
    available: chapter.available !== false,
    readerUrl: readerUrl(title, chapter)
  };
};

const buildCompletedEntry = (title) => {
  if (normalizeString(title?.status).toLowerCase() !== "completed") {
    return null;
  }
  const eventDate = completionEventDate(title);
  if (!eventDate) {
    return null;
  }
  const chapter = newestChapterForReader(title.chapters);
  return {
    id: `completed:${normalizeString(title.id, "title")}`,
    kind: "title_completed",
    eventDate,
    ...calendarTitleFields(title),
    chapterId: normalizeString(chapter?.id),
    chapterLabel: normalizeString(chapter?.label, normalizeString(title.latestChapter, "Complete")),
    chapterNumber: normalizeString(chapter?.chapterNumber),
    pageCount: Number.parseInt(String(chapter?.pageCount || 0), 10) || 0,
    releaseDate: eventDate,
    available: chapter ? chapter.available !== false : false,
    readerUrl: chapter ? readerUrl(title, chapter) : ""
  };
};

/**
 * Build the Moon admin calendar payload from normalized library titles.
 *
 * @param {Array<Record<string, any>>} titles
 * @returns {Record<string, any>}
 */
export const buildAdminCalendarPayload = (titles = []) => {
  const entries = [];
  let rawChapterCount = 0;
  let completedTitleCount = 0;
  let undatedCompletedCount = 0;

  for (const title of normalizeArray(titles)) {
    const chapters = normalizeArray(title?.chapters);
    rawChapterCount += chapters.length;
    for (const [index, chapter] of chapters.entries()) {
      const entry = buildChapterEntry(title, chapter, index);
      if (entry) {
        entries.push(entry);
      }
    }

    if (normalizeString(title?.status).toLowerCase() === "completed") {
      completedTitleCount += 1;
      const completedEntry = buildCompletedEntry(title);
      if (completedEntry) {
        entries.push(completedEntry);
      } else {
        undatedCompletedCount += 1;
      }
    }
  }

  entries.sort((left, right) => timestamp(left.eventDate) - timestamp(right.eventDate)
    || normalizeString(left.title).localeCompare(normalizeString(right.title))
    || normalizeString(left.kind).localeCompare(normalizeString(right.kind)));

  return {
    entries,
    counts: {
      totalEntries: entries.length,
      chapterEntries: entries.filter((entry) => entry.kind === "chapter_release").length,
      completedMarkers: entries.filter((entry) => entry.kind === "title_completed").length,
      completedTitleCount,
      undatedCount: Math.max(0, rawChapterCount - entries.filter((entry) => entry.kind === "chapter_release").length),
      undatedCompletedCount
    },
    generatedAt: new Date().toISOString()
  };
};

export default {
  buildAdminCalendarPayload
};
