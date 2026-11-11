package com.scriptarr.raven.downloader;

/** Unverified chapter page discovery that must remain retryable instead of becoming missing content. */
public final class SourcePageLookupException extends RuntimeException {
    /**
     * Preserve the discovery failure for durable title recovery.
     * @param message bounded diagnostic
     * @param cause underlying transport or parsing failure
     */
    public SourcePageLookupException(String message, Throwable cause) {
        super(message, cause);
    }
}
