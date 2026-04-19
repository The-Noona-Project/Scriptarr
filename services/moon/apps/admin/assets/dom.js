import {statusTone} from "./format.js";

/**
 * Escape unsafe HTML characters in a string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;");

/**
 * Render a compact status badge.
 *
 * @param {string | null | undefined} label
 * @returns {string}
 */
export const renderStatusBadge = (label) => {
  const value = label || "Unknown";
  return `<span class="status-badge ${statusTone(value)}">${escapeHtml(value)}</span>`;
};

/**
 * Render a compact token or metadata chip.
 *
 * @param {string} value
 * @returns {string}
 */
export const renderChip = (value) => `<span class="chip">${escapeHtml(value)}</span>`;

/**
 * Render a chip collection.
 *
 * @param {string[] | null | undefined} values
 * @returns {string}
 */
export const renderChipList = (values) => Array.isArray(values) && values.length
  ? `<div class="chip-row">${values.map((value) => renderChip(value)).join("")}</div>`
  : `<span class="muted-copy">None</span>`;

/**
 * Render a reusable empty-state section.
 *
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export const renderEmptyState = (title, body) => `
  <section class="empty-state">
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(body)}</p>
  </section>
`;

/**
 * Render a dense admin data table.
 *
 * @param {{
 *   columns: string[],
 *   rows: string[][],
 *   emptyTitle?: string,
 *   emptyBody?: string
 * }} options
 * @returns {string}
 */
export const renderTable = ({columns, rows, emptyTitle = "No rows", emptyBody = "There is nothing to show right now."}) => {
  if (!rows.length) {
    return renderEmptyState(emptyTitle, emptyBody);
  }

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
};

export default {
  escapeHtml,
  renderChip,
  renderChipList,
  renderEmptyState,
  renderStatusBadge,
  renderTable
};
