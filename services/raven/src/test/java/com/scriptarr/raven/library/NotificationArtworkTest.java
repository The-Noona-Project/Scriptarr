package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.util.List;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Real raster, provider boundary and whole-first-page artwork regressions. */
class NotificationArtworkTest {
    /** Private immutable reader fixture. */
    @TempDir Path directory;
    /** A valid raster is decoded and scaled with its portrait aspect ratio retained. */
    @Test void scalesRealCoverAndRejectsHtml() throws Exception {
        ByteArrayOutputStream input = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(1000, 2000, BufferedImage.TYPE_INT_RGB), "png", input);
        byte[] output = NotificationArtwork.thumbnail(input.toByteArray());
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(output));
        assertEquals(640, image.getWidth()); assertEquals(1280, image.getHeight());
        assertNull(NotificationArtwork.thumbnail("<html>challenge</html>".getBytes()));
    }

    /** Caller-controlled URLs, credentials and internal hosts never become fetch targets. */
    @Test void restrictsCoverDestinations() {
        assertTrue(NotificationArtwork.allowed(URI.create("https://uploads.mangadex.org/covers/a.jpg")));
        for (String url : List.of("http://uploads.mangadex.org/a", "https://127.0.0.1/a", "https://uploads.mangadex.org.evil/a",
            "https://user:secret@uploads.mangadex.org/a", "https://uploads.mangadex.org:8443/a", "file:///tmp/cover")) {
            assertFalse(NotificationArtwork.allowed(URI.create(url)), url);
        }
    }

    /** Missing art uses a whole ready logical page rather than a cropped tile or archive extraction. */
    @Test void usesExistingFirstPageThumbnail() throws Exception {
        LibraryService library = mock(LibraryService.class); LibraryTitle title = mock(LibraryTitle.class);
        LibraryChapter chapter = mock(LibraryChapter.class);
        when(library.findTitleById("title")).thenReturn(title); when(title.id()).thenReturn("title");
        when(title.coverUrl()).thenReturn("https://127.0.0.1/private"); when(title.chapters()).thenReturn(List.of(chapter));
        when(chapter.id()).thenReturn("c1"); when(chapter.chapterNumber()).thenReturn("1"); when(chapter.available()).thenReturn(true);
        when(chapter.ingestStatus()).thenReturn("ready"); when(chapter.pageCount()).thenReturn(1); when(chapter.ingestedPageCount()).thenReturn(1);
        when(chapter.ingestRevision()).thenReturn("webp-0123456789abcdef");
        when(chapter.ingestManifestPath()).thenReturn(directory.resolve("manifest.json").toString());
        byte[] bytes = new byte[]{1, 2, 3};
        Files.write(directory.resolve("p000001-thumbnail.webp"), bytes); Files.write(directory.resolve("p000001-s0000.webp"), bytes);
        Files.writeString(directory.resolve("manifest.json"), """
            {"format":"webp","revision":"webp-0123456789abcdef","chapterId":"c1","mediaType":"image/webp","pageCount":1,
             "pages":[{"segments":[{"slug":"p000001-s0000.webp","size":3}],"thumbnail":{"slug":"p000001-thumbnail.webp"}}]}
            """);
        NotificationArtwork.Result result = new NotificationArtwork(library).load("title");
        assertNotNull(result); assertEquals("first-page", result.source()); assertArrayEquals(bytes, result.bytes());
        Files.delete(directory.resolve("p000001-s0000.webp"));
        assertNull(new NotificationArtwork(library).load("title"));
        verify(library, times(2)).findTitleById("title"); verifyNoMoreInteractions(library);
    }
}
