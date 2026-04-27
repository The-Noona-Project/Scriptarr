"use client";

/**
 * @file Safe database explorer page for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const formatBytes = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = numeric;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
};

const stringifyCell = (value) => {
  if (value == null || value === "") {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

const shortCell = (value) => {
  const text = stringifyCell(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

const safeJsonText = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "null";
  }
};

/**
 * Render the Settings-only database explorer.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const DatabaseExplorerPage = ({user}) => {
  const canWrite = hasAdminGrant(user, "database", "write");
  const {notify} = useAdminToast();
  const [selectedTable, setSelectedTable] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState(null);
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/settings/database", {
    fallback: {tables: []}
  });
  const tables = normalizeArray(data?.tables);
  const limit = 50;
  const tableUrl = selectedTable
    ? `/api/moon/v3/admin/settings/database/tables/${encodeURIComponent(selectedTable)}?limit=${limit}&offset=${offset}&q=${encodeURIComponent(query)}`
    : null;
  const tableData = useAdminJson(tableUrl, {
    enabled: Boolean(tableUrl),
    fallback: {columns: [], rows: [], table: null, totalRows: 0},
    deps: [selectedTable, offset, query]
  });
  useAdminEventStaleness({
    domains: ["database"],
    enabled: true,
    locked: Boolean(editor),
    onStale: () => {},
    onRefresh: () => {
      void refresh();
      void tableData.refresh();
    }
  });

  useEffect(() => {
    if (!selectedTable && tables[0]?.name) {
      setSelectedTable(tables[0].name);
    }
  }, [selectedTable, tables]);

  useEffect(() => {
    setOffset(0);
  }, [query, selectedTable]);

  const columns = normalizeArray(tableData.data?.columns);
  const rows = normalizeArray(tableData.data?.rows);
  const visibleColumns = useMemo(() => columns.slice(0, 8), [columns]);

  const openEditor = (row) => {
    if (selectedTable !== "settings") {
      return;
    }
    setEditor({
      key: normalizeString(row.key || row.setting_key),
      valueText: safeJsonText(row.value ?? row.setting_value)
    });
  };

  const saveSetting = async () => {
    let value;
    try {
      value = JSON.parse(editor?.valueText || "null");
    } catch {
      setFlash("Setting value must be valid JSON.");
      setFlashTone("bad");
      return;
    }
    const result = await requestJson(`/api/moon/v3/admin/settings/database/tables/settings/rows/${encodeURIComponent(editor.key)}`, {
      method: "PUT",
      json: {value}
    });
    if (!result.ok) {
      const message = formatDisplayValue(result.payload?.error, "Moon could not update that setting.");
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setEditor(null);
    setFlash("Database setting updated.");
    setFlashTone("good");
    notify({message: "Database setting updated.", tone: "good", category: "action"});
    void refresh();
    void tableData.refresh();
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Database</div>
        <h2>Loading database</h2>
        <p>Moon is reading Vault-owned database metadata through Sage.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {tableData.error ? <AdminActionBanner tone="bad">{tableData.error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flashTone}>{flash}</AdminActionBanner> : null}

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Settings</div>
            <h2>Database explorer</h2>
            <p className="admin-muted">Browse Vault-owned tables safely. Only settings rows can be edited in this pass.</p>
          </div>
          <AdminStatusBadge tone={refreshing || tableData.refreshing ? "warning" : "good"}>{refreshing || tableData.refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Driver</span><strong>{data?.driver || "unknown"}</strong></article>
          <article className="admin-metric-card"><span>Database</span><strong>{data?.database || "Vault"}</strong></article>
          <article className="admin-metric-card"><span>Total size</span><strong>{formatBytes(data?.totalBytes)}</strong></article>
          <article className="admin-metric-card"><span>Rows</span><strong>{data?.rowCount || 0}</strong></article>
        </div>
        <div className="admin-action-row">
          <a className="admin-button ghost" href="/admin/settings">Back to settings</a>
          <button className="admin-button ghost" type="button" onClick={() => void refresh()}>Refresh overview</button>
        </div>
      </section>

      <section className="admin-db-layout">
        <aside className="admin-panel admin-db-sidebar">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Tables</div>
              <h2>{tables.length}</h2>
            </div>
          </div>
          <div className="admin-db-table-list">
            {tables.map((table) => (
              <button
                className={selectedTable === table.name ? "is-active" : ""}
                key={table.name}
                type="button"
                onClick={() => setSelectedTable(table.name)}
              >
                <span>{table.name}</span>
                <em>{table.rowCount}</em>
              </button>
            ))}
          </div>
        </aside>

        <section className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Table</div>
              <h2>{selectedTable || "Select a table"}</h2>
              <p className="admin-muted">{tableData.data?.table?.description || "Rows are redacted where values are sensitive."}</p>
            </div>
            {tableData.data?.table ? <AdminStatusBadge tone={tableData.data.table.editable ? "warning" : "good"}>{tableData.data.table.editable ? "settings editable" : "read only"}</AdminStatusBadge> : null}
          </div>
          <div className="admin-filter-bar">
            <label className="admin-filter-grow">
              <span>Search rows</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search text and JSON fields" />
            </label>
            <button className="admin-button ghost" type="button" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
            <button className="admin-button ghost" type="button" disabled={offset + limit >= Number(tableData.data?.totalRows || 0)} onClick={() => setOffset(offset + limit)}>Next</button>
          </div>
          <div className="admin-log-meta">
            <span>{tableData.data?.totalRows || 0} matching row{Number(tableData.data?.totalRows || 0) === 1 ? "" : "s"}</span>
            <span>{columns.length} column{columns.length === 1 ? "" : "s"}</span>
            <span>Generated: {formatDate(data?.generatedAt)}</span>
          </div>
          <AdminDenseTable
            rows={rows}
            getKey={(row, index) => normalizeString(row.id || row.setting_key || row.key || row.event_id || row.eventId, `${selectedTable}-${offset + index}`)}
            onRowClick={selectedTable === "settings" && canWrite ? openEditor : undefined}
            columns={[
              ...visibleColumns.map((column) => ({
                key: column.name,
                label: column.name,
                render: (row) => <code className="admin-db-cell">{shortCell(row[column.name])}</code>
              })),
              ...(selectedTable === "settings" && canWrite ? [{
                key: "actions",
                label: "",
                className: "is-tight",
                render: (row) => <button className="admin-button small ghost" type="button" onClick={() => openEditor(row)}>Edit JSON</button>
              }] : [])
            ]}
            empty={tableData.loading ? "Loading rows..." : "No rows match this table view."}
          />
        </section>
      </section>

      <AdminDrawer
        open={Boolean(editor)}
        title={`Edit ${editor?.key || "setting"}`}
        kicker="Settings row"
        onClose={() => setEditor(null)}
      >
        <div className="admin-drawer-stack">
          <AdminActionBanner tone="warning">Only settings JSON is editable here. Secrets, sessions, keys, users, and events remain read-only.</AdminActionBanner>
          <textarea
            className="admin-json-editor"
            disabled={!canWrite}
            value={editor?.valueText || ""}
            onChange={(event) => setEditor((current) => ({...(current || {}), valueText: event.target.value}))}
          />
          <button className="admin-button solid" type="button" disabled={!canWrite} onClick={() => void saveSetting()}>Save setting JSON</button>
        </div>
      </AdminDrawer>
    </>
  );
};

export default DatabaseExplorerPage;
