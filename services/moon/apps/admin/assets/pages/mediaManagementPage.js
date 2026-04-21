import {escapeHtml, renderEmptyState} from "../dom.js";

const DEFAULT_PROFILE = Object.freeze({
  chapterTemplate: "{title} c{chapter_padded} (v{volume_padded}) [Scriptarr].cbz",
  pageTemplate: "{page_padded}{ext}",
  pagePad: 3,
  chapterPad: 3,
  volumePad: 2
});

const TYPE_LABELS = Object.freeze({
  manga: "Manga",
  manhwa: "Manhwa",
  manhua: "Manhua",
  webtoon: "Webtoon",
  comic: "Comic",
  oel: "OEL"
});

const SAMPLE_TITLES = Object.freeze({
  manga: "Blue Box",
  manhwa: "Solo Leveling",
  manhua: "The King",
  webtoon: "Tower of God",
  comic: "Batman Year One",
  oel: "Radiant"
});

/**
 * Normalize an incoming naming profile payload.
 *
 * @param {Record<string, unknown> | null | undefined} value
 * @param {typeof DEFAULT_PROFILE} [fallback]
 * @returns {typeof DEFAULT_PROFILE}
 */
const normalizeProfile = (value, fallback = DEFAULT_PROFILE) => {
  const source = value && typeof value === "object" ? value : {};
  const pagePad = Number.parseInt(String(source.pagePad ?? fallback.pagePad), 10);
  const chapterPad = Number.parseInt(String(source.chapterPad ?? fallback.chapterPad), 10);
  const volumePad = Number.parseInt(String(source.volumePad ?? fallback.volumePad), 10);
  return {
    chapterTemplate: String(source.chapterTemplate || fallback.chapterTemplate).trim() || fallback.chapterTemplate,
    pageTemplate: String(source.pageTemplate || fallback.pageTemplate).trim() || fallback.pageTemplate,
    pagePad: Number.isInteger(pagePad) && pagePad > 0 ? pagePad : fallback.pagePad,
    chapterPad: Number.isInteger(chapterPad) && chapterPad > 0 ? chapterPad : fallback.chapterPad,
    volumePad: Number.isInteger(volumePad) && volumePad > 0 ? volumePad : fallback.volumePad
  };
};

/**
 * Normalize the full naming settings payload into stable profile objects.
 *
 * @param {Record<string, unknown> | null | undefined} value
 * @returns {{
 *   chapterTemplate: string,
 *   pageTemplate: string,
 *   pagePad: number,
 *   chapterPad: number,
 *   volumePad: number,
 *   profiles: Record<string, typeof DEFAULT_PROFILE>
 * }}
 */
const normalizeNamingSettings = (value) => {
  const defaults = normalizeProfile(value, DEFAULT_PROFILE);
  const rawProfiles = value && typeof value === "object" && value.profiles && typeof value.profiles === "object"
    ? value.profiles
    : {};
  const profiles = Object.fromEntries(Object.entries(TYPE_LABELS).map(([typeId]) => [
    typeId,
    normalizeProfile(rawProfiles[typeId], defaults)
  ]));
  return {
    ...defaults,
    profiles
  };
};

/**
 * Apply a Raven naming template to sample values for UI preview.
 *
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
const applyTemplate = (template, values) => String(template || "")
  .replaceAll(/\{([a-z_]+)\}/g, (_match, token) => values[token] || "")
  .replaceAll(/\s+\(\s*v\s*\)/gi, "")
  .replaceAll(/\s{2,}/g, " ")
  .trim();

/**
 * Build sample preview values for a type naming profile.
 *
 * @param {string} typeId
 * @param {typeof DEFAULT_PROFILE} profile
 * @returns {{chapterName: string, pageName: string}}
 */
