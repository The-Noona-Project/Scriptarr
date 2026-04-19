package com.scriptarr.raven.library;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Seeded Scriptarr Raven library projection used by Moon while the wider 3.0 stack fills in.
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
     * Build the seeded library scaffold used by the current 3.0 preview stack.
     *
     * @return seeded library projection
     */
    public static LibraryService seedDefault() {
        return new LibraryService(List.of(
            new LibraryTitle(
                "dan-da-dan",
                "Dandadan",
                "manga",
                "watching",
                "166",
                "#ff6a3d",
                "Aliens, yokai, and impossible speed colliding in a loud, kinetic shonen rhythm.",
                "2021",
                166,
                6,
                "Yukinobu Tatsu",
                List.of("action", "paranormal", "comedy"),
                List.of("Dan Da Dan"),
                "mangadex",
                "2026-04-18T00:00:00.000Z",
                List.of(Map.of("title", "Sakamoto Days", "relation", "For fans of")), 
                List.of(
                    new LibraryChapter("dandadan-c161", "Chapter 161", "161", 12, "2026-03-10", true),
                    new LibraryChapter("dandadan-c162", "Chapter 162", "162", 14, "2026-03-17", true),
                    new LibraryChapter("dandadan-c163", "Chapter 163", "163", 13, "2026-03-24", true),
                    new LibraryChapter("dandadan-c164", "Chapter 164", "164", 11, "2026-03-31", true),
                    new LibraryChapter("dandadan-c165", "Chapter 165", "165", 15, "2026-04-07", true),
                    new LibraryChapter("dandadan-c166", "Chapter 166", "166", 16, "2026-04-14", true)
                )
            ),
            new LibraryTitle(
                "sakamoto-days",
                "Sakamoto Days",
                "manga",
                "active",
                "209",
                "#e4d7b8",
                "A retired legend trying to stay domestic while the underworld keeps knocking on the door.",
                "2020",
                209,
                5,
                "Yuto Suzuki",
                List.of("action", "assassin", "comedy"),
                List.of("Sakamoto Days"),
                "mangadex",
                "2026-04-17T00:00:00.000Z",
                List.of(Map.of("title", "Dandadan", "relation", "Trending with")),
                List.of(
                    new LibraryChapter("sakamoto-c205", "Chapter 205", "205", 18, "2026-03-09", true),
                    new LibraryChapter("sakamoto-c206", "Chapter 206", "206", 19, "2026-03-16", true),
                    new LibraryChapter("sakamoto-c207", "Chapter 207", "207", 17, "2026-03-23", true),
                    new LibraryChapter("sakamoto-c208", "Chapter 208", "208", 20, "2026-03-30", true),
                    new LibraryChapter("sakamoto-c209", "Chapter 209", "209", 18, "2026-04-06", true)
                )
            ),
            new LibraryTitle(
                "blacksad",
                "Blacksad",
                "comic",
                "completed",
                "Vol. 7",
                "#5a7184",
                "A noir detective comic with painterly pages and a colder, slower reading cadence.",
                "2000",
                7,
                3,
                "Juan Díaz Canales · Juanjo Guarnido",
                List.of("comic", "noir", "detective"),
                List.of("Blacksad"),
                "comicvine",
                "2026-04-12T00:00:00.000Z",
                List.of(Map.of("title", "Canary", "relation", "Same creators")),
                List.of(
                    new LibraryChapter("blacksad-v05", "Volume 5", "5", 28, "2026-02-11", true),
                    new LibraryChapter("blacksad-v06", "Volume 6", "6", 31, "2026-02-28", true),
                    new LibraryChapter("blacksad-v07", "Volume 7", "7", 34, "2026-03-18", true)
                )
            )
        ));
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
     * Render a synthetic SVG preview page for Moon's reader flow.
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
              <text x="120" y="650" fill="rgba(255,255,255,0.92)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="56" font-weight="700">Moon native reader preview</text>
              <text x="120" y="740" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34">This Scriptarr scaffold page is being rendered directly from Raven so Moon can ship its reader flow now.</text>
              <text x="120" y="820" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34">Downloader-to-library archive playback can replace this generated art once the full ingest path is ready.</text>
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
