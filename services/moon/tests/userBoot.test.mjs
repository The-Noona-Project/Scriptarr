import test from "node:test";
import assert from "node:assert/strict";

import {bootUserApp, renderUserBootFailure} from "../apps/user/assets/main.js";

class FakeHTMLElement {
  constructor() {
    this.innerHTML = "";
  }

  querySelectorAll() {
    return [];
  }

  querySelector() {
    return null;
  }
}

test("renderUserBootFailure shows a visible branded fallback shell", () => {
  const html = renderUserBootFailure({
    route: {
      id: "home",
      path: "/",
      title: "Home",
      description: "Continue reading, latest arrivals, and current requests.",
      navLabel: "Home",
      params: {}
    },
    chromeContext: {
      branding: {siteName: "Pax-Kun"}
    }
  });

  assert.match(html, /Pax-Kun/);
  assert.match(html, /Moon hit a loading error/);
  assert.match(html, /Moon could not finish loading this page/);
});

test("bootUserApp renders a fallback instead of leaving the user root blank when page render throws", async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;

  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.document = {title: ""};
  globalThis.window = {
    location: {
      pathname: "/",
      search: ""
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    addEventListener() {}
  };

  const root = new FakeHTMLElement();
  const errors = [];

  bootUserApp(root, {
    api: {
      getAuthStatus: async () => ({ok: false, status: 401, payload: {error: "Not signed in"}}),
      getDiscordUrl: async () => ({ok: true, status: 200, payload: {oauthUrl: "https://discord.example/login"}}),
      getBootstrapStatus: async () => ({ok: true, status: 200, payload: {ownerClaimed: true, superuserId: "owner-1"}}),
      getBranding: async () => ({ok: true, status: 200, payload: {siteName: "Pax-Kun"}})
    },
    installController: {
      isAvailable: () => false,
      prompt: async () => false,
      subscribe() {
        return () => {};
      }
    },
    pageRuntime: {
      loadUserPage: async () => ({ok: true, status: 200, payload: {}}),
      renderUserPage() {
        throw new Error("boom");
      },
      enhanceUserPage: async () => {}
    },
    registerServiceWorker: async () => {},
    logger: {
      error(...parts) {
        errors.push(parts.map((part) => String(part)).join(" "));
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(root.innerHTML, /Moon hit a loading error/);
  assert.match(root.innerHTML, /Pax-Kun/);
  assert.match(globalThis.document.title, /Pax-Kun/);
  assert.ok(errors.some((entry) => entry.includes("Moon user render failed.")));

  globalThis.HTMLElement = previousHTMLElement;
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
});

test("bootUserApp passes the matched route into page enhancers", async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;

  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.document = {title: ""};
  globalThis.window = {
    location: {
      pathname: "/browse",
      search: ""
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    addEventListener() {}
  };

  const root = new FakeHTMLElement();
  /** @type {any[]} */
  const enhanceCalls = [];

  bootUserApp(root, {
    api: {
      getAuthStatus: async () => ({ok: true, status: 200, payload: {username: "CaptainPax", role: "owner", permissions: ["admin"]}}),
      getDiscordUrl: async () => ({ok: true, status: 200, payload: {oauthUrl: "https://discord.example/login"}}),
      getBootstrapStatus: async () => ({ok: true, status: 200, payload: {ownerClaimed: true, superuserId: "owner-1"}}),
      getBranding: async () => ({ok: true, status: 200, payload: {siteName: "Pax-Kun"}})
    },
    installController: {
      isAvailable: () => false,
      prompt: async () => false,
      subscribe() {
        return () => {};
      }
    },
    pageRuntime: {
      loadUserPage: async () => ({ok: true, status: 200, payload: {titles: []}}),
      renderUserPage: () => "<section>browse</section>",
      enhanceUserPage: async (_route, _root, context) => {
        enhanceCalls.push(context);
      }
    },
    routeMatcher: () => ({
      id: "browse",
      path: "/browse",
      title: "Browse",
      description: "Browse the library by title, type, and metadata.",
      navLabel: "Browse",
      params: {}
    }),
    registerServiceWorker: async () => {},
    logger: {
      error() {}
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(enhanceCalls.length, 1);
  assert.equal(enhanceCalls[0].route?.id, "browse");

  globalThis.HTMLElement = previousHTMLElement;
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
});
