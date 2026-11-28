package com.scriptarr.raven.library;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Comparator;
import java.util.Set;
import java.util.List;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

/** Bounded provider cover retrieval with an existing ready whole-page thumbnail fallback. */
public final class NotificationArtwork {
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final Set<String> COVER_HOSTS = Set.of("uploads.mangadex.org", "temp.compsci88.com",
        "weebcentral.com", "s4.anilist.co", "cdn.mangaupdates.com", "cdn.anime-planet.com");
    private final LibraryService library;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER).build();

    /** @param library canonical catalog and immutable reader pages */
    public NotificationArtwork(LibraryService library) { this.library = library; }

    /** @param bytes bounded raster @param mediaType validated MIME @param source cover or first-page */
    public record Result(byte[] bytes, String mediaType, String source) { }

    /**
     * Load artwork only from this title's stored cover or first complete reader page.
     * @param titleId canonical title identity
     * @return bounded artwork, or null when it must be retried
     */
    public Result load(String titleId) {
        LibraryTitle title = library.findTitleById(titleId);
        if (title == null || !title.id().equals(titleId)) return null;
        if (title.coverUrl() != null && !title.coverUrl().isBlank()) {
            try {
                URI uri = URI.create(title.coverUrl());
                if (allowed(uri)) {
                    HttpRequest request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(12))
                        .header("Accept", "image/jpeg,image/png,image/webp").header("User-Agent", "Scriptarr artwork").GET().build();
                    var future = client.sendAsync(request, ignored -> new BoundedCoverBody());
                    try {
                        HttpResponse<byte[]> response = future.get(15, TimeUnit.SECONDS);
                        if (response.statusCode() == 200) {
                            byte[] encoded = thumbnail(response.body());
                            if (encoded != null) return new Result(encoded, "image/jpeg", "cover");
                        }
                    } finally { if (!future.isDone()) future.cancel(true); }
                }
            } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
            catch (Exception unavailable) { /* A bad provider cover must not hide usable first-page artwork. */ }
        }
        if (title.chapters() == null) return null;
        for (LibraryChapter chapter : title.chapters().stream().filter(c -> c.available()
            && "ready".equals(c.ingestStatus()) && c.pageCount() > 0 && c.ingestedPageCount() >= c.pageCount())
            .sorted(Comparator.comparingDouble(NotificationArtwork::chapterOrder).thenComparing(LibraryChapter::id)).toList()) {
            try {
                // Notification reads must not hydrate the whole catalog or mutate missing-page quality state.
                Path file = DerivedPageManifest.page(chapter, 0, null, true);
                if (chapter.ingestRevision().startsWith("webp-") && Files.size(file) > 0 && Files.size(file) <= MAX_BYTES) {
                    return new Result(Files.readAllBytes(file), "image/webp", "first-page");
                }
            } catch (Exception unavailable) { /* A missing revision can be retried from another ready chapter. */ }
        }
        return null;
    }

    /** @param uri stored provider URI @return whether it belongs to a supported public cover host */
    static boolean allowed(URI uri) {
        return "https".equalsIgnoreCase(uri.getScheme()) && uri.getUserInfo() == null
            && (uri.getPort() == -1 || uri.getPort() == 443) && COVER_HOSTS.contains(uri.getHost());
    }

    /** Cancel oversized provider bodies while enforcing the complete response deadline. */
    private static final class BoundedCoverBody implements HttpResponse.BodySubscriber<byte[]> {
        private final HttpResponse.BodySubscriber<byte[]> delegate = HttpResponse.BodySubscribers.ofByteArray();
        private Flow.Subscription subscription;
        private long bytes;

        /** @return bounded asynchronous image body */
        @Override public CompletionStage<byte[]> getBody() { return delegate.getBody(); }
        /** @param incoming upstream flow control */
        @Override public void onSubscribe(Flow.Subscription incoming) { subscription = incoming; delegate.onSubscribe(incoming); }
        /** @param chunks provider chunks, rejected before retaining an excessive body */
        @Override public void onNext(List<ByteBuffer> chunks) {
            for (ByteBuffer chunk : chunks) bytes += chunk.remaining();
            if (bytes > MAX_BYTES) { subscription.cancel(); delegate.onError(new IOException("Cover exceeds its byte bound.")); }
            else delegate.onNext(chunks);
        }
        /** @param failure transport failure */
        @Override public void onError(Throwable failure) { delegate.onError(failure); }
        /** Complete a bounded image response. */
        @Override public void onComplete() { delegate.onComplete(); }
    }

    /** @param chapter canonical chapter @return numeric reading order, with specials last */
    private static double chapterOrder(LibraryChapter chapter) {
        try { return Double.parseDouble(chapter.chapterNumber()); } catch (Exception special) { return Double.MAX_VALUE; }
    }

    /**
     * Decode only a bounded real raster, then scale without stretching its aspect ratio.
     * @param bytes provider raster
     * @return safe bounded JPEG, or null for invalid or excessive images
     * @throws Exception image decoder failure
     */
    static byte[] thumbnail(byte[] bytes) throws Exception {
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) return null;
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (width <= 0 || height <= 0 || (long) width * height > 40_000_000) return null;
                BufferedImage source = reader.read(0);
                double scale = Math.min(1d, 1280d / Math.max(width, height));
                BufferedImage target = new BufferedImage(Math.max(1, (int) (width * scale)), Math.max(1, (int) (height * scale)), BufferedImage.TYPE_INT_RGB);
                Graphics2D graphics = target.createGraphics();
                try { graphics.setColor(Color.WHITE); graphics.fillRect(0, 0, target.getWidth(), target.getHeight());
                    graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                    graphics.drawImage(source, 0, 0, target.getWidth(), target.getHeight(), null); }
                finally { graphics.dispose(); }
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                if (!ImageIO.write(target, "jpeg", output) || output.size() > MAX_BYTES) return null;
                return output.toByteArray();
            } finally { reader.dispose(); }
        }
    }
}
