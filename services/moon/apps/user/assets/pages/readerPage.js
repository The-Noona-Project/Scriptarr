import {escapeHtml, renderEmptyState} from "../dom.js";
import {formatProgress} from "../format.js";
import {buildReaderPathForTitle, buildTitlePathForTitle} from "../routes.js";

const clampPageIndex = (pageIndex, pages) => Math.max(0, Math.min(Math.max(0, pages.length - 1), pageIndex));

const getReaderTypeSlug = (payload) => payload?.title?.libraryTypeSlug || payload?.title?.mediaType || "manga";

const getProgressRatio = (pageIndex, pages) => pageIndex / Math.max(1, pages.length - 1);

const findChapterNeighbors = (payload) => {
  const chapters = Array.isArray(payload?.manifest?.chapters) ? payload.manifest.chapters : [];
  const currentChapterId = payload?.chapter?.id;
  const currentIndex = chapters.findIndex((entry) => entry.id === currentChapterId);

  if (currentIndex === -1) {
    return {
      previousChapterId: payload?.previousChapterId || "",
      nextChapterId: payload?.nextChapterId || ""
    };
  }

  return {
    previousChapterId: payload?.previousChapterId || chapters[currentIndex - 1]?.id || "",
    nextChapterId: payload?.nextChapterId || chapters[currentIndex + 1]?.id || ""
  };
};

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

const renderBookmarkList = (payload, currentPageIndex) => {
  const bookmarks = Array.isArray(payload?.bookmarks) ? payload.bookmarks : [];
  if (!bookmarks.length) {
    return `<p class="reader-side-copy">No bookmarks in this chapter yet.</p>`;
  }

  return `
    <div class="reader-chip-list">
      ${bookmarks.map((bookmark) => `
        <button class="bookmark-chip ${bookmark.pageIndex === currentPageIndex ? "is-active" : ""}" type="button" data-bookmark-page="${escapeHtml(bookmark.pageIndex)}">
          ${escapeHtml(bookmark.label || `Page ${bookmark.pageIndex + 1}`)}
        </button>
      `).join("")}
    </div>
  `;
};

const renderChapterList = (payload) => {
  const chapters = Array.isArray(payload?.manifest?.chapters) ? payload.manifest.chapters : [];
  if (!chapters.length) {
    return `<p class="reader-side-copy">No chapter navigation is available yet.</p>`;
  }

  return `
    <div class="reader-chapter-list">
      ${chapters.map((chapter) => `
        <a class="reader-chapter-link ${chapter.id === payload.chapter.id ? "is-active" : ""}" href="${escapeHtml(buildReaderPathForTitle(payload.title, chapter.id))}" data-link data-reader-chapter="${escapeHtml(chapter.id)}">
          <strong>${escapeHtml(chapter.label)}</strong>
          <span>${escapeHtml(chapter.releaseDate || `${chapter.pageCount || 0} pages`)}</span>
        </a>
      `).join("")}
    </div>
  `;
};

const renderPageThumbs = (payload, currentPageIndex) => {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (!pages.length) {
    return "";
  }

  return `
    <div class="reader-page-grid">
      ${pages.map((page) => `
        <button class="reader-page-thumb ${page.index === currentPageIndex ? "is-active" : ""}" type="button" data-reader-page="${escapeHtml(page.index)}" aria-label="Jump to ${escapeHtml(page.label)}">
          <img src="${escapeHtml(page.src)}" alt="${escapeHtml(page.label)}" loading="lazy">
          <span>${escapeHtml(page.label)}</span>
        </button>
      `).join("")}
    </div>
  `;
};

const renderPagedStage = (payload, currentPageIndex) => {
  const page = payload.pages[currentPageIndex];
  if (!page) {
    return `<div class="reader-stage-empty">No pages are available for this chapter.</div>`;
  }

  return `
    <div class="reader-paged-frame">
      <img class="reader-page-image" src="${escapeHtml(page.src)}" alt="${escapeHtml(page.label)}">
    </div>
  `;
};

