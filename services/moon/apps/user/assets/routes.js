/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   title: string,
 *   description: string,
 *   navLabel: string
 * }} UserStaticRoute
 */

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

/**
 * Static Moon user routes.
 *
 * @type {UserStaticRoute[]}
 */
const staticRoutes = [
  {id: "home", path: "/", title: "Home", description: "Continue reading, latest arrivals, and current requests.", navLabel: "Home"},
  {id: "browse", path: "/browse", title: "Browse", description: "Browse the library by title, type, and metadata.", navLabel: "Browse"},
  {id: "library", path: "/library", title: "Library", description: "Read the library by title type.", navLabel: "Library"},
  {id: "requests", path: "/myrequests", title: "My Requests", description: "Track your Moon and Discord requests in one place.", navLabel: "My Requests"},
  {id: "following", path: "/following", title: "Following", description: "Keep up with titles you want Moon to surface first.", navLabel: "Following"}
];

/**
 * Build a canonical type-scoped library path.
 *
 * @param {string} [typeSlug]
 * @returns {string}
 */
export const buildLibraryPath = (typeSlug = "manga") => `/library/${encodeURIComponent(normalizeTypeSlug(typeSlug))}`;

/**
 * Build a canonical type-scoped title path.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @returns {string}
 */
export const buildTitlePath = (typeSlug, titleId) =>
  `/title/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}`;

/**
 * Build a canonical type-scoped reader path.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @param {string} chapterId
 * @returns {string}
 */
export const buildReaderPath = (typeSlug, titleId, chapterId) =>
  `/reader/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}/${encodeURIComponent(String(chapterId || "").trim())}`;

/**
 * Resolve a title-like payload into Moon's canonical type slug.
 *
 * @param {{libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @returns {string}
 */
export const resolveTitleTypeSlug = (title) => normalizeTypeSlug(title?.libraryTypeSlug || title?.mediaType);

/**
 * Resolve the canonical title path for a title payload.
 *
 * @param {{id?: string, libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @returns {string}
 */
export const buildTitlePathForTitle = (title) => buildTitlePath(resolveTitleTypeSlug(title), title?.id || "");

/**
 * Resolve the canonical reader path for a title payload and chapter id.
 *
 * @param {{id?: string, libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @param {string} chapterId
 * @returns {string}
 */
export const buildReaderPathForTitle = (title, chapterId) => buildReaderPath(resolveTitleTypeSlug(title), title?.id || "", chapterId);

/**
 * Resolve a pathname into the current Moon user route.
 *
 * @param {string} pathname
 * @returns {{
 *   id: string,
 *   path: string,
 *   title: string,
 *   description: string,
 *   navLabel?: string,
 *   params: Record<string, string>,
 *   legacy?: boolean
 * }}
 */
export const matchUserRoute = (pathname) => {
  const staticMatch = staticRoutes.find((route) => route.path === pathname);
  if (staticMatch) {
    return {...staticMatch, params: {}};
  }

  const libraryMatch = pathname.match(/^\/library(?:\/([^/]+))?$/);
  if (libraryMatch) {
    const typeSlug = libraryMatch[1] ? decodeURIComponent(libraryMatch[1]) : "";
    return {
      id: "library",
      path: pathname,
      title: "Library",
      description: typeSlug
        ? `Read the ${normalizeTypeSlug(typeSlug)} library.`
        : "Read the library by title type.",
      params: {typeSlug}
    };
  }

  const typedTitleMatch = pathname.match(/^\/title\/([^/]+)\/([^/]+)$/);
  if (typedTitleMatch) {
    return {
      id: "title",
      path: pathname,
      title: "Series Detail",
      description: "Read metadata, follow the title, and jump into a chapter.",
      params: {
        typeSlug: decodeURIComponent(typedTitleMatch[1]),
        titleId: decodeURIComponent(typedTitleMatch[2])
      }
    };
  }

  const legacyTitleMatch = pathname.match(/^\/title\/([^/]+)$/);
  if (legacyTitleMatch) {
    return {
      id: "title",
      path: pathname,
      title: "Series Detail",
      description: "Read metadata, follow the title, and jump into a chapter.",
      params: {titleId: decodeURIComponent(legacyTitleMatch[1]), typeSlug: ""},
      legacy: true
    };
  }

  const typedReaderMatch = pathname.match(/^\/reader\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (typedReaderMatch) {
    return {
      id: "reader",
      path: pathname,
      title: "Reader",
      description: "Native Moon reading with bookmarks, progress, and display preferences.",
      params: {
        typeSlug: decodeURIComponent(typedReaderMatch[1]),
        titleId: decodeURIComponent(typedReaderMatch[2]),
        chapterId: decodeURIComponent(typedReaderMatch[3])
      }
    };
  }

  const legacyReaderMatch = pathname.match(/^\/reader\/([^/]+)\/([^/]+)$/);
  if (legacyReaderMatch) {
    return {
      id: "reader",
      path: pathname,
      title: "Reader",
      description: "Native Moon reading with bookmarks, progress, and display preferences.",
      params: {
        titleId: decodeURIComponent(legacyReaderMatch[1]),
        chapterId: decodeURIComponent(legacyReaderMatch[2]),
        typeSlug: ""
      },
      legacy: true
    };
  }

  return {...staticRoutes[0], params: {}};
};

/**
 * Return the primary user navigation list.
 *
 * @returns {UserStaticRoute[]}
 */
export const getPrimaryUserRoutes = () => staticRoutes;

export default {
  buildLibraryPath,
  buildReaderPath,
  buildReaderPathForTitle,
  buildTitlePath,
  buildTitlePathForTitle,
  getPrimaryUserRoutes,
  matchUserRoute,
  resolveTitleTypeSlug
};
