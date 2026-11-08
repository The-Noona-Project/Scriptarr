package com.scriptarr.raven.downloader;

/**
 * A bulk creation key or approval token conflicts with an earlier durable action.
 */
public final class BulkRunConflictException extends IllegalStateException {
    /**
     * Describe the conflict without changing the existing durable run.
     *
     * @param message operator-safe conflict description
     */
    public BulkRunConflictException(String message) {
        super(message);
    }
}