const renderWebtoonStage = (payload) => `
  <div class="reader-webtoon-scroll" id="reader-webtoon-scroll">
    ${payload.pages.map((page) => `
      <div class="reader-webtoon-page" data-page-index="${escapeHtml(page.index)}">
        <img class="reader-page-image webtoon" src="${escapeHtml(page.src)}" alt="${escapeHtml(page.label)}" loading="lazy">
      </div>
    `).join("")}
  </div>
`;

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

  const payload = result.payload;
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  const currentPageIndex = clampPageIndex(
    Number.isInteger(payload?.progress?.bookmark?.pageIndex) ? payload.progress.bookmark.pageIndex : 0,
    pages
  );
  const preferences = {
    readingMode: payload?.preferences?.readingMode === "webtoon" ? "webtoon" : "paged",
    pageFit: ["width", "contain", "height"].includes(payload?.preferences?.pageFit) ? payload.preferences.pageFit : "width",
    showSidebar: payload?.preferences?.showSidebar === true,
    showPageNumbers: payload?.preferences?.showPageNumbers !== false
  };
  const neighbors = findChapterNeighbors(payload);

  return `
    <section class="reader-app ${preferences.showSidebar ? "is-drawer-open" : "is-drawer-collapsed"}" data-reader-root data-reader-mode="${escapeHtml(preferences.readingMode)}" data-reader-fit="${escapeHtml(preferences.pageFit)}">
      <header class="reader-chrome reader-chrome-top" id="reader-top-chrome">
        <div class="reader-title-block">
          <a class="ghost-button small" href="${escapeHtml(buildTitlePathForTitle(payload.title))}" data-link>Back to series</a>
          <div>
            <span class="section-kicker">${escapeHtml(payload.title.libraryTypeLabel || payload.title.mediaType || "Reader")}</span>
            <h1 class="reader-title">${escapeHtml(payload.title.title || "Reader")}</h1>
            <p class="reader-subtitle">${escapeHtml(payload.chapter.label || "Chapter")} · ${escapeHtml(String(pages.length))} pages</p>
          </div>
        </div>
        <div class="reader-toolbar-actions">
          <button class="ghost-button small" type="button" id="reader-toggle-drawer">${preferences.showSidebar ? "Hide panels" : "Show panels"}</button>
          <button class="ghost-button small" type="button" id="reader-toggle-mode">${preferences.readingMode === "webtoon" ? "Use paged mode" : "Use vertical mode"}</button>
          <button class="solid-button small" id="reader-add-bookmark" type="button">Bookmark page</button>
        </div>
      </header>
      <div class="reader-body">
        <aside class="reader-drawer" id="reader-drawer">
          <section class="reader-panel">
            <div class="reader-panel-head">
              <div>
                <span class="section-kicker">Progress</span>
                <h2>Jump around</h2>
              </div>
              <span class="reader-progress-stat" id="reader-progress-label">${escapeHtml(formatProgress(getProgressRatio(currentPageIndex, pages)))} read</span>
            </div>
            <div class="reader-slider-block">
              <label class="reader-slider-label" for="reader-page-slider">
                <span id="reader-page-label">${preferences.showPageNumbers ? `Page ${currentPageIndex + 1} of ${pages.length}` : "Page position"}</span>
                <span>${escapeHtml(payload.chapter.label || "Chapter")}</span>
              </label>
              <input id="reader-page-slider" class="reader-slider" type="range" min="1" max="${escapeHtml(Math.max(1, pages.length))}" value="${escapeHtml(currentPageIndex + 1)}">
            </div>
            <div class="reader-preference-grid">
              <label class="reader-select-field">
                <span>Reading mode</span>
                <select id="reader-mode">
                  <option value="paged"${preferences.readingMode === "paged" ? " selected" : ""}>Paged</option>
                  <option value="webtoon"${preferences.readingMode === "webtoon" ? " selected" : ""}>Vertical</option>
                </select>
              </label>
              <label class="reader-select-field">
                <span>Page fit</span>
                <select id="reader-fit">
                  <option value="width"${preferences.pageFit === "width" ? " selected" : ""}>Fit width</option>
                  <option value="contain"${preferences.pageFit === "contain" ? " selected" : ""}>Contain</option>
                  <option value="height"${preferences.pageFit === "height" ? " selected" : ""}>Fit height</option>
                </select>
              </label>
            </div>
            <div class="reader-toggle-grid">
              <label class="switch-row compact">
                <input id="reader-page-number-toggle" type="checkbox"${preferences.showPageNumbers ? " checked" : ""}>
                <span>Show page numbers</span>
              </label>
              <label class="switch-row compact">
                <input id="reader-sidebar-toggle" type="checkbox"${preferences.showSidebar ? " checked" : ""}>
                <span>Keep panels open</span>
              </label>
            </div>
          </section>
          <section class="reader-panel">
            <div class="reader-panel-head">
              <div>
                <span class="section-kicker">Chapters</span>
                <h2>Move through the series</h2>
              </div>
            </div>
            ${renderChapterList(payload)}
          </section>
          <section class="reader-panel">
            <div class="reader-panel-head">
              <div>
                <span class="section-kicker">Bookmarks</span>
                <h2>Return to saved spots</h2>
              </div>
            </div>
            <div id="reader-bookmark-list">
              ${renderBookmarkList(payload, currentPageIndex)}
            </div>
          </section>
          <section class="reader-panel">
            <div class="reader-panel-head">
              <div>
                <span class="section-kicker">Pages</span>
                <h2>Thumbnail scrubber</h2>
              </div>
            </div>
            <div id="reader-page-thumb-list">
              ${renderPageThumbs(payload, currentPageIndex)}
            </div>
          </section>
        </aside>
        <section class="reader-stage-shell">
          <div class="reader-stage-actions">
            ${neighbors.previousChapterId ? `<a class="ghost-button small" href="${escapeHtml(buildReaderPathForTitle(payload.title, neighbors.previousChapterId))}" data-link>Previous chapter</a>` : ""}
            ${neighbors.nextChapterId ? `<a class="ghost-button small" href="${escapeHtml(buildReaderPathForTitle(payload.title, neighbors.nextChapterId))}" data-link>Next chapter</a>` : ""}
          </div>
          <div class="reader-stage" id="reader-stage-surface">
            <button class="reader-tap-zone is-prev" type="button" data-reader-tap-zone="prev" aria-label="Previous page"></button>
            <div class="reader-page-stage" id="reader-page-stage" data-fit="${escapeHtml(preferences.pageFit)}" data-mode="${escapeHtml(preferences.readingMode)}">
              ${preferences.readingMode === "webtoon" ? renderWebtoonStage(payload) : renderPagedStage(payload, currentPageIndex)}
            </div>
            <button class="reader-tap-zone is-next" type="button" data-reader-tap-zone="next" aria-label="Next page"></button>
            <button class="reader-chrome-toggle" type="button" data-reader-toggle-chrome aria-label="Toggle reader controls">Toggle controls</button>
          </div>
        </section>
      </div>
      <footer class="reader-chrome reader-chrome-bottom" id="reader-bottom-chrome">
        <div class="reader-bottom-summary">
          <strong>${escapeHtml(payload.chapter.label || "Chapter")}</strong>
          <span id="reader-bottom-page-label">${preferences.showPageNumbers ? `Page ${currentPageIndex + 1} of ${pages.length}` : `${escapeHtml(formatProgress(getProgressRatio(currentPageIndex, pages)))} read`}</span>
        </div>
        <div class="reader-bottom-actions">
          <button class="ghost-button small" id="reader-prev-page" type="button">Prev page</button>
          <button class="ghost-button small" id="reader-next-page" type="button">Next page</button>
        </div>
      </footer>
    </section>
  `;
};