const buildPreview = (typeId, profile) => {
  const chapterPadded = String(12).padStart(profile.chapterPad, "0");
  const pagePadded = String(5).padStart(profile.pagePad, "0");
  const volumePadded = String(3).padStart(profile.volumePad, "0");
  const values = {
    title: SAMPLE_TITLES[typeId] || TYPE_LABELS[typeId] || "Scriptarr Title",
    type: TYPE_LABELS[typeId] || "Manga",
    type_slug: typeId,
    chapter: "12",
    chapter_padded: chapterPadded,
    volume: "3",
    volume_padded: volumePadded,
    pages: "28",
    domain: "weebcentral.com",
    page: "5",
    page_padded: pagePadded,
    ext: ".jpg"
  };

  const chapterName = applyTemplate(profile.chapterTemplate, values);
  const pageName = applyTemplate(profile.pageTemplate, values);
  return {
    chapterName: chapterName.toLowerCase().endsWith(".cbz") ? chapterName : `${chapterName}.cbz`,
    pageName: pageName.includes(".") ? pageName : `${pageName}.jpg`
  };
};

/**
 * Render a single per-type naming profile card.
 *
 * @param {string} typeId
 * @param {string} label
 * @param {typeof DEFAULT_PROFILE} profile
 * @returns {string}
 */
const renderProfileCard = (typeId, label, profile) => {
  const preview = buildPreview(typeId, profile);
  return `
    <article class="naming-profile-card" data-profile-id="${escapeHtml(typeId)}">
      <div class="list-card-head">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <p>Use a dedicated archive and page format for ${escapeHtml(label.toLowerCase())} downloads and rescans.</p>
        </div>
      </div>
      <div class="settings-form">
        <label class="wide-field">
          <span>Chapter archive format</span>
          <input type="text" data-profile-chapter-template value="${escapeHtml(profile.chapterTemplate)}">
        </label>
        <label class="wide-field">
          <span>Page image format</span>
          <input type="text" data-profile-page-template value="${escapeHtml(profile.pageTemplate)}">
        </label>
        <div class="naming-pad-grid">
          <label class="compact-field">
            <span>Chapter pad</span>
            <input type="number" min="1" step="1" data-profile-chapter-pad value="${escapeHtml(profile.chapterPad)}">
          </label>
          <label class="compact-field">
            <span>Page pad</span>
            <input type="number" min="1" step="1" data-profile-page-pad value="${escapeHtml(profile.pagePad)}">
          </label>
          <label class="compact-field">
            <span>Volume pad</span>
            <input type="number" min="1" step="1" data-profile-volume-pad value="${escapeHtml(profile.volumePad)}">
          </label>
        </div>
      </div>
      <div class="naming-preview">
        <span class="section-kicker">Preview</span>
        <div><strong>Archive</strong><code>${escapeHtml(preview.chapterName)}</code></div>
        <div><strong>Page</strong><code>${escapeHtml(preview.pageName)}</code></div>
      </div>
    </article>
  `;
};

/**
 * Load the media management settings payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadMediaManagementPage = ({api}) => api.get("/api/moon/v3/admin/settings");

/**
 * Render the Moon admin media management page.
 *
 * @param {Awaited<ReturnType<typeof loadMediaManagementPage>>} result
 * @returns {string}
 */
