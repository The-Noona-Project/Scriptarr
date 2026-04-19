import {loadActivityPage, renderActivityPage} from "./activityPage.js";
import {enhanceAddPage, loadAddPage, renderAddPage} from "./addPage.js";
import {loadCalendarPage, renderCalendarPage} from "./calendarPage.js";
import {loadImportPage, renderImportPage} from "./importPage.js";
import {loadLibraryPage, renderLibraryPage} from "./libraryPage.js";
import {loadOverviewPage, renderOverviewPage} from "./overviewPage.js";
import {enhanceRequestsPage, loadRequestsPage, renderRequestsPage} from "./requestsPage.js";
import {enhanceSettingsPage, loadSettingsPage, renderSettingsPage} from "./settingsPage.js";
import {enhanceSystemPage, loadSystemPage, renderSystemPage} from "./systemPage.js";
import {loadUsersPage, renderUsersPage} from "./usersPage.js";
import {loadWantedPage, renderWantedPage} from "./wantedPage.js";

/**
 * @typedef {{
 *   load: (context: any) => Promise<any>,
 *   render: (result: any) => string,
 *   enhance?: (root: HTMLElement, context: any, result: any) => Promise<void>
 * }} AdminPageModule
 */

/**
 * Registry of route ids to admin page modules.
 *
 * @type {Record<string, AdminPageModule>}
 */
const pageModules = {
  overview: {load: loadOverviewPage, render: renderOverviewPage},
  library: {load: loadLibraryPage, render: renderLibraryPage},
  add: {load: loadAddPage, render: renderAddPage, enhance: enhanceAddPage},
  import: {load: loadImportPage, render: renderImportPage},
  calendar: {load: loadCalendarPage, render: renderCalendarPage},
  "activity-queue": {load: loadActivityPage, render: renderActivityPage},
  "activity-history": {load: loadActivityPage, render: renderActivityPage},
  "activity-blocklist": {load: loadActivityPage, render: renderActivityPage},
  "wanted-missing": {load: loadWantedPage, render: renderWantedPage},
  "wanted-metadata": {load: loadWantedPage, render: renderWantedPage},
  requests: {load: loadRequestsPage, render: renderRequestsPage, enhance: enhanceRequestsPage},
  users: {load: loadUsersPage, render: renderUsersPage},
  settings: {load: loadSettingsPage, render: renderSettingsPage, enhance: enhanceSettingsPage},
  "system-status": {load: loadSystemPage, render: renderSystemPage, enhance: enhanceSystemPage},
  "system-tasks": {load: loadSystemPage, render: renderSystemPage, enhance: enhanceSystemPage},
  "system-updates": {load: loadSystemPage, render: renderSystemPage, enhance: enhanceSystemPage},
  "system-events": {load: loadSystemPage, render: renderSystemPage, enhance: enhanceSystemPage},
  "system-logs": {load: loadSystemPage, render: renderSystemPage, enhance: enhanceSystemPage}
};

/**
 * Load a page payload for the active route.
 *
 * @param {import("../routes.js").AdminRoute} route
 * @param {any} context
 * @returns {Promise<any>}
 */
export const loadAdminPage = (route, context) => pageModules[route.id].load({...context, route});

/**
 * Render a page payload into HTML.
 *
 * @param {import("../routes.js").AdminRoute} route
 * @param {any} result
 * @returns {string}
 */
export const renderAdminPage = (route, result) => pageModules[route.id].render(result);

/**
 * Run any page-specific enhancement hooks after the shell has rendered.
 *
 * @param {import("../routes.js").AdminRoute} route
 * @param {HTMLElement} root
 * @param {any} context
 * @param {any} result
 * @returns {Promise<void>}
 */
export const enhanceAdminPage = async (route, root, context, result) => {
  const pageModule = pageModules[route.id];
  if (typeof pageModule.enhance === "function") {
    await pageModule.enhance(root, context, result);
  }
};

export default {
  loadAdminPage,
  renderAdminPage,
  enhanceAdminPage
};
