package com.scriptarr.raven.downloader;

import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import org.jsoup.Connection;
import org.jsoup.nodes.Document;

/** One pacing and response-ownership path for source browsing and chapter-image discovery. */
final class SourceRequests {
    private SourceRequests() { }

    /** @param connection source request @param cancelled cancellation @return successful HTML @throws Exception on source failure */
    static Document fetch(Connection connection, BooleanSupplier cancelled) throws Exception {
        return fetch(connection, cancelled, "weebcentral.com".equalsIgnoreCase(connection.request().url().getHost()) ? ProviderCooldown.SOURCE : null);
    }

    /** @param connection source request @param cancelled cancellation @param gate shared limiter or isolated fixture gate @return HTML @throws Exception on source failure */
    static Document fetch(Connection connection, BooleanSupplier cancelled, ProviderCooldown gate) throws Exception {
        if (gate != null) gate.await(cancelled);
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Source request cancelled.");
        Document document = SourceHtmlResponse.fetch(connection, cancelled, retryAfter -> {
            if (gate != null) gate.limited(retryAfter, System.currentTimeMillis());
        });
        if (gate != null) gate.succeeded();
        return document;
    }
}
