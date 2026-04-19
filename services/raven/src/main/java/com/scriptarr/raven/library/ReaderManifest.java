package com.scriptarr.raven.library;

import java.util.List;

/**
 * Reader manifest for a Scriptarr library title.
 */
public record ReaderManifest(
    LibraryTitle title,
    List<LibraryChapter> chapters
) {
}