/**
 * Persist reader display preferences.
 *
 * @param {ReturnType<import("../api.js").createUserApi>} api
 * @param {Awaited<ReturnType<typeof loadReaderPage>>["payload"]} payload
 * @param {{readingMode: string, pageFit: string, showSidebar: boolean, showPageNumbers: boolean}} preferences
 * @returns {Promise<void>}
 */
const persistPreferences = async (api, payload, preferences) => {
  await api.put("/api/moon/v3/user/reader/preferences", {
    ...preferences,
    typeSlug: getReaderTypeSlug(payload)
  });
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
  await api.put("/api/moon/v3/user/reader/progress", {
    mediaId: payload.title.id,
    chapterLabel: payload.chapter.label,
    positionRatio: getProgressRatio(pageIndex, payload.pages),
    bookmark: {
      titleId: payload.title.id,
      chapterId: payload.chapter.id,
      pageIndex
    }
  });
};

const updateReaderLabels = (root, state) => {
  const progressLabel = root.querySelector("#reader-progress-label");
  const pageLabel = root.querySelector("#reader-page-label");
  const bottomPageLabel = root.querySelector("#reader-bottom-page-label");
  const slider = root.querySelector("#reader-page-slider");
  const app = root.querySelector("[data-reader-root]");

  if (progressLabel instanceof HTMLElement) {
    progressLabel.textContent = `${formatProgress(getProgressRatio(state.currentPageIndex, state.payload.pages))} read`;
  }

  const pageCopy = state.preferences.showPageNumbers
    ? `Page ${state.currentPageIndex + 1} of ${state.payload.pages.length}`
    : "Page position";
  if (pageLabel instanceof HTMLElement) {
    pageLabel.textContent = pageCopy;
  }
  if (bottomPageLabel instanceof HTMLElement) {
    bottomPageLabel.textContent = state.preferences.showPageNumbers
      ? `Page ${state.currentPageIndex + 1} of ${state.payload.pages.length}`
      : `${formatProgress(getProgressRatio(state.currentPageIndex, state.payload.pages))} read`;
  }
  if (slider instanceof HTMLInputElement) {
    slider.max = String(Math.max(1, state.payload.pages.length));
    slider.value = String(state.currentPageIndex + 1);
  }
  if (app instanceof HTMLElement) {
    app.dataset.readerMode = state.preferences.readingMode;
    app.dataset.readerFit = state.preferences.pageFit;
    app.classList.toggle("is-drawer-open", state.preferences.showSidebar);
    app.classList.toggle("is-drawer-collapsed", !state.preferences.showSidebar);
    app.classList.toggle("is-chrome-hidden", state.chromeVisible === false);
  }
};

