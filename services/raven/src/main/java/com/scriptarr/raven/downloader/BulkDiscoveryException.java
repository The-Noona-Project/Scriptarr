package com.scriptarr.raven.downloader;

/** Explicit upstream discovery failure, distinct from a successful empty browse. */
public final class BulkDiscoveryException extends IllegalStateException {
    private final String code;
    private final int pagesScanned;

    /**
     * Create a safe discovery failure with completed-page evidence.
     *
     * @param code stable failure category
     * @param message safe diagnostic
     * @param pagesScanned completed browse pages
     * @param cause underlying transport or parse failure
     */
    public BulkDiscoveryException(String code, String message, int pagesScanned, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.pagesScanned = pagesScanned;
    }

    /** @return stable failure category */
    public String code() { return code; }

    /** @return number of completed browse pages */
    public int pagesScanned() { return pagesScanned; }
}
