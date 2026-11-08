package com.scriptarr.raven.downloader;

/** A definite pre-acceptance rejection that did not consume or dispatch a bulk retry attempt. */
public final class BulkRetryBlockedException extends IllegalStateException {
    /**
     * Describe why an owned retry cannot yet be accepted.
     *
     * @param message safe rejection reason
     */
    public BulkRetryBlockedException(String message) { super(message); }
}
