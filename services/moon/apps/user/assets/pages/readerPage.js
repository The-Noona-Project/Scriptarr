import {escapeHtml, renderEmptyState} from "../dom.js";
import {formatProgress} from "../format.js";

/**
 * Load a reader chapter payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   route: ReturnType<import("../routes.js").matchUserRoute>
 * }} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadReaderPage = ({api, route}) => api.get(`/api/moon/v3/user/reader/title/${encodeURIComponent(route.params.titleId)}/chapter/${encodeURIComponent(route.params.chapterId)}`);

/**
 * Render the reader shell markup that the runtime enhances after load.
 *
 * @param {Awaited<ReturnType<typeof loadReaderPage>>} result
 * @returns {string}
 */
export const renderReaderPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Reader unavailable", result.payload?.error || "Moon could not load this chapter.");
  }

  return `
    <section class="reader-shell">
      <header class="reader-toolbar">
        <div>
          <span class="section-kicker">${escapeHtml(result.payload?.title?.title || "Reader")}</span>
          <h2>${escapeHtml(result.payload?.chapter?.label || "Chapter")}</h2>
        </div>
        <div class="reader-controls">
          <button class="ghost-button small" id="reader-prev-page" type="button">Prev page</button>
          <button class="ghost-button small" id="reader-next-page" type="button">Next page</button>
          <select id="reader-mode">
            <option value="paged">Paged</option>
            <option value="webtoon">Webtoon</option>
          </select>
          <select id="reader-fit">
            <option value="width">Fit width</option>
            <option value="contain">Contain</option>
            <option value="height">Fit height</option>
          </select>
          <label class="switch-row compact">
            <input id="reader-sidebar-toggle" type="checkbox">
            <span>Sidebar</span>
          </label>
          <button class="solid-button small" id="reader-add-bookmark" type="button">Bookmark page</button>
        </div>
      </header>
      <div class="reader-layout">
        <aside class="reader-sidebar" id="reader-sidebar">
          <div class="reader-meta">
            <strong>${escapeHtml(result.payload?.title?.title || "Title")}</strong>
            <span id="reader-progress-label">0%</span>
            <span id="reader-page-label">Page 1</span>
          </div>
          <div class="bookmark-list" id="reader-bookmark-list"></div>
          <div class="reader-nav-links">
            ${result.payload?.previousChapterId ? `<a class="ghost-button small" href="/reader/${escapeHtml(result.payload.title.id)}/${escapeHtml(result.payload.previousChapterId)}" data-link>Previous chapter</a>` : ""}
            ${result.payload?.nextChapterId ? `<a class="ghost-button small" href="/reader/${escapeHtml(result.payload.title.id)}/${escapeHtml(result.payload.nextChapterId)}" data-link>Next chapter</a>` : ""}
          </div>
        </aside>
        <section class="reader-stage">
          <div class="reader-page-stage" id="reader-page-stage"></div>
        </section>
      </div>
    </section>
  `;
};

/**
 * Persist reader display preferences.
 *
 * @param {ReturnType<import("../api.js").createUserApi>} api
 * @param {{readingMode: string, pageFit: string, showSidebar: boolean, showPageNumbers: boolean}} preferences
 * @returns {Promise<void>}
 */
const persistPreferences = async (api, preferences) => {
  await api.put("/api/moon/v3/user/reader/preferences", preferences);
};

/**
 * Persist reader progress.
 *
 * @param {ReturnType<import("../api.js").createUserApi>} api
 * @param {Awaited<ReturnType<typeof loadReaderPage>>["payload"]} payload
 * @param {number} pageIndex
 * @returns {Promise<void>}
 */
const persistProgress = async (api, payload, pageIndex) => {
  const totalPages = Math.max(1, payload.pages.length - 1);
  await api.put("/api/moon/v3/user/reader/progress", {
    mediaId: payload.title.id,
    chapterLabel: payload.chapter.label,
    positionRatio: pageIndex / totalPages,
    bookmark: {
      titleId: payload.title.id,
      chapterId: payload.chapter.id,
      pageIndex
    }
  });
};

/**
 * Render the bookmark sidebar entries.
 *
 * @param {HTMLElement} root
 * @param {{
 *   payload: Awaited<ReturnType<typeof loadReaderPage>>["payload"],
 *   currentPageIndex: number
 * }} state
 * @returns {void}
 */
