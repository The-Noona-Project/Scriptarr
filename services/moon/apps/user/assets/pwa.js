/**
 * Determine whether the current Moon user app is already running in an
 * installed standalone display mode.
 *
 * @returns {boolean}
 */
export const isStandaloneDisplayMode = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

/**
 * Register Moon's service worker when the browser supports it.
 *
 * @returns {Promise<void>}
 */
export const registerMoonServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("/service-worker.js");
  } catch {
    // Moon degrades safely when the service worker cannot register.
  }
};

/**
 * Create the Moon install-prompt controller for the user app shell.
 *
 * @returns {{
 *   isAvailable: () => boolean,
 *   prompt: () => Promise<boolean>,
 *   subscribe: (listener: (available: boolean) => void) => () => void
 * }}
 */
export const createInstallController = () => {
  /** @type {BeforeInstallPromptEvent | null} */
  let deferredPrompt = null;
  const listeners = new Set();

  const notify = () => {
    const available = deferredPrompt != null && !isStandaloneDisplayMode();
    for (const listener of listeners) {
      listener(available);
    }
  };

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });

  return {
    isAvailable: () => deferredPrompt != null && !isStandaloneDisplayMode(),
    async prompt() {
      if (!deferredPrompt) {
        return false;
      }

      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      notify();
      return choice?.outcome === "accepted";
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(deferredPrompt != null && !isStandaloneDisplayMode());
      return () => listeners.delete(listener);
    }
  };
};

export default {
  createInstallController,
  isStandaloneDisplayMode,
  registerMoonServiceWorker
};
