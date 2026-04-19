import {createAdminApi} from "./api.js";
import {matchAdminRoute} from "./routes.js";
import {renderAdminShell} from "./shell.js";
import {enhanceAdminPage, loadAdminPage, renderAdminPage} from "./pages/index.js";

/**
 * Load the shared auth and bootstrap context used by the admin chrome.
 *
 * @param {ReturnType<import("./api.js").createAdminApi>} api
 * @returns {Promise<{
 *   user: {username: string, role: string} | null,
 *   loginUrl: string,
 *   bootstrap: {ownerClaimed?: boolean, superuserId?: string} | null
 * }>}
 */
const loadChromeContext = async (api) => {
  const [auth, discordUrl, bootstrap] = await Promise.all([
    api.getAuthStatus(),
    api.getDiscordUrl(),
    api.getBootstrapStatus()
  ]);

  return {
    user: auth.ok ? auth.payload.user : null,
    loginUrl: discordUrl.ok ? discordUrl.payload?.oauthUrl || "#" : "#",
    bootstrap: bootstrap.ok ? bootstrap.payload : null
  };
};

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
   * @returns {void}
   */
  const navigate = (path) => {
    window.history.pushState({}, "", path);
    void render();
  };

  /**
   * Render the current admin route.
   *
   * @returns {Promise<void>}
   */
  const render = async () => {
    const route = matchAdminRoute(window.location.pathname);
    const searchParams = new URLSearchParams(window.location.search);
    const [chromeContext, pageResult] = await Promise.all([
      loadChromeContext(api),
      loadAdminPage(route, {api, searchParams})
    ]);

    root.innerHTML = renderAdminShell({
      route,
      content: renderAdminPage(route, pageResult),
      user: chromeContext.user,
      flash: state.flash,
      loginUrl: chromeContext.loginUrl,
      bootstrap: chromeContext.bootstrap
    });

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

    root.querySelector("[data-action='claim-dev-session']")?.addEventListener("click", async () => {
      const bootstrap = chromeContext.bootstrap || {};
      const identity = bootstrap.ownerClaimed
        ? {discordUserId: "scriptarr-admin-dev", username: "Scriptarr Admin Dev"}
        : {discordUserId: bootstrap.superuserId || "scriptarr-owner-dev", username: "Scriptarr Owner Dev"};

      const result = await api.claimDevSession(identity);
      setFlash(result.ok ? "good" : "bad", result.ok ? `Signed in as ${identity.username}.` : result.payload?.error || "Unable to claim a dev session.");
      await render();
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
