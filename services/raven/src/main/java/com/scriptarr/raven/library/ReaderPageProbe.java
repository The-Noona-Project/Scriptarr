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
    String source,
    int segmentIndex,
    boolean thumbnail
) {
    /** @param ok readable @param status HTTP-equivalent result @param pageIndex logical index @param contentTypeFamily media family @param contentLength exact selected bytes @param cacheable cache authorization @param failureCode bounded reason @param source storage source */
    public ReaderPageProbe(boolean ok, int status, int pageIndex, String contentTypeFamily, long contentLength, boolean cacheable, String failureCode, String source) {
        this(ok, status, pageIndex, contentTypeFamily, contentLength, cacheable, failureCode, source, 0, false);
    }
}
