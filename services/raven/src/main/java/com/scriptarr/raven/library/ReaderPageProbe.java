package com.scriptarr.raven.library;

/**
 * Redacted reader page diagnostics for Moon's same-origin reader probe.
 */
public record ReaderPageProbe(
    boolean ok,
    int status,
    int pageIndex,
    String contentTypeFamily,
    long contentLength,
    boolean cacheable,
    String failureCode,
    String source
) {
}
