import {createUserApi} from "./api.js";
import {matchUserRoute} from "./routes.js";
import {renderEmptyState} from "./dom.js";
import {renderUserShell} from "./shell.js";
import {enhanceUserPage, loadUserPage, renderUserPage} from "./pages/index.js";
import {createInstallController, registerMoonServiceWorker} from "./pwa.js";

const DEFAULT_SITE_NAME = "Scriptarr";

const canAccessAdmin = (user) => Boolean(
  user
  && (
    user.role === "owner"
    || user.role === "admin"
    || (Array.isArray(user.permissions) && user.permissions.includes("admin"))
  )
);

/**
 * Load the shared user-app chrome context.
 *
 * @param {ReturnType<import("./api.js").createUserApi>} api
 * @returns {Promise<{
 *   user: {username: string, role: string, permissions?: string[]} | null,
 *   loginUrl: string,
 *   bootstrap: {ownerClaimed?: boolean, superuserId?: string} | null,
 *   branding: {siteName?: string},
 *   canAccessAdmin: boolean
 * }>}
 */
const loadChromeContext = async (api) => {
  const [auth, discordUrl, bootstrap, branding] = await Promise.all([
    api.getAuthStatus(),
    api.getDiscordUrl(),
    api.getBootstrapStatus(),
    api.getBranding()
  ]);

  const user = auth.ok ? auth.payload?.user || auth.payload || null : null;

  return {
    user,
    loginUrl: discordUrl.ok ? discordUrl.payload?.oauthUrl || "#" : "#",
    bootstrap: bootstrap.ok ? bootstrap.payload : null,
    branding: branding.ok ? branding.payload : {siteName: DEFAULT_SITE_NAME},
    canAccessAdmin: canAccessAdmin(user)
  };
};

const formatDocumentTitle = (route, siteName) =>
  route.id === "home" ? siteName : `${route.title} - ${siteName}`;

/**
 * Render a safe fallback when the Moon user app boot path fails.
 *
 * @param {{
 *   route: ReturnType<typeof matchUserRoute>,
 *   chromeContext?: {
 *     user?: {username: string, role: string, permissions?: string[]} | null,
 *     loginUrl?: string,
 *     bootstrap?: {ownerClaimed?: boolean, superuserId?: string} | null,
 *     branding?: {siteName?: string} | null,
 *     canAccessAdmin?: boolean
 *   } | null,
 *   installAvailable?: boolean
 * }} options
 * @returns {string}
 */
export const renderUserBootFailure = ({route, chromeContext = null, installAvailable = false}) => renderUserShell({
  route,
  content: renderEmptyState(
    "Moon hit a loading error",
    "Refresh the page or try again in a moment. If this keeps happening, check Moon logs for the client render failure."
  ),
  user: chromeContext?.user || null,
  branding: chromeContext?.branding || {siteName: DEFAULT_SITE_NAME},
  loginUrl: chromeContext?.loginUrl || "#",
  bootstrap: chromeContext?.bootstrap || null,
  flash: {
    tone: "bad",
    text: "Moon could not finish loading this page."
  },
  installAvailable
});

/**
 * Start the Moon user SPA runtime.
 *
 * @param {Element | null} root
 * @param {{
 *   api?: ReturnType<typeof createUserApi>,
 *   installController?: ReturnType<typeof createInstallController>,
 *   pageRuntime?: {
 *     loadUserPage: typeof loadUserPage,
 *     renderUserPage: typeof renderUserPage,
 *     enhanceUserPage: typeof enhanceUserPage
 *   },
 *   routeMatcher?: typeof matchUserRoute,
 *   registerServiceWorker?: typeof registerMoonServiceWorker,
 *   logger?: Pick<Console, "error">
 * }} [options]
 * @returns {void}
 */
export const bootUserApp = (root, options = {}) => {
  if (!(root instanceof HTMLElement)) {
    return;
  }

  const api = options.api || createUserApi();
  const installController = options.installController || createInstallController();
  const pageRuntime = options.pageRuntime || {
    loadUserPage,
    renderUserPage,
    enhanceUserPage
  };
  const routeMatcher = options.routeMatcher || matchUserRoute;
  const registerServiceWorker = options.registerServiceWorker || registerMoonServiceWorker;
  const logger = options.logger || console;
  const state = {
    flash: /** @type {{tone: string, text: string} | null} */ (null),
    installAvailable: installController.isAvailable(),
    chromeContext: /** @type {Awaited<ReturnType<typeof loadChromeContext>> | null} */ (null)
  };

  /**
   * Queue a flash message for the next render.
   *
   * @param {string} tone
   * @param {string} text
   * @returns {void}
   */
  const setFlash = (tone, text) => {
    state.flash = {tone, text};
  };

  /**
   * Navigate within the Moon user app.
   *
   * @param {string} path
   * @param {{replace?: boolean}} [options]
   * @returns {void}
   */
  const navigate = (path, {replace = false} = {}) => {
    if (replace) {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
    void render();
  };

  /**
   * Render the current user route.
   *
   * @returns {Promise<void>}
   */
  const render = async () => {
    const route = routeMatcher(window.location.pathname);
    const searchParams = new URLSearchParams(window.location.search);
    try {
      const [chromeContext, pageResult] = await Promise.all([
        loadChromeContext(api),
        pageRuntime.loadUserPage(route, {api, searchParams})
      ]);

      state.chromeContext = chromeContext;

      root.innerHTML = renderUserShell({
        route,
        content: pageRuntime.renderUserPage(route, pageResult, chromeContext),
        user: chromeContext.user,
        branding: chromeContext.branding,
        loginUrl: chromeContext.loginUrl,
        bootstrap: chromeContext.bootstrap,
        flash: state.flash,
        installAvailable: state.installAvailable
      });
      document.title = formatDocumentTitle(route, chromeContext.branding?.siteName || DEFAULT_SITE_NAME);

      state.flash = null;

      root.querySelectorAll("[data-link]").forEach((anchor) => {
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          const nextPath = anchor.getAttribute("href");
          if (nextPath) {
            navigate(nextPath);
          }
        });
      });

      root.querySelector("#app-install-button")?.addEventListener("click", async () => {
        const accepted = await installController.prompt();
        if (!accepted) {
          return;
        }
        setFlash("good", "Moon is being installed on this device.");
        void render();
      });

      await pageRuntime.enhanceUserPage(route, root, {
        api,
        navigate,
        rerender: render,
        setFlash,
        user: chromeContext.user,
        route
      }, pageResult);
    } catch (error) {
      logger.error("Moon user render failed.", error);
      root.innerHTML = renderUserBootFailure({
        route,
        chromeContext: state.chromeContext,
        installAvailable: state.installAvailable
      });
      document.title = formatDocumentTitle(route, state.chromeContext?.branding?.siteName || DEFAULT_SITE_NAME);
    }
  };

  window.addEventListener("popstate", () => {
    void render();
  });

  installController.subscribe((available) => {
    if (state.installAvailable === available) {
      return;
    }
    state.installAvailable = available;
    void render();
  });

  void registerServiceWorker();
  void render();
};

export default bootUserApp;
