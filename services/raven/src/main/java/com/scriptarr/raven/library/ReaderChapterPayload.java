package com.scriptarr.raven.library;

import java.util.List;

/**
 * Reader payload for an individual chapter.
 */
public record ReaderChapterPayload(
    LibraryTitle title,
    LibraryChapter chapter,
    List<ReaderPage> pages,
    String previousChapterId,
    String nextChapterId
) {
}