const renderBookmarkSection = (root, state) => {
  const node = root.querySelector("#reader-bookmark-list");
  if (node instanceof HTMLElement) {
    node.innerHTML = renderBookmarkList(state.payload, state.currentPageIndex);
  }
};

const renderThumbSection = (root, state) => {
  const node = root.querySelector("#reader-page-thumb-list");
  if (node instanceof HTMLElement) {
    node.innerHTML = renderPageThumbs(state.payload, state.currentPageIndex);
  }
};

const renderReaderStage = (root, state) => {
  const stage = root.querySelector("#reader-page-stage");
  const modeSelect = root.querySelector("#reader-mode");
  const fitSelect = root.querySelector("#reader-fit");
  const sidebarToggle = root.querySelector("#reader-sidebar-toggle");
  const pageNumberToggle = root.querySelector("#reader-page-number-toggle");
  const drawerToggle = root.querySelector("#reader-toggle-drawer");
  const modeToggle = root.querySelector("#reader-toggle-mode");

  if (!(stage instanceof HTMLElement)) {
    return;
  }

  stage.dataset.fit = state.preferences.pageFit;
  stage.dataset.mode = state.preferences.readingMode;
  stage.innerHTML = state.preferences.readingMode === "webtoon"
    ? renderWebtoonStage(state.payload)
    : renderPagedStage(state.payload, state.currentPageIndex);

  if (modeSelect instanceof HTMLSelectElement) {
    modeSelect.value = state.preferences.readingMode;
  }
  if (fitSelect instanceof HTMLSelectElement) {
    fitSelect.value = state.preferences.pageFit;
  }
  if (sidebarToggle instanceof HTMLInputElement) {
    sidebarToggle.checked = state.preferences.showSidebar;
  }
  if (pageNumberToggle instanceof HTMLInputElement) {
    pageNumberToggle.checked = state.preferences.showPageNumbers;
  }
  if (drawerToggle instanceof HTMLElement) {
    drawerToggle.textContent = state.preferences.showSidebar ? "Hide panels" : "Show panels";
  }
  if (modeToggle instanceof HTMLElement) {
    modeToggle.textContent = state.preferences.readingMode === "webtoon" ? "Use paged mode" : "Use vertical mode";
  }

  updateReaderLabels(root, state);
  renderBookmarkSection(root, state);
  renderThumbSection(root, state);

  if (state.preferences.readingMode === "webtoon") {
    const scrollNode = stage.querySelector("#reader-webtoon-scroll");
    if (scrollNode instanceof HTMLElement) {
      queueMicrotask(() => {
        const anchor = scrollNode.querySelector(`[data-page-index="${CSS.escape(String(state.currentPageIndex))}"]`);
        anchor?.scrollIntoView({block: "start"});
      });
    }
  }
};

