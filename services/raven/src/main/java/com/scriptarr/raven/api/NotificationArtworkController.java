package com.scriptarr.raven.api;

import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.NotificationArtwork;
import org.springframework.http.ResponseEntity;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Catalog-bound artwork serving for Sage's authenticated Discord notification broker. */
@RestController
public final class NotificationArtworkController {
    private final NotificationArtwork artwork;

    /** @param library canonical catalog and ready reader pages */
    public NotificationArtworkController(LibraryService library) { this.artwork = new NotificationArtwork(library); }

    /**
     * Resolve a real cover or a complete first-page thumbnail without exposing local paths.
     * @param titleId canonical title identity, never a caller-supplied URL
     * @return bounded image bytes or a retryable failure
     */
    @GetMapping("/v1/library/{titleId}/notification-art")
    public ResponseEntity<byte[]> artwork(@PathVariable("titleId") String titleId) {
        NotificationArtwork.Result result = artwork.load(titleId);
        if (result == null) return ResponseEntity.status(503).build();
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(result.mediaType()))
            .header("Cache-Control", "private, max-age=300")
            .header("X-Scriptarr-Art-Source", result.source()).body(result.bytes());
    }
}