export const renderMediaManagementPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Media management unavailable", result.payload?.error || "Unable to load Raven naming settings.");
  }

  const naming = normalizeNamingSettings(result.payload?.naming);
  const fallbackPreview = buildPreview("manga", naming);

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Media management</span>
          <h2>Type-based naming profiles</h2>
          <p class="field-note">These formats apply to every new Raven download and every archive rescan, so Moon, Raven, and the file layout all stay in sync.</p>
        </div>
        <button class="solid-button" type="submit" form="media-management-form">Save naming profiles</button>
      </div>
      <form id="media-management-form" class="page-form">
        <section class="callout subtle">
          <strong>Global fallback profile</strong>
          <p>Each type profile starts from this fallback. Leave a type-specific field blank and Scriptarr will keep using the fallback values.</p>
        </section>
        <div class="settings-form three-column">
          <label class="wide-field">
            <span>Fallback chapter archive format</span>
            <input type="text" id="naming-default-chapter-template" value="${escapeHtml(naming.chapterTemplate)}">
          </label>
          <label class="wide-field">
            <span>Fallback page image format</span>
            <input type="text" id="naming-default-page-template" value="${escapeHtml(naming.pageTemplate)}">
          </label>
          <label class="compact-field">
            <span>Fallback chapter pad</span>
            <input type="number" min="1" step="1" id="naming-default-chapter-pad" value="${escapeHtml(naming.chapterPad)}">
          </label>
          <label class="compact-field">
            <span>Fallback page pad</span>
            <input type="number" min="1" step="1" id="naming-default-page-pad" value="${escapeHtml(naming.pagePad)}">
          </label>
          <label class="compact-field">
            <span>Fallback volume pad</span>
            <input type="number" min="1" step="1" id="naming-default-volume-pad" value="${escapeHtml(naming.volumePad)}">
          </label>
        </div>
        <div class="callout subtle">
          <strong>Fallback preview</strong>
          <p><code>${escapeHtml(fallbackPreview.chapterName)}</code></p>
          <p><code>${escapeHtml(fallbackPreview.pageName)}</code></p>
        </div>
        <section class="panel-subsection">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Profiles</span>
              <h2>Per-type download naming</h2>
            </div>
          </div>
          <div class="naming-profile-grid">
            ${Object.entries(TYPE_LABELS).map(([typeId, label]) => renderProfileCard(typeId, label, naming.profiles[typeId])).join("")}
          </div>
        </section>
        <section class="callout subtle">
          <strong>Supported tokens</strong>
          <p><code>{title}</code>, <code>{type}</code>, <code>{type_slug}</code>, <code>{chapter}</code>, <code>{chapter_padded}</code>, <code>{volume}</code>, <code>{volume_padded}</code>, <code>{pages}</code>, <code>{domain}</code>, <code>{page}</code>, <code>{page_padded}</code>, <code>{ext}</code></p>
        </section>
        <div class="action-row">
          <button class="solid-button" type="submit">Save naming profiles</button>
        </div>
      </form>
    </section>
  `;
};

/**
 * Wire the media management form actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceMediaManagementPage = async (root, {api, rerender, setFlash}) => {
  root.querySelector("#media-management-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      chapterTemplate: root.querySelector("#naming-default-chapter-template")?.value || DEFAULT_PROFILE.chapterTemplate,
      pageTemplate: root.querySelector("#naming-default-page-template")?.value || DEFAULT_PROFILE.pageTemplate,
      chapterPad: Number.parseInt(root.querySelector("#naming-default-chapter-pad")?.value || `${DEFAULT_PROFILE.chapterPad}`, 10),
      pagePad: Number.parseInt(root.querySelector("#naming-default-page-pad")?.value || `${DEFAULT_PROFILE.pagePad}`, 10),
      volumePad: Number.parseInt(root.querySelector("#naming-default-volume-pad")?.value || `${DEFAULT_PROFILE.volumePad}`, 10),
      profiles: Object.fromEntries(Array.from(root.querySelectorAll("[data-profile-id]")).map((node) => [
        node.dataset.profileId,
        {
          chapterTemplate: node.querySelector("[data-profile-chapter-template]")?.value || DEFAULT_PROFILE.chapterTemplate,
          pageTemplate: node.querySelector("[data-profile-page-template]")?.value || DEFAULT_PROFILE.pageTemplate,
          chapterPad: Number.parseInt(node.querySelector("[data-profile-chapter-pad]")?.value || `${DEFAULT_PROFILE.chapterPad}`, 10),
          pagePad: Number.parseInt(node.querySelector("[data-profile-page-pad]")?.value || `${DEFAULT_PROFILE.pagePad}`, 10),
          volumePad: Number.parseInt(node.querySelector("[data-profile-volume-pad]")?.value || `${DEFAULT_PROFILE.volumePad}`, 10)
        }
      ]))
    };

    const response = await api.put("/api/moon/admin/settings/raven/naming", payload);
    setFlash(
      response.ok ? "good" : "bad",
      response.ok ? "Raven naming profiles saved." : response.payload?.error || "Unable to save Raven naming profiles."
    );
    await rerender();
  });
};

export default {
  loadMediaManagementPage,
  renderMediaManagementPage,
  enhanceMediaManagementPage
};
