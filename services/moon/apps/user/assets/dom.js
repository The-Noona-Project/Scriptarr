import {formatProgress} from "./format.js";
import {buildTitlePath} from "./routes.js";

/**
 * Escape unsafe HTML characters.
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
 * Render a metadata chip.
 *
 * @param {string} value
 * @returns {string}
 */
export const renderChip = (value) => `<span class="meta-chip">${escapeHtml(value)}</span>`;

/**
 * Render a set of chips.
 *
 * @param {string[] | null | undefined} values
 * @returns {string}
 */
export const renderChipList = (values) => Array.isArray(values) && values.length
  ? `<div class="chip-row">${values.map((value) => renderChip(value)).join("")}</div>`
  : "";

/**
 * Render an empty-state block.
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
 * Render a reusable series card.
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   latestChapter?: string,
 *   coverAccent?: string,
 *   summary?: string,
 *   author?: string,
 *   progressRatio?: number | null,
 *   href?: string
 * }} card
 * @returns {string}
 */
export const renderSeriesCard = (card) => `
  <article class="series-card" style="--accent:${escapeHtml(card.coverAccent || "#de6d3a")}">
    <a class="series-card-link" href="${escapeHtml(card.href || buildTitlePath(card.libraryTypeSlug || card.mediaType || "manga", card.id))}" data-link>
      <span class="series-card-kicker">${escapeHtml(card.latestChapter || "Library")}</span>
      <strong>${escapeHtml(card.title)}</strong>
      <p>${escapeHtml(card.summary || card.author || "Open the series details.")}</p>
      ${card.progressRatio == null ? "" : `<div class="progress-pill">${escapeHtml(formatProgress(card.progressRatio))} read</div>`}
    </a>
  </article>
`;

export default {
  escapeHtml,
  renderChip,
  renderChipList,
  renderEmptyState,
  renderSeriesCard
};
