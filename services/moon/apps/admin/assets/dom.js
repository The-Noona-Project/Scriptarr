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
 * Render a small title-cover thumbnail when art is available.
 *
 * @param {string | null | undefined} url
 * @param {string | null | undefined} title
 * @param {string} [className]
 * @returns {string}
 */
export const renderCoverThumb = (url, title, className = "cover-thumb") => {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    return `<span class="${escapeHtml(`${className} is-empty`)}" aria-hidden="true">${escapeHtml((title || "?").trim().slice(0, 1) || "?")}</span>`;
  }

  return `
    <span class="${escapeHtml(className)}">
      <img src="${escapeHtml(normalizedUrl)}" alt="${escapeHtml(title || "Title cover")}" loading="lazy" referrerpolicy="no-referrer">
    </span>
  `;
};

const resolveInitials = (value) => {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join("");
};

/**
 * Render a compact avatar with a Discord image or initials fallback.
 *
 * @param {string | null | undefined} name
 * @param {string | null | undefined} url
 * @param {string} [className]
 * @returns {string}
 */
export const renderAvatar = (name, url, className = "session-avatar") => {
  const normalizedUrl = String(url || "").trim();
  const initials = resolveInitials(name);
  return normalizedUrl
    ? `
      <span class="${escapeHtml(`${className} has-image`)}" aria-hidden="true">
        <img src="${escapeHtml(normalizedUrl)}" alt="${escapeHtml(name || "Discord avatar")}" loading="lazy" referrerpolicy="no-referrer">
      </span>
    `
    : `<span class="${escapeHtml(`${className} is-fallback`)}" aria-hidden="true">${escapeHtml(initials)}</span>`;
};

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
  renderAvatar,
  renderChip,
  renderChipList,
  renderCoverThumb,
  renderEmptyState,
  renderStatusBadge,
  renderTable
};
