package com.scriptarr.raven.library;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Header-only dimensions and bounded lossless native regions, before FFmpeg sees a raster it cannot decode. */
final class VipsImageSource {
    private static final List<String> OPTIONS = List.of("vips", "--vips-concurrency=2", "--vips-cache-max=0", "--vips-cache-max-memory=67108864", "--vips-disc-threshold=67108864");
    private static final long MAX_INTERMEDIATE_BYTES = 600L * 1024 * 1024;

    /** Prevent construction of the worker's stateless source reader. */
    private VipsImageSource() { }

    /** @param source private immutable source file @return width and height without a full decoded Java bitmap @throws IOException when header data is invalid @throws InterruptedException on lease cancellation */
    static int[] dimensions(Path source) throws IOException, InterruptedException {
        int width = dimension(source, "width"), height = dimension(source, "height");
        if ((long) width * height > 300_000_000L) throw new IOException("Source exceeds the bounded logical-image pixel budget.");
        return new int[]{width, height};
    }

    /** @param source original private image @param target private lossless intermediate @param region exact logical source rectangle @throws IOException when the crop or byte budget fails @throws InterruptedException on lease cancellation */
    static void region(Path source, Path target, WebpSegmentation.Rectangle region) throws IOException, InterruptedException {
        if (region.x() < 0 || region.y() < 0 || region.width() <= 0 || region.height() <= 0 || region.width() > WebpSegmentation.MAX_DIMENSION || region.height() > WebpSegmentation.MAX_DIMENSION
            || (long) region.width() * region.height() > WebpSegmentation.MAX_TILE_PIXELS) throw new IOException("Saved legacy region exceeds the bounded raster budget; use the current conversion profile.");
        command(List.of("crop", source + "[access=sequential]", target.toString(), Integer.toString(region.x()), Integer.toString(region.y()), Integer.toString(region.width()), Integer.toString(region.height())));
        checkIntermediate(target);
    }

    /** @param source complete logical source @param target bounded whole-page thumbnail intermediate @throws IOException when thumbnail generation fails @throws InterruptedException on lease cancellation */
    static void thumbnail(Path source, Path target) throws IOException, InterruptedException {
        int[] size = dimensions(source); double scale = Math.min(1, Math.min(512.0 / size[0], 768.0 / size[1]));
        int width = Math.max(1, (int) (size[0] * scale)), height = Math.max(1, (int) (size[1] * scale));
        command(List.of("thumbnail", source.toString(), target.toString(), Integer.toString(width), "--height", Integer.toString(height), "--size", "force")); checkIntermediate(target);
    }

    /** @param source private input @param field one header dimension @return positive dimension @throws IOException when metadata is invalid @throws InterruptedException on cancellation */
    private static int dimension(Path source, String field) throws IOException, InterruptedException {
        try {
            int value = Integer.parseInt(new String(MediaProcess.run(List.of("vipsheader", "-f", field, source.toString()), true), java.nio.charset.StandardCharsets.UTF_8).trim());
            if (value <= 0) throw new IOException("Source dimensions are unavailable."); return value;
        } catch (NumberFormatException malformed) { throw new IOException("Source dimensions are malformed."); }
    }

    /** @param arguments fixed native operation and arguments @throws IOException when the native operation fails @throws InterruptedException on cancellation */
    private static void command(List<String> arguments) throws IOException, InterruptedException {
        java.util.ArrayList<String> command = new java.util.ArrayList<>(OPTIONS); command.addAll(arguments); MediaProcess.run(command, false);
    }

    /** @param target private lossless intermediate @throws IOException when native output is missing, linked or excessive */
    private static void checkIntermediate(Path target) throws IOException {
        if (Files.isSymbolicLink(target) || !Files.isRegularFile(target) || Files.size(target) <= 0 || Files.size(target) > MAX_INTERMEDIATE_BYTES) throw new IOException("Lossless region exceeds its bounded scratch budget.");
    }
}