const cleanupReaderHandlers = (root) => {
  const typedRoot = /** @type {HTMLElement & {
    __readerClickHandler?: EventListener,
    __readerScrollHandler?: EventListener,
    __readerPointerDownHandler?: EventListener,
    __readerPointerUpHandler?: EventListener,
    __readerActivityHandler?: EventListener,
    __readerHideTimer?: ReturnType<typeof setTimeout> | null
  }} */ (root);

  if (typedRoot.__readerClickHandler) {
    typedRoot.removeEventListener("click", typedRoot.__readerClickHandler);
    delete typedRoot.__readerClickHandler;
  }
  if (typedRoot.__readerScrollHandler) {
    typedRoot.removeEventListener("scroll", typedRoot.__readerScrollHandler, true);
    delete typedRoot.__readerScrollHandler;
  }
  if (typedRoot.__readerPointerDownHandler) {
    typedRoot.removeEventListener("pointerdown", typedRoot.__readerPointerDownHandler, true);
    delete typedRoot.__readerPointerDownHandler;
  }
  if (typedRoot.__readerPointerUpHandler) {
    typedRoot.removeEventListener("pointerup", typedRoot.__readerPointerUpHandler, true);
    delete typedRoot.__readerPointerUpHandler;
  }
  if (typedRoot.__readerActivityHandler) {
    typedRoot.removeEventListener("pointermove", typedRoot.__readerActivityHandler, true);
    delete typedRoot.__readerActivityHandler;
  }
  if (typedRoot.__readerHideTimer) {
    clearTimeout(typedRoot.__readerHideTimer);
    delete typedRoot.__readerHideTimer;
  }
};

