import {
  escapeHtml,
  renderChip,
  renderCoverThumb,
  renderEmptyState,
  renderStatusBadge
} from "../dom.js";
import {formatDate, parseDateValue} from "../format.js";
import {buildAdminLibraryTitlePath} from "../routes.js";

const DAY_LABELS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
const DEFAULT_CALENDAR_STATE = Object.freeze({
  focusMonthKey: "",
  type: "all",
  view: "month"
});

/**
 * Load calendar entries for Moon admin.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadCalendarPage = ({api}) => api.get("/api/moon/v3/admin/calendar");

/**
 * Parse a nullable release date string into a valid Date.
 *
 * @param {string | null | undefined} value
 * @returns {Date | null}
 */
const parseCalendarDate = (value) => {
  const parsed = parseDateValue(value);
  return parsed || null;
};

/**
 * Convert a date into a stable month key.
 *
 * @param {Date} value
 * @returns {string}
 */
const toMonthKey = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;

/**
 * Convert a date into a stable day key.
 *
 * @param {Date} value
 * @returns {string}
 */
const toDayKey = (value) => `${toMonthKey(value)}-${String(value.getDate()).padStart(2, "0")}`;

/**
 * Reconstruct the first day of a month from a stable month key.
 *
 * @param {string} value
 * @returns {Date}
 */
const monthKeyToDate = (value) => {
  const [year, month] = String(value || "").split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }
  return new Date(year, month - 1, 1);
};

/**
 * Format a month key for the calendar header.
 *
 * @param {string} monthKey
 * @returns {string}
 */
const formatMonthLabel = (monthKey) => monthKeyToDate(monthKey).toLocaleDateString("en-US", {
  month: "long",
  year: "numeric"
});

/**
 * Normalize raw admin calendar entries into a richer view model.
 *
 * @param {Array<Record<string, any>> | null | undefined} entries
 * @returns {Array<Record<string, any>>}
 */
