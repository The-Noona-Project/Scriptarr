/**
 * @file Route catalog for the Next-based Moon admin foundation.
 */

/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   title: string,
 *   description: string,
 *   navLabel: string,
 *   group: string,
 *   domain?: string,
 *   ported?: boolean,
 *   hidden?: boolean,
 *   params?: Record<string, string>
 * }} AdminRoute
 */

/**
 * Flat list of navigable Moon admin routes.
 *
 * @type {AdminRoute[]}
 */
export const adminRoutes = [
  {id: "overview", path: "/admin", title: "Overview", description: "Service health, queue pressure, and moderation at a glance.", navLabel: "Overview", group: "Manage", domain: "overview", ported: true},
  {id: "library", path: "/admin/library", title: "Library", description: "Tracked manga, webtoons, and comics with metadata and download status.", navLabel: "Library", group: "Manage", domain: "library", ported: true},
  {id: "add", path: "/admin/add", title: "Add Title", description: "Search sources and queue new titles into Raven.", navLabel: "Add Title", group: "Manage", domain: "add", ported: true},
  {id: "import", path: "/admin/import", title: "Import Library", description: "Scan existing storage and prep import work.", navLabel: "Import", group: "Manage", domain: "import", ported: true},
  {id: "calendar", path: "/admin/calendar", title: "Calendar", description: "Upcoming chapter releases and recent library drops.", navLabel: "Calendar", group: "Monitor", domain: "calendar", ported: true},
  {id: "activity-queue", path: "/admin/activity/queue", title: "Queue", description: "Current Raven download work in flight.", navLabel: "Queue", group: "Activity", domain: "activity", ported: true},
  {id: "activity-history", path: "/admin/activity/history", title: "History", description: "Completed and failed Raven task history.", navLabel: "History", group: "Activity", domain: "activity", ported: true},
  {id: "activity-blocklist", path: "/admin/activity/blocklist", title: "Blocklist", description: "Denied and blocked requests that Raven should not retry.", navLabel: "Blocklist", group: "Activity", domain: "activity", ported: true},
  {id: "wanted-missing", path: "/admin/wanted/missing-chapters", title: "Missing Chapters", description: "Tracked titles that still have chapter gaps.", navLabel: "Missing Chapters", group: "Wanted", domain: "wanted", ported: true},
  {id: "wanted-metadata", path: "/admin/wanted/metadata", title: "Metadata", description: "Titles that still need better provider coverage, summaries, aliases, tags, or covers.", navLabel: "Metadata", group: "Wanted", domain: "wanted", ported: true},
  {id: "requests", path: "/admin/requests", title: "Requests", description: "Moderate Moon and Discord requests from one queue.", navLabel: "Requests", group: "Community", domain: "requests", ported: true},
  {id: "users", path: "/admin/users", title: "Users", description: "Groups, permissions, and Discord-linked members.", navLabel: "Users", group: "Community", domain: "users", ported: true},
  {id: "discord", path: "/admin/discord", title: "Discord", description: "Guild workflow settings, slash-command access, onboarding, and Portal runtime status.", navLabel: "Discord", group: "System", domain: "discord", ported: true},
  {id: "mediamanagement", path: "/admin/mediamanagement", title: "Media Management", description: "Per-type naming formats and Raven file-management rules for every download.", navLabel: "Media Management", group: "System", domain: "mediamanagement", ported: true},
  {id: "settings", path: "/admin/settings", title: "Settings", description: "Branding, Raven VPN, metadata providers, and request workflow settings.", navLabel: "Settings", group: "System", domain: "settings", ported: true},
  {id: "settings-database", path: "/admin/settings/database", title: "Database Explorer", description: "Vault-owned database tables, sizes, redacted rows, and safe settings edits.", navLabel: "Database", group: "System", domain: "database", ported: true, hidden: true},
  {id: "system-api", path: "/admin/system/api", title: "API", description: "Public Moon API access, admin automation key, and Swagger docs.", navLabel: "API", group: "System", domain: "publicapi", ported: true},
  {id: "system-status", path: "/admin/system/status", title: "System Status", description: "Grouped endpoint registry, GET probes, and service health.", navLabel: "Status", group: "System", domain: "system", ported: true},
  {id: "system-tasks", path: "/admin/system/tasks", title: "Tasks", description: "Cron-driven allowlisted maintenance jobs and recent runs.", navLabel: "Tasks", group: "System", domain: "system", ported: true},
  {id: "system-ai", path: "/admin/system/ai", title: "AI", description: "Oracle and LocalAI settings, runtime state, and test prompts.", navLabel: "AI", group: "System", domain: "system", ported: true},
  {id: "system-updates", path: "/admin/system/updates", title: "Updates", description: "Current image tags and published channels.", navLabel: "Updates", group: "System", domain: "system", ported: true},
  {id: "system-events", path: "/admin/system/events", title: "Events", description: "Recent moderation and service timeline activity.", navLabel: "Events", group: "System", domain: "system", ported: true},
  {id: "system-logs", path: "/admin/system/logs", title: "Logs", description: "Sanitized operational log summaries for Scriptarr services.", navLabel: "Logs", group: "System", domain: "system", ported: true}
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
    routes: adminRoutes.filter((route) => route.group === label && !route.hidden)
  }))
  .filter((group) => group.routes.length > 0);

/**
 * Resolve an admin pathname into a known admin route.
 *
 * @param {string} pathname
 * @returns {AdminRoute}
 */
export const matchAdminRoute = (pathname) => {
  const normalizedPathname = String(pathname || "/admin").replace(/\/+$/, "") || "/admin";
  if (normalizedPathname === "/admin/wanted/metadata-gaps") {
    return adminRoutes.find((route) => route.id === "wanted-metadata");
  }
  const staticRoute = adminRoutes.find((route) => route.path === normalizedPathname);
  if (staticRoute) {
    return staticRoute;
  }

  const libraryTitleMatch = normalizedPathname.match(/^\/admin\/library\/([^/]+)\/([^/]+)$/);
  if (libraryTitleMatch) {
    return {
      id: "library-title",
      path: normalizedPathname,
      title: "Title Detail",
      description: "Inspect title health, chapter releases, metadata state, and Raven file coverage.",
      navLabel: "Library",
      group: "Manage",
      domain: "library",
      params: {
        typeSlug: decodeURIComponent(libraryTitleMatch[1]),
        titleId: decodeURIComponent(libraryTitleMatch[2])
      }
    };
  }

  return {
    id: "not-found",
    path: normalizedPathname,
    title: "Admin Route",
    description: "This admin route is not in the Moon route catalog yet.",
    navLabel: "Admin Route",
    group: "Manage",
    domain: "overview"
  };
};

export default {
  adminRoutes,
  buildAdminLibraryTitlePath,
  getAdminNavigationGroups,
  matchAdminRoute
};
