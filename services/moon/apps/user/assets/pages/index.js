import {enhanceBrowsePage, loadBrowsePage, renderBrowsePage} from "./browsePage.js";
import {loadFollowingPage, renderFollowingPage} from "./followingPage.js";
import {loadHomePage, renderHomePage} from "./homePage.js";
import {enhanceReaderPage, loadReaderPage, renderReaderPage} from "./readerPage.js";
import {enhanceRequestsPage, loadRequestsPage, renderRequestsPage} from "./requestsPage.js";
import {enhanceTitlePage, loadTitlePage, renderTitlePage} from "./titlePage.js";

/**
 * @typedef {{
 *   load: (context: any) => Promise<any>,
 *   render: (result: any) => string,
 *   enhance?: (root: HTMLElement, context: any, result: any) => Promise<void>
 * }} UserPageModule
 */

/**
 * Registry of user page modules.
 *
 * @type {Record<string, UserPageModule>}
 */
const pageModules = {
  home: {load: loadHomePage, render: renderHomePage},
  browse: {load: loadBrowsePage, render: renderBrowsePage, enhance: enhanceBrowsePage},
  library: {load: loadBrowsePage, render: renderBrowsePage, enhance: enhanceBrowsePage},
  title: {load: loadTitlePage, render: renderTitlePage, enhance: enhanceTitlePage},
  requests: {load: loadRequestsPage, render: renderRequestsPage, enhance: enhanceRequestsPage},
  following: {load: loadFollowingPage, render: renderFollowingPage},
  reader: {load: loadReaderPage, render: renderReaderPage, enhance: enhanceReaderPage}
};

/**
 * Load a user page payload.
 *
 * @param {ReturnType<import("../routes.js").matchUserRoute>} route
 * @param {any} context
 * @returns {Promise<any>}
 */
export const loadUserPage = (route, context) => pageModules[route.id].load({...context, route});

/**
 * Render a user page payload into HTML.
 *
 * @param {ReturnType<import("../routes.js").matchUserRoute>} route
 * @param {any} result
 * @returns {string}
 */
export const renderUserPage = (route, result) => pageModules[route.id].render(result);

/**
 * Run user page enhancement hooks.
 *
 * @param {ReturnType<import("../routes.js").matchUserRoute>} route
 * @param {HTMLElement} root
 * @param {any} context
 * @param {any} result
 * @returns {Promise<void>}
 */
export const enhanceUserPage = async (route, root, context, result) => {
  const module = pageModules[route.id];
  if (typeof module.enhance === "function") {
    await module.enhance(root, context, result);
  }
};

export default {
  loadUserPage,
  renderUserPage,
  enhanceUserPage
};