const normalizeCalendarEntries = (entries) => (Array.isArray(entries) ? entries : [])
  .map((entry) => {
    const parsedDate = parseCalendarDate(entry?.releaseDate);
    if (!parsedDate) {
      return null;
    }
    const libraryTypeSlug = String(entry.libraryTypeSlug || entry.mediaType || "manga").trim() || "manga";
    const titleId = String(entry.titleId || "").trim();
    return {
      ...entry,
      title: String(entry?.title || "Untitled").trim() || "Untitled",
      chapterLabel: String(entry?.chapterLabel || entry?.chapterId || "Unknown chapter").trim() || "Unknown chapter",
      coverUrl: String(entry?.coverUrl || "").trim(),
      libraryTypeLabel: String(entry?.libraryTypeLabel || entry?.mediaType || "Manga").trim() || "Manga",
      libraryTypeSlug,
      metadataProvider: String(entry?.metadataProvider || "").trim(),
      titleStatus: String(entry?.titleStatus || "active").trim() || "active",
      sourceUrl: String(entry?.sourceUrl || "").trim(),
      parsedDate,
      monthKey: toMonthKey(parsedDate),
      dayKey: toDayKey(parsedDate),
      titleHref: titleId ? buildAdminLibraryTitlePath(libraryTypeSlug, titleId) : "",
      pageCount: Number.parseInt(String(entry?.pageCount || 0), 10) || 0,
      available: entry?.available !== false
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.parsedDate - right.parsedDate);

/**
 * Pick the best initial month focus for the admin calendar.
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {string}
 */
const resolveInitialMonthKey = (entries) => {
  const today = new Date();
  const todayMonthKey = toMonthKey(today);
  if (entries.some((entry) => entry.monthKey === todayMonthKey)) {
    return todayMonthKey;
  }

  const nextUpcoming = entries.find((entry) => entry.parsedDate >= today);
  if (nextUpcoming) {
    return nextUpcoming.monthKey;
  }

  return entries.at(-1)?.monthKey || todayMonthKey;
};

/**
 * Render a compact release card inside the month grid.
 *
 * @param {Record<string, any>} entry
 * @returns {string}
 */
const renderMonthEntry = (entry) => `
  <a class="calendar-entry" href="${escapeHtml(entry.titleHref || "#")}" ${entry.titleHref ? "" : "tabindex=\"-1\""} ${entry.titleHref ? "" : "aria-disabled=\"true\""}>
    <span class="calendar-entry-bar type-${escapeHtml(entry.libraryTypeSlug)}" aria-hidden="true"></span>
    <span class="calendar-entry-copy">
      <strong>${escapeHtml(entry.title)}</strong>
      <span>${escapeHtml(entry.chapterLabel)}</span>
      ${entry.titleStatus && entry.titleStatus !== "active" ? `<small>${escapeHtml(entry.titleStatus)}</small>` : ""}
    </span>
  </a>
`;

/**
 * Render a richer agenda-style release row.
 *
 * @param {Record<string, any>} entry
 * @returns {string}
 */
const renderAgendaEntry = (entry) => `
  <article class="agenda-entry">
    <div class="agenda-entry-head">
      ${renderCoverThumb(entry.coverUrl, entry.title, "cover-thumb agenda-cover-thumb")}
      <div class="agenda-entry-copy">
        <div class="agenda-entry-title-row">
          ${entry.titleHref
            ? `<a class="series-row-link" href="${escapeHtml(entry.titleHref)}">${escapeHtml(entry.title)}</a>`
            : `<strong>${escapeHtml(entry.title)}</strong>`}
          ${renderStatusBadge(entry.available ? "Available" : "Pending")}
        </div>
        <div class="agenda-entry-meta">
          ${renderChip(entry.libraryTypeLabel)}
          ${entry.titleStatus ? renderChip(entry.titleStatus) : ""}
          ${entry.metadataProvider ? renderChip(entry.metadataProvider) : ""}
          ${entry.pageCount > 0 ? renderChip(`${entry.pageCount} pages`) : ""}
        </div>
        <div class="agenda-entry-chapter">${escapeHtml(entry.chapterLabel)}</div>
      </div>
    </div>
    <div class="agenda-entry-links">
      <span>${escapeHtml(formatDate(entry.releaseDate))}</span>
      ${entry.sourceUrl ? `<a class="ghost-button small" href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>` : ""}
    </div>
  </article>
`;

/**
 * Build the month grid range for a given focus month.
 *
 * @param {string} focusMonthKey
 * @returns {Date[]}
 */
const buildMonthCells = (focusMonthKey) => {
  const focus = monthKeyToDate(focusMonthKey);
  const gridStart = new Date(focus.getFullYear(), focus.getMonth(), 1);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(focus.getFullYear(), focus.getMonth() + 1, 0);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const cells = [];
  for (let cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 1)) {
    cells.push(new Date(cursor));
  }
  return cells;
};

/**
 * Filter normalized entries using the current calendar state.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {{type: string}} state
 * @returns {Array<Record<string, any>>}
 */
const filterCalendarEntries = (entries, state) => entries.filter((entry) => (
  String(state.type || "all") === "all" || entry.libraryTypeSlug === state.type
));

/**
 * Render the Sonarr-style month grid.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {{focusMonthKey: string}} state
 * @returns {string}
 */
const renderMonthView = (entries, state) => {
  const entryGroups = new Map(entries.map((entry) => [entry.dayKey, []]));
  entries.forEach((entry) => {
    const existing = entryGroups.get(entry.dayKey) || [];
    existing.push(entry);
    entryGroups.set(entry.dayKey, existing);
  });

  const todayKey = toDayKey(new Date());
  const focusDate = monthKeyToDate(state.focusMonthKey);
  const cells = buildMonthCells(state.focusMonthKey);

  return `
    <div class="admin-calendar-grid">
      ${DAY_LABELS.map((label) => `<div class="admin-calendar-day-label">${escapeHtml(label)}</div>`).join("")}
      ${cells.map((cell) => {
        const monthKey = toMonthKey(cell);
        const dayKey = toDayKey(cell);
        const dayEntries = (entryGroups.get(dayKey) || []).sort((left, right) => left.parsedDate - right.parsedDate);
        const extraCount = Math.max(0, dayEntries.length - 3);
        return `
          <section class="admin-calendar-cell ${monthKey !== state.focusMonthKey ? "is-outside-month" : ""} ${dayKey === todayKey ? "is-today" : ""}">
            <header>
              <span>${escapeHtml(String(cell.getDate()))}</span>
              ${monthKey !== state.focusMonthKey ? `<small>${escapeHtml(cell.toLocaleDateString("en-US", {month: "short"}))}</small>` : ""}
            </header>
            <div class="admin-calendar-events">
              ${dayEntries.slice(0, 3).map((entry) => renderMonthEntry(entry)).join("")}
              ${extraCount > 0 ? `<div class="calendar-overflow-note">+${escapeHtml(extraCount)} more release${extraCount === 1 ? "" : "s"}</div>` : ""}
              ${!dayEntries.length && monthKey === state.focusMonthKey && cell >= focusDate && cell <= new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 0)
                ? `<div class="calendar-empty-note">No tracked releases</div>`
                : ""}
            </div>
          </section>
        `;
      }).join("")}
    </div>
  `;
};

