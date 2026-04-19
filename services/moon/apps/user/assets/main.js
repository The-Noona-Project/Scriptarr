import {createUserApi} from "./api.js";
import {matchUserRoute} from "./routes.js";
import {renderUserShell} from "./shell.js";
import {enhanceUserPage, loadUserPage, renderUserPage} from "./pages/index.js";

/**
 * Load the shared user-app chrome context.
 *
 * @param {ReturnType<import("./api.js").createUserApi>} api
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
 * Start the Moon user SPA runtime.
 *
 * @param {Element | null} root
 * @returns {void}
 */
export const bootUserApp = (root) => {
  if (!(root instanceof HTMLElement)) {
    return;
  }

  const api = createUserApi();
  const state = {
    flash: /** @type {{tone: string, text: string} | null} */ (null)
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
   * @returns {void}
   */
  const navigate = (path) => {
    window.history.pushState({}, "", path);
    void render();
  };

  /**
   * Render the current user route.
   *
   * @returns {Promise<void>}
   */
  const render = async () => {
    const route = matchUserRoute(window.location.pathname);
    const searchParams = new URLSearchParams(window.location.search);
    const [chromeContext, pageResult] = await Promise.all([
      loadChromeContext(api),
      loadUserPage(route, {api, searchParams})
    ]);

    root.innerHTML = renderUserShell({
      route,
      content: renderUserPage(route, pageResult),
      user: chromeContext.user,
      loginUrl: chromeContext.loginUrl,
      bootstrap: chromeContext.bootstrap,
      flash: state.flash
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
        ? {discordUserId: "scriptarr-reader-dev", username: "Scriptarr Reader Dev"}
        : {discordUserId: bootstrap.superuserId || "scriptarr-owner-dev", username: "Scriptarr Owner Dev"};
      const result = await api.claimDevSession(identity);
      setFlash(result.ok ? "good" : "bad", result.ok ? `Signed in as ${identity.username}.` : result.payload?.error || "Unable to claim a dev session.");
      await render();
    });

    await enhanceUserPage(route, root, {
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

export default bootUserApp;
