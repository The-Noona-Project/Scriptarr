/**
 * @file Moon admin calendar helpers.
 */

import {formatDisplayValue, normalizeString} from "./format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const parseDate = (value) => {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date;
};

const isoDay = (value) => {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
};

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

/**
 * Normalize calendar API entries into render-safe rows.
 *
 * @param {unknown} value
 * @returns {Array<Record<string, any>>}
 */
export const normalizeCalendarEntries = (value) => normalizeArray(value).map((entry, index) => {
  const eventDate = normalizeString(entry?.eventDate || entry?.releaseDate);
  const date = parseDate(eventDate);
  return {
    id: normalizeString(entry?.id, `calendar-${index}`),
    kind: normalizeString(entry?.kind, "chapter_release"),
    eventDate: date ? date.toISOString() : "",
    day: date ? date.toISOString().slice(0, 10) : "",
    titleId: normalizeString(entry?.titleId),
    title: formatDisplayValue(entry?.title, "Untitled"),
    coverUrl: normalizeString(entry?.coverUrl),
    libraryTypeLabel: formatDisplayValue(entry?.libraryTypeLabel || entry?.mediaType, "Manga"),
    libraryTypeSlug: normalizeString(entry?.libraryTypeSlug || entry?.mediaType, "manga"),
    mediaType: normalizeString(entry?.mediaType, "manga"),
    titleStatus: normalizeString(entry?.titleStatus, "active").toLowerCase(),
    titleUrl: normalizeString(entry?.titleUrl),
    readerUrl: normalizeString(entry?.readerUrl),
    metadataProvider: normalizeString(entry?.metadataProvider),
    sourceUrl: normalizeString(entry?.sourceUrl),
    chapterId: normalizeString(entry?.chapterId),
    chapterLabel: formatDisplayValue(entry?.chapterLabel, entry?.kind === "title_completed" ? "Complete" : "Chapter"),
    chapterNumber: normalizeString(entry?.chapterNumber),
    pageCount: Number.parseInt(String(entry?.pageCount || 0), 10) || 0,
    available: entry?.available !== false
  };
}).filter((entry) => entry.eventDate);

/**
 * Filter calendar rows by admin controls.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {{query?: string, type?: string, status?: string, includeCompletedMarkers?: boolean}} filters
 * @returns {Array<Record<string, any>>}
 */
export const filterCalendarEntries = (entries = [], filters = {}) => {
  const query = normalizeString(filters.query).toLowerCase();
  const type = normalizeString(filters.type);
  const status = normalizeString(filters.status);
  return normalizeArray(entries).filter((entry) => {
    if (!filters.includeCompletedMarkers && entry.kind === "title_completed") {
      return false;
    }
    if (type && entry.libraryTypeSlug !== type) {
      return false;
    }
    if (status && entry.titleStatus !== status) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = [
      entry.title,
      entry.chapterLabel,
      entry.libraryTypeLabel,
      entry.titleStatus,
      entry.metadataProvider
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
};

/**
 * Build select filter options from entries.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {"type" | "status"} field
 * @returns {Array<{id: string, label: string}>}
 */
export const calendarFilterOptions = (entries = [], field = "type") => {
  const values = new Map();
  for (const entry of normalizeArray(entries)) {
    const id = field === "status" ? entry.titleStatus : entry.libraryTypeSlug;
    const label = field === "status" ? entry.titleStatus : entry.libraryTypeLabel;
    if (id && !values.has(id)) {
      values.set(id, label);
    }
  }
  return Array.from(values.entries())
    .map(([id, label]) => ({id, label}))
    .sort((left, right) => left.label.localeCompare(right.label));
};

/**
 * Build a 6-week month grid for the admin calendar.
 *
 * @param {Date} monthDate
 * @param {Array<Record<string, any>>} entries
 * @returns {Array<{date: Date, day: string, inMonth: boolean, entries: Array<Record<string, any>>}>}
 */
export const buildCalendarMonth = (monthDate, entries = []) => {
  const base = monthDate instanceof Date && !Number.isNaN(monthDate.getTime()) ? monthDate : new Date();
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const cursor = new Date(first);
  cursor.setDate(first.getDate() - first.getDay());
  const byDay = new Map();
  for (const entry of normalizeArray(entries)) {
    const day = isoDay(entry.eventDate);
    if (!day) {
      continue;
    }
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day).push(entry);
  }

  return Array.from({length: 42}, () => {
    const date = new Date(cursor);
    const day = isoDay(date);
    cursor.setDate(cursor.getDate() + 1);
    return {
      date,
      day,
      inMonth: monthKey(date) === monthKey(first),
      entries: byDay.get(day) || []
    };
  });
};

/**
 * Pick a badge tone for a calendar entry.
 *
 * @param {Record<string, any>} entry
 * @returns {string}
 */
export const calendarEntryTone = (entry = {}) => {
  if (entry.kind === "title_completed") {
    return "good";
  }
  if (entry.available === false) {
    return "warning";
  }
  return "";
};

export default {
  buildCalendarMonth,
  calendarEntryTone,
  calendarFilterOptions,
  filterCalendarEntries,
  normalizeCalendarEntries
};
