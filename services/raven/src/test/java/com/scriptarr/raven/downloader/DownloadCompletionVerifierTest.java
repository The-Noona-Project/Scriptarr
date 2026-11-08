package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Prove that catalog presence alone never establishes completed download work. */
class DownloadCompletionVerifierTest {
    /** Verify missing expected chapters, corrupt archives and non-ready AVIF each prevent completion. */
    @Test
    void requiresEveryExpectedChapterArchiveAndReaderManifest(@TempDir Path root) throws Exception {
        Path archive=root.resolve("chapter.cbz");
        try(ZipOutputStream zip=new ZipOutputStream(Files.newOutputStream(archive))){zip.putNextEntry(new ZipEntry("1.jpg"));zip.write(new byte[]{1,2,3});zip.closeEntry();}
        LibraryService library=mock(LibraryService.class);
        LibraryChapter chapter=new LibraryChapter("chapter-1","Chapter1","1",1,"",true,archive.toString(),"https://weebcentral.com/chapters/one",null);
        LibraryTitle title=mock(LibraryTitle.class);when(title.chapters()).thenReturn(List.of(chapter));
        DownloadCompletionVerifier verifier=new DownloadCompletionVerifier(library);
        List<Map<String,String>> expected=List.of(Map.of("chapter_number","1"));
        assertFalse(verifier.complete(title,expected));
        when(library.isReaderReadyChapter(chapter)).thenReturn(true);
        assertTrue(verifier.complete(title,expected));
        assertFalse(verifier.complete(title,List.of(Map.of("chapter_number","1"),Map.of("chapter_number","2"))));
        assertFalse(verifier.complete(title,List.of()));
        Files.writeString(archive,"a nonempty file is not a valid CBZ");
        assertFalse(verifier.complete(title,expected));
    }
}
