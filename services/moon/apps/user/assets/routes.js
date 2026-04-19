/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   title: string,
 *   description: string,
 *   navLabel: string
 * }} UserStaticRoute
 */

/**
 * Static Moon user routes.
 *
 * @type {UserStaticRoute[]}
 */
const staticRoutes = [
  {id: "home", path: "/", title: "Home", description: "Continue reading, latest arrivals, and current requests.", navLabel: "Home"},
  {id: "browse", path: "/browse", title: "Browse", description: "Browse the library by title, type, and metadata.", navLabel: "Browse"},
  {id: "library", path: "/library", title: "Library", description: "The complete Scriptarr library view.", navLabel: "Library"},
  {id: "requests", path: "/myrequests", title: "My Requests", description: "Track your Moon and Discord requests in one place.", navLabel: "My Requests"},
  {id: "following", path: "/following", title: "Following", description: "Keep up with titles you want Moon to surface first.", navLabel: "Following"}
];

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
 *   params: Record<string, string>
 * }}
 */
export const matchUserRoute = (pathname) => {
  const staticMatch = staticRoutes.find((route) => route.path === pathname);
  if (staticMatch) {
    return {...staticMatch, params: {}};
  }

  const titleMatch = pathname.match(/^\/title\/([^/]+)$/);
  if (titleMatch) {
    return {
      id: "title",
      path: pathname,
      title: "Series Detail",
      description: "Read metadata, follow the title, and jump into a chapter.",
      params: {titleId: decodeURIComponent(titleMatch[1])}
    };
  }

  const readerMatch = pathname.match(/^\/reader\/([^/]+)\/([^/]+)$/);
  if (readerMatch) {
    return {
      id: "reader",
      path: pathname,
      title: "Reader",
      description: "Native Moon reading with bookmarks, progress, and display preferences.",
      params: {
        titleId: decodeURIComponent(readerMatch[1]),
        chapterId: decodeURIComponent(readerMatch[2])
      }
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
  getPrimaryUserRoutes,
  matchUserRoute
};
