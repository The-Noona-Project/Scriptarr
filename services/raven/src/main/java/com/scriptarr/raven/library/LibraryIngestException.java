package com.scriptarr.raven.library;

/**
 * Typed failure from the WebP ingest pipeline.
 */
public final class LibraryIngestException extends RuntimeException {
    private final String failureCode;

    /**
     * Create a typed ingest failure.
     *
     * @param failureCode stable failure code surfaced to admin tools
     * @param message redacted failure message
     */
    public LibraryIngestException(String failureCode, String message) {
        super(message);
        this.failureCode = failureCode == null || failureCode.isBlank() ? "ingest_failed" : failureCode;
    }

    /**
     * @return stable failure code
     */
    public String failureCode() {
        return failureCode;
    }
}