/**
 * Render an agenda grouped by release date.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {{focusMonthKey: string}} state
 * @returns {string}
 */
const renderAgendaView = (entries, state) => {
  const monthEntries = entries.filter((entry) => entry.monthKey === state.focusMonthKey);
  if (!monthEntries.length) {
    return renderEmptyState("No releases this month", "Tracked titles with release dates will show here once Raven and the metadata providers surface them.");
  }

  const dayKeys = Array.from(new Set(monthEntries.map((entry) => entry.dayKey)));
  return `
    <div class="admin-calendar-agenda">
      ${dayKeys.map((dayKey) => {
        const dayEntries = monthEntries.filter((entry) => entry.dayKey === dayKey);
        const dayDate = dayEntries[0]?.parsedDate;
        return `
          <section class="agenda-day-group">
            <header class="agenda-day-header">
              <strong>${escapeHtml(dayDate ? formatDate(dayDate.toISOString()) : dayKey)}</strong>
              <span>${escapeHtml(`${dayEntries.length} release${dayEntries.length === 1 ? "" : "s"}`)}</span>
            </header>
            <div class="agenda-day-list">
              ${dayEntries.map((entry) => renderAgendaEntry(entry)).join("")}
            </div>
          </section>
        `;
      }).join("")}
    </div>
  `;
};

/**
 * Render the active calendar body for the current view.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {{focusMonthKey: string, type: string, view: string}} state
 * @returns {string}
 */
const renderCalendarBody = (entries, state) => (
  state.view === "agenda" ? renderAgendaView(entries, state) : renderMonthView(entries, state)
);

/**
 * Render the admin calendar view.
 *
 * @param {Awaited<ReturnType<typeof loadCalendarPage>>} result
 * @returns {string}
 */
