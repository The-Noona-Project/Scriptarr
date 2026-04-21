/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   title: string,
 *   description: string,
 *   navLabel: string,
 *   group: string,
 *   params?: Record<string, string>
 * }} AdminRoute
 */

/**
 * Flat list of navigable Moon admin routes.
 *
 * @type {AdminRoute[]}
 */
export const adminRoutes = [
  {id: "overview", path: "/admin", title: "Overview", description: "Service health, queue pressure, and moderation at a glance.", navLabel: "Overview", group: "Manage"},
  {id: "library", path: "/admin/library", title: "Library", description: "Tracked manga, webtoons, and comics with metadata and download status.", navLabel: "Library", group: "Manage"},
  {id: "add", path: "/admin/add", title: "Add Title", description: "Search sources and queue new titles into Raven.", navLabel: "Add Title", group: "Manage"},
  {id: "import", path: "/admin/import", title: "Import Library", description: "Scan existing storage and prep import work.", navLabel: "Import Library", group: "Manage"},
  {id: "calendar", path: "/admin/calendar", title: "Calendar", description: "Upcoming chapter releases and recent library drops.", navLabel: "Calendar", group: "Monitor"},
  {id: "activity-queue", path: "/admin/activity/queue", title: "Queue", description: "Current Raven download work in flight.", navLabel: "Queue", group: "Activity"},
  {id: "activity-history", path: "/admin/activity/history", title: "History", description: "Completed and failed Raven task history.", navLabel: "History", group: "Activity"},
  {id: "activity-blocklist", path: "/admin/activity/blocklist", title: "Blocklist", description: "Denied and blocked requests that Raven should not retry.", navLabel: "Blocklist", group: "Activity"},
  {id: "wanted-missing", path: "/admin/wanted/missing-chapters", title: "Missing Chapters", description: "Tracked titles that still have chapter gaps.", navLabel: "Missing Chapters", group: "Wanted"},
  {id: "wanted-metadata", path: "/admin/wanted/metadata-gaps", title: "Metadata Gaps", description: "Titles that still need better provider coverage or summaries.", navLabel: "Metadata Gaps", group: "Wanted"},
  {id: "requests", path: "/admin/requests", title: "Requests", description: "Moderate Moon and Discord requests from one queue.", navLabel: "Requests", group: "Community"},
  {id: "users", path: "/admin/users", title: "Users", description: "Roles, permissions, and Discord-linked members.", navLabel: "Users", group: "Community"},
  {id: "discord", path: "/admin/discord", title: "Discord", description: "Guild workflow settings, slash-command access, onboarding, and Portal runtime status.", navLabel: "Discord", group: "System"},
  {id: "mediamanagement", path: "/admin/mediamanagement", title: "Media Management", description: "Per-type naming formats and Raven file-management rules for every download.", navLabel: "Media Management", group: "System"},
  {id: "settings", path: "/admin/settings", title: "Settings", description: "Branding, Raven VPN, metadata providers, Oracle, and LocalAI runtime controls.", navLabel: "Settings", group: "System"},
  {id: "system-api", path: "/admin/system/api", title: "API", description: "Public Moon API access, admin automation key, and Swagger docs.", navLabel: "API", group: "System"},
  {id: "system-status", path: "/admin/system/status", title: "System Status", description: "Warden runtime, bootstrap plan, and service health.", navLabel: "Status", group: "System"},
  {id: "system-tasks", path: "/admin/system/tasks", title: "Tasks", description: "Pending request load and active processing queues.", navLabel: "Tasks", group: "System"},
  {id: "system-updates", path: "/admin/system/updates", title: "Updates", description: "Current image tags and published channels.", navLabel: "Updates", group: "System"},
  {id: "system-events", path: "/admin/system/events", title: "Events", description: "Recent moderation and service timeline activity.", navLabel: "Events", group: "System"},
  {id: "system-logs", path: "/admin/system/logs", title: "Logs", description: "Sanitized operational log summaries for Scriptarr services.", navLabel: "Logs", group: "System"}
];

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
 * Build a canonical admin library title path.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @returns {string}
 */
export const buildAdminLibraryTitlePath = (typeSlug, titleId) =>
  `/admin/library/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}`;

/**
 * Ordered admin navigation groups.
 *
 * @returns {{label: string, routes: AdminRoute[]}[]}
 */
export const getAdminNavigationGroups = () => ["Manage", "Monitor", "Activity", "Wanted", "Community", "System"]
  .map((label) => ({
    label,
    routes: adminRoutes.filter((route) => route.group === label)
  }))
  .filter((group) => group.routes.length > 0);

/**
 * Resolve the current location pathname into a known admin route.
 *
 * @param {string} pathname
 * @returns {AdminRoute}
 */
export const matchAdminRoute = (pathname) => {
  const staticRoute = adminRoutes.find((route) => route.path === pathname);
  if (staticRoute) {
    return staticRoute;
  }

  const libraryTitleMatch = pathname.match(/^\/admin\/library\/([^/]+)\/([^/]+)$/);
  if (libraryTitleMatch) {
    return {
      id: "library-title",
      path: pathname,
      title: "Series Detail",
      description: "Inspect title health, chapter releases, metadata state, and Raven file coverage.",
      navLabel: "Library",
      group: "Manage",
      params: {
        typeSlug: decodeURIComponent(libraryTitleMatch[1]),
        titleId: decodeURIComponent(libraryTitleMatch[2])
      }
    };
  }

  return adminRoutes[0];
};

export default {
  adminRoutes,
  buildAdminLibraryTitlePath,
  getAdminNavigationGroups,
  matchAdminRoute
};