/**
 * Wire the live reader runtime.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   navigate: (path: string, options?: {replace?: boolean}) => void,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @param {Awaited<ReturnType<typeof loadReaderPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceReaderPage = async (root, {api, navigate, rerender, setFlash}, result) => {
  if (!result.ok) {
    return;
  }

  cleanupReaderHandlers(root);

  const payload = result.payload;
  const canonicalReaderPath = buildReaderPathForTitle(payload.title, payload.chapter.id);
  if (window.location.pathname !== canonicalReaderPath && payload?.title?.libraryTypeSlug) {
    navigate(canonicalReaderPath, {replace: true});
    return;
  }

  const state = {
    payload,
    currentPageIndex: clampPageIndex(
      Number.isInteger(payload?.progress?.bookmark?.pageIndex) ? payload.progress.bookmark.pageIndex : 0,
      payload.pages
    ),
    preferences: {
      readingMode: payload?.preferences?.readingMode === "webtoon" ? "webtoon" : "paged",
      pageFit: ["width", "contain", "height"].includes(payload?.preferences?.pageFit) ? payload.preferences.pageFit : "width",
      showSidebar: payload?.preferences?.showSidebar === true,
      showPageNumbers: payload?.preferences?.showPageNumbers !== false
    },
    scrollTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
    chromeVisible: true,
    swipeStart: /** @type {{x: number, y: number} | null} */ (null)
  };
  const typedRoot = /** @type {HTMLElement & {__readerHideTimer?: ReturnType<typeof setTimeout> | null}} */ (root);

  const revealChrome = () => {
    state.chromeVisible = true;
    updateReaderLabels(root, state);

    if (typedRoot.__readerHideTimer) {
      clearTimeout(typedRoot.__readerHideTimer);
    }

    typedRoot.__readerHideTimer = setTimeout(() => {
      state.chromeVisible = false;
      updateReaderLabels(root, state);
    }, 2600);
  };

  const updatePageIndex = async (nextPageIndex, {persist = true} = {}) => {
    state.currentPageIndex = clampPageIndex(nextPageIndex, payload.pages);
    renderReaderStage(root, state);
    revealChrome();
    if (persist) {
      await persistProgress(api, payload, state.currentPageIndex);
    }
  };

  const updatePreferences = async (nextPreferences) => {
    state.preferences = {
      ...state.preferences,
      ...nextPreferences
    };
    await persistPreferences(api, payload, state.preferences);
    renderReaderStage(root, state);
    revealChrome();
  };

  renderReaderStage(root, state);
  revealChrome();

  root.querySelector("#reader-prev-page")?.addEventListener("click", async () => {
    await updatePageIndex(state.currentPageIndex - 1);
  });

  root.querySelector("#reader-next-page")?.addEventListener("click", async () => {
    await updatePageIndex(state.currentPageIndex + 1);
  });

  root.querySelector("#reader-mode")?.addEventListener("change", async (event) => {
    if (!(event.target instanceof HTMLSelectElement)) {
      return;
    }
    await updatePreferences({readingMode: event.target.value});
  });

  root.querySelector("#reader-fit")?.addEventListener("change", async (event) => {
    if (!(event.target instanceof HTMLSelectElement)) {
      return;
    }
    await updatePreferences({pageFit: event.target.value});
  });

  root.querySelector("#reader-sidebar-toggle")?.addEventListener("change", async (event) => {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    await updatePreferences({showSidebar: event.target.checked});
  });

  root.querySelector("#reader-page-number-toggle")?.addEventListener("change", async (event) => {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    await updatePreferences({showPageNumbers: event.target.checked});
  });

  root.querySelector("#reader-page-slider")?.addEventListener("input", async (event) => {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    await updatePageIndex(Number.parseInt(event.target.value || "1", 10) - 1);
  });

  root.querySelector("#reader-toggle-drawer")?.addEventListener("click", async () => {
    await updatePreferences({showSidebar: !state.preferences.showSidebar});
  });

  root.querySelector("#reader-toggle-mode")?.addEventListener("click", async () => {
    await updatePreferences({readingMode: state.preferences.readingMode === "webtoon" ? "paged" : "webtoon"});
  });

  root.querySelector("#reader-add-bookmark")?.addEventListener("click", async () => {
    const bookmarkResult = await api.post("/api/moon/v3/user/reader/bookmarks", {
      titleId: payload.title.id,
      chapterId: payload.chapter.id,
      pageIndex: state.currentPageIndex,
      label: `${payload.chapter.label} · Page ${state.currentPageIndex + 1}`
    });

    if (!bookmarkResult.ok) {
      setFlash("bad", bookmarkResult.payload?.error || "Unable to save this bookmark.");
      await rerender();
      return;
    }

    setFlash("good", "Bookmark saved.");
    await rerender();
  });

  const clickHandler = async (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) {
      return;
    }

    const bookmarkButton = target.closest("[data-bookmark-page]");
    if (bookmarkButton instanceof HTMLElement) {
      await updatePageIndex(Number.parseInt(bookmarkButton.dataset.bookmarkPage || "0", 10));
      return;
    }

    const pageButton = target.closest("[data-reader-page]");
    if (pageButton instanceof HTMLElement) {
      await updatePageIndex(Number.parseInt(pageButton.dataset.readerPage || "0", 10));
      return;
    }

    const tapZone = target.closest("[data-reader-tap-zone]");
    if (tapZone instanceof HTMLElement) {
      if (state.preferences.readingMode === "webtoon") {
        const scrollNode = root.querySelector("#reader-webtoon-scroll");
        if (scrollNode instanceof HTMLElement) {
          const delta = tapZone.dataset.readerTapZone === "prev"
            ? -Math.max(280, scrollNode.clientHeight * 0.72)
            : Math.max(280, scrollNode.clientHeight * 0.72);
          scrollNode.scrollBy({top: delta, behavior: "smooth"});
        }
      } else {
        await updatePageIndex(state.currentPageIndex + (tapZone.dataset.readerTapZone === "prev" ? -1 : 1));
      }
      return;
    }

    if (target.closest("[data-reader-toggle-chrome]")) {
      state.chromeVisible = !state.chromeVisible;
      updateReaderLabels(root, state);
      if (state.chromeVisible) {
        revealChrome();
      }
    }
  };

  const scrollHandler = async (event) => {
    if (state.preferences.readingMode !== "webtoon") {
      return;
    }

    const scrollNode = event.target instanceof HTMLElement ? event.target.closest("#reader-webtoon-scroll") : null;
    if (!(scrollNode instanceof HTMLElement)) {
      return;
    }

    const pages = Array.from(scrollNode.querySelectorAll("[data-page-index]"));
    if (!pages.length) {
      return;
    }

    const targetOffset = scrollNode.scrollTop + (scrollNode.clientHeight * 0.18);
    const closest = pages.reduce((best, node) => {
      const distance = Math.abs(node.offsetTop - targetOffset);
      return distance < best.distance ? {node, distance} : best;
    }, {node: pages[0], distance: Number.POSITIVE_INFINITY});

    const nextPageIndex = Number.parseInt(closest.node.dataset.pageIndex || "0", 10);
    if (nextPageIndex !== state.currentPageIndex) {
      state.currentPageIndex = clampPageIndex(nextPageIndex, payload.pages);
      updateReaderLabels(root, state);
      renderBookmarkSection(root, state);
      renderThumbSection(root, state);
    }

    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
    }

    state.scrollTimer = setTimeout(() => {
      void persistProgress(api, payload, state.currentPageIndex);
    }, 700);
  };

  const pointerDownHandler = (event) => {
    const stage = event.target instanceof HTMLElement ? event.target.closest("#reader-stage-surface") : null;
    if (!(stage instanceof HTMLElement) || state.preferences.readingMode !== "paged") {
      state.swipeStart = null;
      return;
    }

    state.swipeStart = {
      x: event.clientX,
      y: event.clientY
    };
  };

  const pointerUpHandler = async (event) => {
    if (!state.swipeStart || state.preferences.readingMode !== "paged") {
      state.swipeStart = null;
      return;
    }

    const stage = event.target instanceof HTMLElement ? event.target.closest("#reader-stage-surface") : null;
    if (!(stage instanceof HTMLElement)) {
      state.swipeStart = null;
      return;
    }

    const deltaX = event.clientX - state.swipeStart.x;
    const deltaY = event.clientY - state.swipeStart.y;
    state.swipeStart = null;

    if (Math.abs(deltaX) < 56 || Math.abs(deltaY) > Math.abs(deltaX) * 0.6) {
      return;
    }

    await updatePageIndex(state.currentPageIndex + (deltaX < 0 ? 1 : -1));
  };

  const activityHandler = () => {
    revealChrome();
  };

  /** @type {HTMLElement & {
    __readerClickHandler?: EventListener,
    __readerScrollHandler?: EventListener,
    __readerPointerDownHandler?: EventListener,
    __readerPointerUpHandler?: EventListener,
    __readerActivityHandler?: EventListener
  }} */ (root).__readerClickHandler = clickHandler;
  /** @type {HTMLElement & {__readerScrollHandler?: EventListener}} */ (root).__readerScrollHandler = scrollHandler;
  /** @type {HTMLElement & {__readerPointerDownHandler?: EventListener}} */ (root).__readerPointerDownHandler = pointerDownHandler;
  /** @type {HTMLElement & {__readerPointerUpHandler?: EventListener}} */ (root).__readerPointerUpHandler = pointerUpHandler;
  /** @type {HTMLElement & {__readerActivityHandler?: EventListener}} */ (root).__readerActivityHandler = activityHandler;

  root.addEventListener("click", clickHandler);
  root.addEventListener("scroll", scrollHandler, true);
  root.addEventListener("pointerdown", pointerDownHandler, true);
  root.addEventListener("pointerup", pointerUpHandler, true);
  root.addEventListener("pointermove", activityHandler, true);
};

export default {
  loadReaderPage,
  renderReaderPage,
  enhanceReaderPage
};
