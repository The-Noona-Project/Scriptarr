package com.scriptarr.raven.library;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

/**
 * In-memory Scriptarr Raven library projection.
 */
public final class LibraryService {
    private final List<LibraryTitle> titles;

    /**
     * Create a library projection from a fixed set of titles.
     *
     * @param titles titles Raven should expose to Moon
     */
    public LibraryService(List<LibraryTitle> titles) {
        this.titles = List.copyOf(titles);
    }

    /**
     * Build the empty library projection used before Raven imports real titles.
     *
     * @return empty library projection
     */
    public static LibraryService empty() {
        return new LibraryService(List.of());
    }

    /**
     * List every title currently exposed by Raven.
     *
     * @return immutable title list
     */
    public List<LibraryTitle> listTitles() {
        return titles;
    }

    /**
     * Find a single title by its stable Scriptarr id.
     *
     * @param id title id to resolve
     * @return matching title or {@code null} when it is unknown
     */
    public LibraryTitle findTitle(String id) {
        return titles.stream().filter((entry) -> entry.id().equals(id)).findFirst().orElse(null);
    }

    /**
     * Build the reader manifest for a title's available chapters.
     *
     * @param titleId title id to resolve
     * @return reader manifest or {@code null} when the title is unknown
     */
    public ReaderManifest readerManifest(String titleId) {
        LibraryTitle title = findTitle(titleId);
        if (title == null) {
            return null;
        }

        List<LibraryChapter> chapters = title.chapters().stream().filter(LibraryChapter::available).toList();
        return new ReaderManifest(title, chapters);
    }

    /**
     * Build the chapter payload used by Moon's native reader.
     *
     * @param titleId title id to resolve
     * @param chapterId chapter id to resolve
     * @return chapter payload or {@code null} when the title or chapter is unknown
     */
    public ReaderChapterPayload readerChapter(String titleId, String chapterId) {
        ReaderManifest manifest = readerManifest(titleId);
        if (manifest == null) {
            return null;
        }

        LibraryChapter chapter = manifest.chapters().stream().filter((entry) -> entry.id().equals(chapterId)).findFirst().orElse(null);
        if (chapter == null) {
            return null;
        }

        int chapterIndex = manifest.chapters().indexOf(chapter);
        List<ReaderPage> pages = java.util.stream.IntStream.range(0, chapter.pageCount())
            .mapToObj((index) -> new ReaderPage(index, "Page " + (index + 1), "image/svg+xml"))
            .toList();

        String previousChapterId = chapterIndex > 0 ? manifest.chapters().get(chapterIndex - 1).id() : null;
        String nextChapterId = chapterIndex + 1 < manifest.chapters().size() ? manifest.chapters().get(chapterIndex + 1).id() : null;

        return new ReaderChapterPayload(manifest.title(), chapter, pages, previousChapterId, nextChapterId);
    }

    /**
     * Render a fallback SVG reader page for Raven-managed chapter content.
     *
     * @param titleId title id to resolve
     * @param chapterId chapter id to resolve
     * @param pageIndex zero-based page index to render
     * @return SVG bytes or {@code null} when the page is unavailable
     */
    public byte[] renderReaderPage(String titleId, String chapterId, int pageIndex) {
        ReaderChapterPayload payload = readerChapter(titleId, chapterId);
        if (payload == null || pageIndex < 0 || pageIndex >= payload.pages().size()) {
            return null;
        }

        String svg = """
            <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1700" viewBox="0 0 1200 1700">
              <defs>
                <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%%" stop-color="%s"/>
                  <stop offset="100%%" stop-color="#11161c"/>
                </linearGradient>
              </defs>
              <rect width="1200" height="1700" fill="url(#bg)"/>
              <rect x="74" y="74" width="1052" height="1552" rx="34" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)"/>
              <text x="120" y="210" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34" letter-spacing="6">SCRIPTARR READER</text>
              <text x="120" y="340" fill="#ffffff" font-family="Space Grotesk, Arial, sans-serif" font-size="96" font-weight="700">%s</text>
              <text x="120" y="430" fill="rgba(255,255,255,0.86)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="44">%s</text>
              <text x="120" y="510" fill="rgba(255,255,255,0.64)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="32">Page %d of %d</text>
              <text x="120" y="650" fill="rgba(255,255,255,0.92)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="56" font-weight="700">Moon native reader fallback</text>
              <text x="120" y="740" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34">This Scriptarr reader page is being generated by Raven because chapter page assets are not available yet.</text>
              <text x="120" y="820" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34">Real imported chapter art can replace this fallback output once Raven ingest is wired into the library flow.</text>
              <circle cx="960" cy="430" r="150" fill="rgba(255,255,255,0.08)" />
              <circle cx="960" cy="430" r="94" fill="rgba(255,255,255,0.18)" />
              <text x="960" y="450" text-anchor="middle" fill="#ffffff" font-family="Space Grotesk, Arial, sans-serif" font-size="88" font-weight="700">%d</text>
              <text x="120" y="1460" fill="rgba(255,255,255,0.46)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="28">Generated at %s</text>
            </svg>
            """.formatted(
            payload.title().coverAccent(),
            escapeSvg(payload.title().title()),
            escapeSvg(payload.chapter().label()),
            pageIndex + 1,
            payload.pages().size(),
            pageIndex + 1,
            Instant.now().toString()
        );

        return svg.getBytes(StandardCharsets.UTF_8);
    }

    private String escapeSvg(String value) {
        return value
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;");
    }
}
