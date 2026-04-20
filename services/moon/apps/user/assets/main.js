import {createUserApi} from "./api.js";
import {matchUserRoute} from "./routes.js";
import {renderUserShell} from "./shell.js";
import {enhanceUserPage, loadUserPage, renderUserPage} from "./pages/index.js";
import {createInstallController, registerMoonServiceWorker} from "./pwa.js";

const DEFAULT_SITE_NAME = "Scriptarr";

/**
 * Load the shared user-app chrome context.
 *
 * @param {ReturnType<import("./api.js").createUserApi>} api
 * @returns {Promise<{
 *   user: {username: string, role: string} | null,
 *   loginUrl: string,
 *   bootstrap: {ownerClaimed?: boolean, superuserId?: string} | null,
 *   branding: {siteName?: string}
 * }>}
 */
const loadChromeContext = async (api) => {
  const [auth, discordUrl, bootstrap, branding] = await Promise.all([
    api.getAuthStatus(),
    api.getDiscordUrl(),
    api.getBootstrapStatus(),
    api.getBranding()
  ]);

  return {
    user: auth.ok ? auth.payload.user : null,
    loginUrl: discordUrl.ok ? discordUrl.payload?.oauthUrl || "#" : "#",
    bootstrap: bootstrap.ok ? bootstrap.payload : null,
    branding: branding.ok ? branding.payload : {siteName: DEFAULT_SITE_NAME}
  };
};

const formatDocumentTitle = (route, siteName) =>
  route.id === "home" ? siteName : `${route.title} - ${siteName}`;

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
  const installController = createInstallController();
  const state = {
    flash: /** @type {{tone: string, text: string} | null} */ (null),
    installAvailable: installController.isAvailable()
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
    const route = matchUserRoute(window.location.pathname);
    const searchParams = new URLSearchParams(window.location.search);
    const [chromeContext, pageResult] = await Promise.all([
      loadChromeContext(api),
      loadUserPage(route, {api, searchParams})
    ]);

    root.innerHTML = renderUserShell({
      route,
      content: renderUserPage(route, pageResult, chromeContext),
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

  installController.subscribe((available) => {
    if (state.installAvailable === available) {
      return;
    }
    state.installAvailable = available;
    void render();
  });

  void registerMoonServiceWorker();
  void render();
};

export default bootUserApp;
