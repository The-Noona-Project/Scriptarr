package com.scriptarr.raven.downloader;

import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.jsoup.Connection;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;

/** Handles status headers before MIME validation and closes every source response body. */
final class SourceHtmlResponse {
    /** Utility holder. */
    private SourceHtmlResponse() { }

    /**
     * @param connection source request
     * @param cancelled cooperative cancellation
     * @param limited receives Retry-After on HTTP 429 before any body parsing
     * @return parsed document with the original request context
     * @throws Exception on rejected status, MIME, cancellation or body failure
     */
    static Document fetch(Connection connection, BooleanSupplier cancelled, Consumer<String> limited) throws Exception {
        long started = System.nanoTime(), budget = connection.request().timeout() == 0 ? Long.MAX_VALUE : java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(connection.request().timeout());
        Connection.Response response = connection.ignoreHttpErrors(true).ignoreContentType(true).execute();
        try (var body = new java.io.FilterInputStream(response.bodyStream()) {
            /** @throws java.net.SocketTimeoutException when the whole request deadline expires */
            private void checkDeadline() throws java.net.SocketTimeoutException {
                if (Thread.currentThread().isInterrupted() || cancelled.getAsBoolean()) throw new CancellationException("Source response cancelled.");
                if (System.nanoTime() - started >= budget) throw new java.net.SocketTimeoutException("Source request elapsed-time deadline exceeded.");
            }
            /** @return next byte @throws java.io.IOException on deadline or transport failure */
            @Override public int read() throws java.io.IOException {checkDeadline();int value = super.read();checkDeadline();return value;}
            /** @param bytes target buffer @param offset first byte @param length maximum bytes @return bytes read @throws java.io.IOException on deadline or transport failure */
            @Override public int read(byte[] bytes, int offset, int length) throws java.io.IOException {checkDeadline();int count = super.read(bytes, offset, length);checkDeadline();return count;}
        }) {
            if (Thread.currentThread().isInterrupted() || cancelled.getAsBoolean()) throw new CancellationException("Source response cancelled.");
            if (response.statusCode() == 429) limited.accept(response.header("Retry-After"));
            if (response.statusCode() >= 400) throw new org.jsoup.HttpStatusException("Source HTTP error", response.statusCode(), response.url().toString());
            String mime = response.contentType();
            if (mime != null) {
                mime = mime.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
                if (!mime.startsWith("text/") && !mime.equals("application/xml") && !mime.matches("application/[a-z0-9.+-]+\\+xml")) {
                    throw new org.jsoup.UnsupportedMimeTypeException("Source response is not HTML or XML", mime, response.url().toString());
                }
            }
            Document document = Jsoup.parse(body, response.charset(), response.url().toString(), connection.request().parser()).connection(connection);
            if (System.nanoTime() - started >= budget) throw new java.net.SocketTimeoutException("Source request elapsed-time deadline exceeded.");
            return document;
        }
    }
}
