/**
 * @file Moon reader preference normalization and compatibility helpers.
 */

const defaultReaderPreferences = Object.freeze({
  readingMode: "infinite",
  layoutMode: "webtoon",
  readingDirection: "ltr",
  pageFit: "width",
  showSidebar: false,
  showPageNumbers: true
});

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

const defaultReaderPreferencesForType = () => ({
  ...defaultReaderPreferences
});

const normalizeReaderLayoutMode = (value, fallback = "webtoon") => {
  const normalized = normalizeString(value).toLowerCase();
  if (["single", "double", "manga-double", "webtoon"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "paged") {
    return "single";
  }
  if (normalized === "infinite") {
    return "webtoon";
  }
  return fallback;
};

const readingModeForLayout = (layoutMode) => layoutMode === "webtoon" ? "infinite" : "paged";

const normalizeStoredReaderPreferenceLeaf = (value = {}) => ({
  ...(["paged", "webtoon", "infinite"].includes(normalizeString(value.readingMode).toLowerCase())
    ? {readingMode: normalizeString(value.readingMode).toLowerCase()}
    : {}),
  ...(["single", "double", "manga-double", "webtoon"].includes(normalizeString(value.layoutMode).toLowerCase())
    ? {layoutMode: normalizeString(value.layoutMode).toLowerCase()}
    : {}),
  ...(["ltr", "rtl"].includes(normalizeString(value.readingDirection).toLowerCase())
    ? {readingDirection: normalizeString(value.readingDirection).toLowerCase()}
    : {}),
  ...(["width", "contain", "height"].includes(normalizeString(value.pageFit).toLowerCase())
    ? {pageFit: normalizeString(value.pageFit).toLowerCase()}
    : {}),
  ...(typeof value.showSidebar === "boolean" ? {showSidebar: value.showSidebar} : {}),
  ...(typeof value.showPageNumbers === "boolean" ? {showPageNumbers: value.showPageNumbers} : {})
});

const normalizeReaderPreferenceLeaf = (value = {}, typeSlug = "manga") => {
  const defaults = defaultReaderPreferencesForType(typeSlug);
  const layoutMode = normalizeReaderLayoutMode(value.layoutMode || value.readingMode, defaults.layoutMode);
  return {
    readingMode: readingModeForLayout(layoutMode),
    layoutMode,
    readingDirection: ["ltr", "rtl"].includes(normalizeString(value.readingDirection).toLowerCase())
      ? normalizeString(value.readingDirection).toLowerCase()
      : defaults.readingDirection,
    pageFit: ["width", "contain", "height"].includes(normalizeString(value.pageFit).toLowerCase())
      ? normalizeString(value.pageFit).toLowerCase()
      : defaults.pageFit,
    showSidebar: typeof value.showSidebar === "boolean" ? value.showSidebar : defaults.showSidebar,
    showPageNumbers: typeof value.showPageNumbers === "boolean" ? value.showPageNumbers : defaults.showPageNumbers
  };
};

/**
 * Normalize the persisted Moon reader preference store, including legacy flat records.
 *
 * @param {unknown} value
 * @returns {{
 *   defaultPreferences: Record<string, unknown>,
 *   typePreferences: Record<string, Record<string, unknown>>,
 *   titlePreferences: Record<string, Record<string, unknown>>
 * }}
 */
export const normalizeReaderPreferenceStore = (value = {}) => {
  const legacy = value
    && !value.defaultPreferences
    && !value.typePreferences
    && !value.titlePreferences
    && ["readingMode", "layoutMode", "readingDirection", "pageFit", "showSidebar", "showPageNumbers"].some((key) => key in value)
    ? value
    : null;
  const rawTypePreferences = legacy ? {} : value?.typePreferences;
  const rawTitlePreferences = legacy ? {} : value?.titlePreferences;
  return {
    defaultPreferences: normalizeStoredReaderPreferenceLeaf(legacy || value?.defaultPreferences || {}),
    typePreferences: Object.fromEntries(Object.entries(rawTypePreferences || {}).map(([typeSlug, preferences]) => [
      normalizeTypeSlug(typeSlug),
      normalizeReaderPreferenceLeaf(preferences, typeSlug)
    ])),
    titlePreferences: Object.fromEntries(Object.entries(rawTitlePreferences || {}).map(([titleId, preferences]) => [
      normalizeString(titleId),
      normalizeStoredReaderPreferenceLeaf(preferences)
    ]).filter(([titleId]) => Boolean(titleId)))
  };
};

/**
 * Resolve effective reader preferences for a type and optional title override.
 *
 * @param {unknown} value
 * @param {string} typeSlug
 * @param {string} [titleId]
 * @returns {Record<string, unknown>}
 */
export const resolveReaderPreferences = (value, typeSlug, titleId = "") => {
  const store = normalizeReaderPreferenceStore(value);
  const normalizedType = normalizeTypeSlug(typeSlug);
  const normalizedTitleId = normalizeString(titleId);
  return normalizeReaderPreferenceLeaf({
    ...defaultReaderPreferencesForType(normalizedType),
    ...store.defaultPreferences,
    ...(store.typePreferences[normalizedType] || {}),
    ...(normalizedTitleId ? store.titlePreferences[normalizedTitleId] || {} : {})
  }, normalizedType);
};

/**
 * Merge a reader preference update into either type defaults or a title override.
 *
 * @param {unknown} currentValue
 * @param {string} typeSlug
 * @param {Record<string, unknown>} nextValue
 * @returns {ReturnType<typeof normalizeReaderPreferenceStore>}
 */
export const mergeReaderPreferences = (currentValue, typeSlug, nextValue) => {
  const store = normalizeReaderPreferenceStore(currentValue);
  const normalizedType = normalizeTypeSlug(typeSlug);
  const normalizedTitleId = normalizeString(nextValue?.titleId);
  if (normalizedTitleId) {
    return {
      ...store,
      titlePreferences: {
        ...store.titlePreferences,
        [normalizedTitleId]: normalizeStoredReaderPreferenceLeaf(normalizeReaderPreferenceLeaf(nextValue, normalizedType))
      }
    };
  }
  return {
    ...store,
    typePreferences: {
      ...store.typePreferences,
      [normalizedType]: normalizeReaderPreferenceLeaf(nextValue, normalizedType)
    }
  };
};

export default {
  mergeReaderPreferences,
  normalizeReaderPreferenceStore,
  resolveReaderPreferences
};