const renderBookmarkList = (root, state) => {
  const node = root.querySelector("#reader-bookmark-list");
  if (!(node instanceof HTMLElement)) {
    return;
  }

  node.innerHTML = (state.payload.bookmarks || []).length
    ? state.payload.bookmarks.map((bookmark) => `
      <button class="bookmark-chip ${bookmark.pageIndex === state.currentPageIndex ? "is-active" : ""}" type="button" data-bookmark-page="${escapeHtml(bookmark.pageIndex)}">
        ${escapeHtml(bookmark.label || `Page ${bookmark.pageIndex + 1}`)}
      </button>
    `).join("")
    : `<p class="reader-side-copy">No bookmarks for this chapter yet.</p>`;
};

/**
 * Render either the paged or webtoon reader surface.
 *
 * @param {HTMLElement} root
 * @param {{
 *   payload: Awaited<ReturnType<typeof loadReaderPage>>["payload"],
 *   currentPageIndex: number,
 *   preferences: {readingMode: string, pageFit: string, showSidebar: boolean, showPageNumbers: boolean},
 *   scrollTimer: ReturnType<typeof setTimeout> | null
 * }} state
 * @returns {void}
 */
const renderReaderStage = (root, state) => {
  const stage = root.querySelector("#reader-page-stage");
  const sidebar = root.querySelector("#reader-sidebar");
  const progressLabel = root.querySelector("#reader-progress-label");
  const pageLabel = root.querySelector("#reader-page-label");
  const modeSelect = root.querySelector("#reader-mode");
  const fitSelect = root.querySelector("#reader-fit");
  const sidebarToggle = root.querySelector("#reader-sidebar-toggle");

  if (!(stage instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) {
    return;
  }

  sidebar.hidden = !state.preferences.showSidebar;
  if (progressLabel instanceof HTMLElement) {
    progressLabel.textContent = `${formatProgress(state.currentPageIndex / Math.max(1, state.payload.pages.length - 1))} read`;
  }
  if (pageLabel instanceof HTMLElement) {
    pageLabel.textContent = `Page ${state.currentPageIndex + 1} of ${state.payload.pages.length}`;
  }
  if (modeSelect instanceof HTMLSelectElement) {
    modeSelect.value = state.preferences.readingMode;
  }
  if (fitSelect instanceof HTMLSelectElement) {
    fitSelect.value = state.preferences.pageFit;
  }
  if (sidebarToggle instanceof HTMLInputElement) {
    sidebarToggle.checked = state.preferences.showSidebar;
  }

  stage.dataset.fit = state.preferences.pageFit;
  stage.dataset.mode = state.preferences.readingMode;

  if (state.preferences.readingMode === "paged") {
    const page = state.payload.pages[state.currentPageIndex];
    stage.innerHTML = `
      <div class="paged-reader">
        <img class="reader-page-image" src="${escapeHtml(page.src)}" alt="${escapeHtml(page.label)}">
      </div>
    `;
  } else {
    stage.innerHTML = `
      <div class="webtoon-reader" id="reader-webtoon-scroll">
        ${state.payload.pages.map((page) => `
          <img class="reader-page-image webtoon" src="${escapeHtml(page.src)}" alt="${escapeHtml(page.label)}" data-page-index="${escapeHtml(page.index)}">
        `).join("")}
      </div>
    `;

    const scrollNode = stage.querySelector("#reader-webtoon-scroll");
    if (scrollNode instanceof HTMLElement) {
      queueMicrotask(() => {
        const anchor = scrollNode.querySelector(`[data-page-index="${CSS.escape(String(state.currentPageIndex))}"]`);
        anchor?.scrollIntoView({block: "start"});
      });
    }
  }

  renderBookmarkList(root, state);
};

/**
 * Remove previously bound reader delegation handlers from the shared Moon root.
 *
 * @param {HTMLElement & {
 *   __readerBookmarkHandler?: EventListener,
 *   __readerScrollHandler?: EventListener
 * }} root
 * @returns {void}
 */
const cleanupReaderHandlers = (root) => {
  if (root.__readerBookmarkHandler) {
    root.removeEventListener("click", root.__readerBookmarkHandler);
    delete root.__readerBookmarkHandler;
  }

  if (root.__readerScrollHandler) {
    root.removeEventListener("scroll", root.__readerScrollHandler, true);
    delete root.__readerScrollHandler;
  }
};

/**
 * Wire the live reader runtime.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @param {Awaited<ReturnType<typeof loadReaderPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceReaderPage = async (root, {api, rerender, setFlash}, result) => {
  if (!result.ok) {
    return;
  }

  cleanupReaderHandlers(/** @type {HTMLElement & {
    __readerBookmarkHandler?: EventListener,
    __readerScrollHandler?: EventListener
  }} */ (root));

  const payload = result.payload;
  const initialPageIndex = Number.isInteger(payload.progress?.bookmark?.pageIndex)
    ? payload.progress.bookmark.pageIndex
    : 0;
  const state = {
    payload,
    currentPageIndex: Math.max(0, Math.min(payload.pages.length - 1, initialPageIndex)),
    preferences: {
      readingMode: payload.preferences?.readingMode || "paged",
      pageFit: payload.preferences?.pageFit || "width",
      showSidebar: payload.preferences?.showSidebar !== false,
      showPageNumbers: payload.preferences?.showPageNumbers !== false
    },
    scrollTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null)
  };

  /**
   * Update the reader page index and persist progress.
   *
   * @param {number} nextPageIndex
   * @returns {Promise<void>}
   */
  const updatePageIndex = async (nextPageIndex) => {
    state.currentPageIndex = Math.max(0, Math.min(payload.pages.length - 1, nextPageIndex));
    renderReaderStage(root, state);
    await persistProgress(api, payload, state.currentPageIndex);
  };

  renderReaderStage(root, state);

  root.querySelector("#reader-prev-page")?.addEventListener("click", async () => {
    await updatePageIndex(state.currentPageIndex - 1);
  });

  root.querySelector("#reader-next-page")?.addEventListener("click", async () => {
    await updatePageIndex(state.currentPageIndex + 1);
  });

  root.querySelector("#reader-mode")?.addEventListener("change", async (event) => {
    state.preferences.readingMode = event.target.value;
    await persistPreferences(api, state.preferences);
    renderReaderStage(root, state);
  });

  root.querySelector("#reader-fit")?.addEventListener("change", async (event) => {
    state.preferences.pageFit = event.target.value;
    await persistPreferences(api, state.preferences);
    renderReaderStage(root, state);
  });

  root.querySelector("#reader-sidebar-toggle")?.addEventListener("change", async (event) => {
    state.preferences.showSidebar = event.target.checked;
    await persistPreferences(api, state.preferences);
    renderReaderStage(root, state);
  });

  root.querySelector("#reader-add-bookmark")?.addEventListener("click", async () => {
    const result = await api.post("/api/moon/v3/user/reader/bookmarks", {
      titleId: payload.title.id,
      chapterId: payload.chapter.id,
      pageIndex: state.currentPageIndex,
      label: `${payload.chapter.label} · Page ${state.currentPageIndex + 1}`
    });

    if (!result.ok) {
      setFlash("bad", result.payload?.error || "Unable to save this bookmark.");
      await rerender();
      return;
    }

    setFlash("good", "Bookmark saved.");
    await rerender();
  });

  const bookmarkHandler = async (event) => {
    const bookmarkButton = event.target.closest("[data-bookmark-page]");
    if (!(bookmarkButton instanceof HTMLElement)) {
      return;
    }

    const pageIndex = Number.parseInt(bookmarkButton.dataset.bookmarkPage || "0", 10);
    await updatePageIndex(pageIndex);
  };

  /** @type {HTMLElement & {__readerBookmarkHandler?: EventListener}} */ (root).__readerBookmarkHandler = bookmarkHandler;
  root.addEventListener("click", bookmarkHandler);

  const scrollHandler = async (event) => {
    if (state.preferences.readingMode !== "webtoon") {
      return;
    }

    const scrollNode = event.target.closest("#reader-webtoon-scroll");
    if (!(scrollNode instanceof HTMLElement)) {
      return;
    }

    const pages = Array.from(scrollNode.querySelectorAll("[data-page-index]"));
    if (!pages.length) {
      return;
    }

    const targetOffset = scrollNode.scrollTop + (scrollNode.clientHeight * 0.2);
    const closest = pages.reduce((best, node) => {
      const distance = Math.abs(node.offsetTop - targetOffset);
      return distance < best.distance ? {node, distance} : best;
    }, {node: pages[0], distance: Number.POSITIVE_INFINITY});

    const nextPageIndex = Number.parseInt(closest.node.dataset.pageIndex || "0", 10);
    if (nextPageIndex === state.currentPageIndex) {
      return;
    }

    state.currentPageIndex = nextPageIndex;
    renderBookmarkList(root, state);

    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
    }

    state.scrollTimer = setTimeout(() => {
      void persistProgress(api, payload, state.currentPageIndex);
    }, 700);
  };

  /** @type {HTMLElement & {__readerScrollHandler?: EventListener}} */ (root).__readerScrollHandler = scrollHandler;
  root.addEventListener("scroll", scrollHandler, true);
};

export default {
  loadReaderPage,
  renderReaderPage,
  enhanceReaderPage
};
