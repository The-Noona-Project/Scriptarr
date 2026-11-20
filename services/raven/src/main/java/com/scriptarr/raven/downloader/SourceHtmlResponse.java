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
        Connection.Response response = connection.ignoreHttpErrors(true).ignoreContentType(true).execute();
        try (var body = response.bodyStream()) {
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
            return Jsoup.parse(body, response.charset(), response.url().toString(), connection.request().parser()).connection(connection);
        }
    }
}
