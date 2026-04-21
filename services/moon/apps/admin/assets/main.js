import {createAdminApi} from "./api.js";
import {matchAdminRoute} from "./routes.js";
import {renderEmptyState} from "./dom.js";
import {renderAdminShell} from "./shell.js";
import {enhanceAdminPage, loadAdminPage, renderAdminPage} from "./pages/index.js";

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
 * Load the shared auth and bootstrap context used by the admin chrome.
 *
 * @param {ReturnType<import("./api.js").createAdminApi>} api
 * @returns {Promise<{
 *   user: {username: string, role: string, permissions?: string[], avatarUrl?: string | null} | null,
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

const formatDocumentTitle = (route, siteName) => `${route.title} - ${siteName} Admin`;

/**
 * Start the Moon admin SPA runtime.
 *
 * @param {Element | null} root
 * @returns {void}
 */
export const bootAdminApp = (root) => {
  if (!(root instanceof HTMLElement)) {
    return;
  }

  const api = createAdminApi();
  const state = {
    flash: /** @type {{tone: string, text: string} | null} */ (null)
  };

  /**
   * Queue a single-render flash message.
   *
   * @param {string} tone
   * @param {string} text
   * @returns {void}
   */
  const setFlash = (tone, text) => {
    state.flash = {tone, text};
  };

  /**
   * Navigate to a new route inside the admin SPA.
   *
   * @param {string} path
   * @param {{replace?: boolean}} [options]
   * @returns {void}
   */
  const navigate = (path, options = {}) => {
    if (options.replace) {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
    void render();
  };

  /**
   * Render the current admin route.
   *
   * @returns {Promise<void>}
   */
  const render = async () => {
    const route = matchAdminRoute(window.location.pathname);
    const chromeContext = await loadChromeContext(api);

    if (chromeContext.user && !chromeContext.canAccessAdmin) {
      window.location.replace("/");
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    const pageResult = chromeContext.user
      ? await loadAdminPage(route, {api, searchParams})
      : {
        ok: false,
        status: 401,
        payload: {error: "Sign in with an admin account to access Moon admin."}
      };

    root.innerHTML = renderAdminShell({
      route,
      content: chromeContext.user
        ? renderAdminPage(route, pageResult, chromeContext)
        : renderEmptyState("Admin sign-in required", "Sign in with an admin Discord account to access Moon admin."),
      user: chromeContext.user,
      branding: chromeContext.branding,
      flash: state.flash,
      loginUrl: chromeContext.loginUrl,
      bootstrap: chromeContext.bootstrap
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

    await enhanceAdminPage(route, root, {
      api,
      navigate,
      rerender: render,
      setFlash,
      user: chromeContext.user
    }, pageResult);
  };

  window.addEventListener("popstate", () => {
    void render();
  });

  void render();
};

export default bootAdminApp;
