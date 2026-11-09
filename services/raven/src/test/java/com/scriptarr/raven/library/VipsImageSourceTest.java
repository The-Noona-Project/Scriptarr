package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Native header/region boundaries avoid full-raster Java allocation and FFmpeg's pre-crop dimension rejection. */
class VipsImageSourceTest {
    /** An oversized valid header is read without asking FFmpeg to decode the complete frame. */
    @Test void oversizedHeaderUsesNativeMetadataOnly(@TempDir Path root) throws Exception {
        try (var media = mockStatic(MediaProcess.class)) {
            List<List<String>> calls = new ArrayList<>();
            media.when(() -> MediaProcess.run(anyList(), eq(true))).thenAnswer(call -> { List<String> args = call.getArgument(0); calls.add(args); return "17000\n".getBytes(java.nio.charset.StandardCharsets.UTF_8); });
            assertArrayEquals(new int[]{17000, 17000}, VipsImageSource.dimensions(root.resolve("source.png")));
            assertEquals(2, calls.size()); assertTrue(calls.stream().allMatch(args -> args.getFirst().equals("vipsheader")));
        }
    }

    /** Region processing is sequential, cache-bounded and preserves the exact source rectangle. */
    @Test void regionHasExactBoundedNativeArguments(@TempDir Path root) throws Exception {
        Path target = root.resolve("region.png"); Files.write(target, new byte[]{1});
        try (var media = mockStatic(MediaProcess.class)) {
            var region = new WebpSegmentation.Rectangle(0, 10, 20, 16383, 4096); VipsImageSource.region(root.resolve("source.png"), target, region);
            media.verify(() -> MediaProcess.run(List.of("vips", "--vips-concurrency=2", "--vips-cache-max=0", "--vips-cache-max-memory=67108864", "--vips-disc-threshold=67108864", "crop", root.resolve("source.png") + "[access=sequential]", target.toString(), "10", "20", "16383", "4096"), false));
        }
    }

    /** A saved unsafe legacy rectangle is rejected explicitly rather than pretending to encode altered geometry. */
    @Test void unsafeLegacyTileNeverReachesNativeDecoder(@TempDir Path root) {
        try (var media = mockStatic(MediaProcess.class)) {
            assertThrows(IOException.class, () -> VipsImageSource.region(root.resolve("source.png"), root.resolve("tile.png"), new WebpSegmentation.Rectangle(0, 0, 0, 16383, 16383))); media.verifyNoInteractions();
        }
    }

    /** Whole-page thumbnails use exact bounded aspect-fit dimensions, including extremely thin original pages. */
    @Test void thumbnailPreservesTheCompleteThinLogicalPage(@TempDir Path root) throws Exception {
        Path target = root.resolve("thumbnail.png"); Files.write(target, new byte[]{1});
        try (var media = mockStatic(MediaProcess.class)) {
            media.when(() -> MediaProcess.run(anyList(), eq(true))).thenAnswer(call -> ((List<String>) call.getArgument(0)).get(2).equals("width") ? "64\n".getBytes() : "17000\n".getBytes());
            VipsImageSource.thumbnail(root.resolve("source.png"), target);
            media.verify(() -> MediaProcess.run(List.of("vips", "--vips-concurrency=2", "--vips-cache-max=0", "--vips-cache-max-memory=67108864", "--vips-disc-threshold=67108864", "thumbnail", root.resolve("source.png").toString(), target.toString(), "2", "--height", "768", "--size", "force"), false));
        }
    }

    /** Real output byte bounds are checked even if a native tool acknowledged its operation. */
    @Test void excessiveLosslessScratchIsRejected(@TempDir Path root) throws Exception {
        Path target = root.resolve("excessive.png");
        try (FileChannel file = FileChannel.open(target, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) { file.position(600L * 1024 * 1024); file.write(ByteBuffer.wrap(new byte[]{1})); }
        try (var media = mockStatic(MediaProcess.class)) { assertThrows(IOException.class, () -> VipsImageSource.region(root.resolve("source.png"), target, new WebpSegmentation.Rectangle(0, 0, 0, 1, 1))); }
    }

    /** Lease cancellation propagates through the shared subprocess registry instead of leaving a native crop alive. */
    @Test void interruptedNativeCropPropagatesCancellation(@TempDir Path root) {
        try (var media = mockStatic(MediaProcess.class)) {
            media.when(() -> MediaProcess.run(anyList(), eq(false))).thenThrow(new InterruptedException("Lease ended."));
            assertThrows(InterruptedException.class, () -> VipsImageSource.region(root.resolve("source.png"), root.resolve("tile.png"), new WebpSegmentation.Rectangle(0, 0, 0, 1, 1)));
        }
    }
}
