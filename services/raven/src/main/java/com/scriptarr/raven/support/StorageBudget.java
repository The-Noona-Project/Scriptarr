package com.scriptarr.raven.support;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;

/** Fail-closed storage admission with a restart-durable, explicitly cleared pressure latch. */
public final class StorageBudget {
    private static final long GIB = 1L << 30;
    private StorageBudget() { }

    /** @param root managed data root @return observational capacity and latch state */
    public static Map<String, Object> status(Path root) {
        return status(root, configured("SCRIPTARR_STORAGE_RESERVE_BYTES", 100 * GIB));
    }

    /** @param root managed root @param reserve required headroom @return observational storage state */
    public static Map<String, Object> status(Path root, long reserve) {
        try {
            long available = Files.getFileStore(root).getUsableSpace();
            boolean latched = Files.exists(root.resolve(".storage-pressure"));
            return Map.of("ready", available >= reserve && !latched, "availableBytes", available,
                "reserveBytes", reserve, "resumeBytes", Math.max(reserve, configured("SCRIPTARR_STORAGE_RESUME_BYTES", 150 * GIB)), "latched", latched);
        } catch (Exception unavailable) { return Map.of("ready", false, "reason", "storage_unavailable"); }
    }

    /** @param root managed root @throws IOException when storage cannot safely accept more work */
    public static void require(Path root) throws IOException {
        if (root == null) return;
        Map<String, Object> state = status(root);
        if (Boolean.TRUE.equals(state.get("ready"))) return;
        Path marker = root.resolve(".storage-pressure"), temporary = root.resolve(".storage-pressure.partial");
        synchronized (StorageBudget.class) {
            if (!Files.exists(marker)) try {
                Files.writeString(temporary, "storage_pressure: owner approval is required after capacity recovery.\n");
                Files.move(temporary, marker, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException cannotLatch) { /* The current operation still fails closed on an exhausted filesystem. */ }
        }
        throw new IOException("storage_pressure: Data storage is below its reserve or awaits explicit resume approval.");
    }

    /** @param root managed root @throws IOException when an explicit owner resume has insufficient headroom */
    public static synchronized void approveResume(Path root) throws IOException {
        if (root == null || !Files.exists(root.resolve(".storage-pressure"))) return;
        long threshold = Math.max(configured("SCRIPTARR_STORAGE_RESERVE_BYTES", 100 * GIB), configured("SCRIPTARR_STORAGE_RESUME_BYTES", 150 * GIB));
        if (Files.getFileStore(root).getUsableSpace() < threshold) throw new IOException("storage_pressure: Resume requires the configured recovery headroom.");
        Files.delete(root.resolve(".storage-pressure"));
    }

    /** @param name environment setting @param fallback safe default @return nonnegative configured capacity */
    private static long configured(String name, long fallback) {
        try { long value = Long.parseLong(System.getenv(name)); return value >= 0 ? value : fallback; }
        catch (RuntimeException missing) { return fallback; }
    }
}