export const renderCalendarPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Calendar unavailable", result.payload?.error || "Unable to load release calendar data.");
  }

  const entries = normalizeCalendarEntries(result.payload?.entries);
  const focusMonthKey = resolveInitialMonthKey(entries);
  const typeOptions = Array.from(new Set(entries.map((entry) => entry.libraryTypeSlug))).sort();
  const state = {
    ...DEFAULT_CALENDAR_STATE,
    focusMonthKey
  };

  if (!entries.length) {
    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Release calendar</span>
            <h2>Library release calendar</h2>
            <p class="field-note">Moon now captures chapter release dates from Raven source scrapes and metadata enrichment. Older titles may need a rescan before they appear here.</p>
          </div>
        </div>
        ${renderEmptyState(
          "No dated releases yet",
          result.payload?.undatedCount
            ? `${result.payload.undatedCount} chapter entries still do not have release dates. New downloads will start filling this in automatically.`
            : "Release dates will show here once Raven starts tracking more title schedules."
        )}
      </section>
    `;
  }

  const visibleEntries = filterCalendarEntries(entries, state);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Release calendar</span>
          <h2>Library release calendar</h2>
          <p class="field-note">A Sonarr-inspired calendar view for tracked chapter release dates, fed by Raven source scrapes and metadata enrichment.</p>
        </div>
      </div>
      <div class="calendar-toolbar">
        <div class="calendar-nav">
          <button class="ghost-button small" type="button" data-calendar-nav="prev" aria-label="Previous month">&lsaquo;</button>
          <button class="ghost-button small" type="button" data-calendar-nav="today">Today</button>
          <button class="ghost-button small" type="button" data-calendar-nav="next" aria-label="Next month">&rsaquo;</button>
        </div>
        <div class="calendar-month-label" id="calendar-month-label">${escapeHtml(formatMonthLabel(focusMonthKey))}</div>
        <div class="calendar-toolbar-controls">
          <label class="compact-field">
            <span>Type</span>
            <select id="calendar-type-filter">
              <option value="all">All types</option>
              ${typeOptions.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}
            </select>
          </label>
          <div class="calendar-view-toggle" role="tablist" aria-label="Calendar views">
            <button class="ghost-button small is-active" type="button" data-calendar-view="month">Month</button>
            <button class="ghost-button small" type="button" data-calendar-view="agenda">Agenda</button>
          </div>
        </div>
      </div>
      <div class="series-toolbar-summary" id="calendar-summary">
        Showing ${visibleEntries.length} dated chapter release${visibleEntries.length === 1 ? "" : "s"} in ${escapeHtml(formatMonthLabel(focusMonthKey))}.
        ${result.payload?.undatedCount ? `${escapeHtml(String(result.payload.undatedCount))} undated chapter${result.payload.undatedCount === 1 ? "" : "s"} still need richer source metadata.` : ""}
      </div>
      <div id="calendar-content">
        ${renderCalendarBody(visibleEntries, state)}
      </div>
    </section>
  `;
};

/**
 * Enhance the admin calendar with Sonarr-style month navigation and view toggles.
 *
 * @param {HTMLElement} root
 * @param {any} _context
 * @param {Awaited<ReturnType<typeof loadCalendarPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceCalendarPage = async (root, _context, result) => {
  if (!result.ok) {
    return;
  }

  const entries = normalizeCalendarEntries(result.payload?.entries);
  if (!entries.length) {
    return;
  }

  const state = {
    ...DEFAULT_CALENDAR_STATE,
    focusMonthKey: resolveInitialMonthKey(entries)
  };
  const monthLabel = root.querySelector("#calendar-month-label");
  const summary = root.querySelector("#calendar-summary");
  const content = root.querySelector("#calendar-content");
  const typeFilter = root.querySelector("#calendar-type-filter");

  /**
   * Re-render the calendar body for the current state.
   *
   * @returns {void}
   */
  const render = () => {
    const visibleEntries = filterCalendarEntries(entries, state);
    if (monthLabel instanceof HTMLElement) {
      monthLabel.textContent = formatMonthLabel(state.focusMonthKey);
    }
    if (summary instanceof HTMLElement) {
      summary.textContent = `Showing ${visibleEntries.length} dated chapter release${visibleEntries.length === 1 ? "" : "s"} in ${formatMonthLabel(state.focusMonthKey)}.${result.payload?.undatedCount ? ` ${result.payload.undatedCount} undated chapter${result.payload.undatedCount === 1 ? "" : "s"} still need richer source metadata.` : ""}`;
    }
    if (content instanceof HTMLElement) {
      content.innerHTML = renderCalendarBody(visibleEntries, state);
    }
    root.querySelectorAll("[data-calendar-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.calendarView === state.view);
    });
  };

  root.querySelectorAll("[data-calendar-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.calendarNav === "today") {
        state.focusMonthKey = toMonthKey(new Date());
        render();
        return;
      }
      const focusDate = monthKeyToDate(state.focusMonthKey);
      focusDate.setMonth(focusDate.getMonth() + (button.dataset.calendarNav === "next" ? 1 : -1));
      state.focusMonthKey = toMonthKey(focusDate);
      render();
    });
  });

  root.querySelectorAll("[data-calendar-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.calendarView || "month";
      render();
    });
  });

  typeFilter?.addEventListener("change", (event) => {
    state.type = event.currentTarget?.value || "all";
    render();
  });
};

export default {
  loadCalendarPage,
  renderCalendarPage,
  enhanceCalendarPage
};
