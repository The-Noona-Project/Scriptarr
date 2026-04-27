"use client";

/**
 * @file Dedicated calendar page for Moon admin.
 */

import {useMemo, useState} from "react";
import {useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {
  buildCalendarMonth,
  calendarEntryTone,
  calendarFilterOptions,
  filterCalendarEntries,
  normalizeCalendarEntries
} from "../lib/adminCalendar.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminDenseTable, AdminDrawer, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const kindLabel = (kind) => kind === "title_completed" ? "Completed" : "Chapter";

const monthLabel = (date) => new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric"
}).format(date);

const dateInputValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

const eventCopy = (entry) => entry.kind === "title_completed"
  ? "Title completed"
  : entry.chapterLabel;

const EventPill = ({entry, onClick}) => (
  <button className={`admin-calendar-event ${entry.kind === "title_completed" ? "is-complete" : ""}`} type="button" onClick={() => onClick(entry)}>
    <strong>{entry.title}</strong>
    <span>{eventCopy(entry)}</span>
  </button>
);

/**
 * Render the dedicated Calendar admin page.
 *
 * @returns {import("react").ReactNode}
 */
export const CalendarPage = () => {
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/calendar", {
    fallback: {entries: [], counts: {}}
  });
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [includeCompletedMarkers, setIncludeCompletedMarkers] = useState(true);
  const [view, setView] = useState("month");
  const [monthDate, setMonthDate] = useState(() => new Date());
  const [selected, setSelected] = useState(null);
  const live = useAdminEventStaleness({
    domains: ["calendar", "library", "activity"],
    onStale: () => {},
    onRefresh: refresh
  });

  const entries = useMemo(() => normalizeCalendarEntries(data?.entries), [data]);
  const filtered = useMemo(() => filterCalendarEntries(entries, {
    query,
    type,
    status,
    includeCompletedMarkers
  }), [entries, includeCompletedMarkers, query, status, type]);
  const typeOptions = useMemo(() => calendarFilterOptions(entries, "type"), [entries]);
  const statusOptions = useMemo(() => calendarFilterOptions(entries, "status"), [entries]);
  const monthDays = useMemo(() => buildCalendarMonth(monthDate, filtered), [filtered, monthDate]);
  const counts = data?.counts || {};

  const shiftMonth = (delta) => {
    setMonthDate((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Monitor</div>
        <h2>Loading calendar</h2>
        <p>Moon is collecting release dates and completed title markers.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Monitor</div>
        <h2>Calendar unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  return (
    <>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Monitor</div>
            <h2>Calendar</h2>
            <p className="admin-muted">Chapter releases, cataloged downloads, and completed title markers.</p>
          </div>
          <AdminStatusBadge tone={live.state === "live" ? "good" : "warning"}>
            {refreshing ? "refreshing" : live.state === "live" ? "live" : "degraded"}
          </AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Total events</span><strong>{counts.totalEntries || entries.length}</strong></article>
          <article className="admin-metric-card"><span>Chapters</span><strong>{counts.chapterEntries || 0}</strong></article>
          <article className="admin-metric-card"><span>Completed markers</span><strong>{counts.completedMarkers || 0}</strong></article>
          <article className="admin-metric-card"><span>Undated completed</span><strong>{counts.undatedCompletedCount || 0}</strong></article>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Filters</div>
            <h2>{filtered.length} visible</h2>
          </div>
          <div className="admin-tab-row" role="tablist" aria-label="Calendar view">
            {["month", "agenda"].map((entry) => (
              <button className={`admin-tab ${view === entry ? "is-active" : ""}`} key={entry} type="button" onClick={() => setView(entry)}>
                {entry}
              </button>
            ))}
          </div>
        </div>
        <AdminFilterBar>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, chapter, provider..." />
          </label>
          <label>
            <span>Type</span>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">All types</option>
              {typeOptions.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {statusOptions.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>
            <span>Completed</span>
            <select value={includeCompletedMarkers ? "yes" : "no"} onChange={(event) => setIncludeCompletedMarkers(event.target.value === "yes")}>
              <option value="yes">Show markers</option>
              <option value="no">Hide markers</option>
            </select>
          </label>
        </AdminFilterBar>
      </section>

      {view === "month" ? (
        <section className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Month</div>
              <h2>{monthLabel(monthDate)}</h2>
            </div>
            <div className="admin-action-row">
              <button className="admin-button ghost" type="button" onClick={() => shiftMonth(-1)}>Previous</button>
              <input
                aria-label="Calendar month"
                className="admin-calendar-month-input"
                type="month"
                value={dateInputValue(monthDate)}
                onChange={(event) => {
                  const [year, month] = event.target.value.split("-").map((part) => Number.parseInt(part, 10));
                  if (Number.isInteger(year) && Number.isInteger(month)) {
                    setMonthDate(new Date(year, month - 1, 1));
                  }
                }}
              />
              <button className="admin-button ghost" type="button" onClick={() => setMonthDate(new Date())}>Today</button>
              <button className="admin-button ghost" type="button" onClick={() => shiftMonth(1)}>Next</button>
            </div>
          </div>
          <div className="admin-calendar-grid">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div className="admin-calendar-weekday" key={day}>{day}</div>
            ))}
            {monthDays.map((day) => (
              <div className={`admin-calendar-day ${day.inMonth ? "" : "is-muted"}`} key={day.day}>
                <div className="admin-calendar-date">{day.date.getDate()}</div>
                <div className="admin-calendar-events">
                  {day.entries.slice(0, 4).map((entry) => <EventPill entry={entry} key={entry.id} onClick={setSelected} />)}
                  {day.entries.length > 4 ? <span className="admin-calendar-more">+{day.entries.length - 4} more</span> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Agenda</div>
              <h2>{filtered.length} event{filtered.length === 1 ? "" : "s"}</h2>
            </div>
          </div>
          <AdminDenseTable
            rows={filtered}
            getKey={(entry) => entry.id}
            selectedKey={selected?.id || ""}
            onRowClick={setSelected}
            empty="No calendar events match this view."
            columns={[
              {key: "date", label: "Date", render: (entry) => formatDate(entry.eventDate)},
              {key: "kind", label: "Kind", render: (entry) => <AdminStatusBadge tone={calendarEntryTone(entry)}>{kindLabel(entry.kind)}</AdminStatusBadge>},
              {key: "title", label: "Title", render: (entry) => <strong>{entry.title}</strong>},
              {key: "chapter", label: "Chapter", render: (entry) => entry.chapterLabel},
              {key: "status", label: "Status", render: (entry) => entry.titleStatus}
            ]}
          />
        </section>
      )}

      <AdminDrawer open={Boolean(selected)} title={formatDisplayValue(selected?.title, "Calendar event")} kicker={kindLabel(selected?.kind)} onClose={() => setSelected(null)}>
        {selected ? (
          <div className="admin-drawer-stack">
            <div className="admin-detail-grid">
              <span><strong>Date</strong>{formatDate(selected.eventDate)}</span>
              <span><strong>Status</strong>{selected.titleStatus}</span>
              <span><strong>Type</strong>{selected.libraryTypeLabel}</span>
              <span><strong>Chapter</strong>{selected.chapterLabel}</span>
              <span><strong>Pages</strong>{selected.pageCount || "unknown"}</span>
              <span><strong>Provider</strong>{formatDisplayValue(selected.metadataProvider, "unknown")}</span>
            </div>
            <div className="admin-action-row">
              {selected.readerUrl ? <a className="admin-button solid" href={selected.readerUrl}>Open reader</a> : null}
              {selected.titleUrl ? <a className="admin-button ghost" href={selected.titleUrl}>Open title</a> : null}
              {selected.sourceUrl ? <a className="admin-button ghost" href={selected.sourceUrl} target="_blank" rel="noreferrer">Open source</a> : null}
            </div>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
};

export default CalendarPage;
