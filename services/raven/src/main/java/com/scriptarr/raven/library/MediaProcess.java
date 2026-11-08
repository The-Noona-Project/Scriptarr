package com.scriptarr.raven.library;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/** Bounded media subprocesses with observable lifetime and interrupt-driven destruction. */
public final class MediaProcess {
    private static final Set<Process> ACTIVE = ConcurrentHashMap.newKeySet();

    /** Prevent construction of this process registry. */
    private MediaProcess() { }

    /** @return actual live media children, including processes still winding down */
    public static long activeCount() { return ACTIVE.stream().filter(Process::isAlive).count(); }

    /** Kill only this worker's registered media children during process shutdown. */
    public static void stopAll() { for (Process process : ACTIVE) if (process.isAlive()) process.destroyForcibly(); }

    /**
     * Execute a bounded local media command and capture small diagnostic JSON only when requested.
     * @param command fixed executable and argument vector
     * @param capture whether small stdout is required
     * @return bounded stdout bytes
     * @throws IOException when execution fails or output exceeds the metadata bound
     * @throws InterruptedException when cancellation interrupts the command
     */
    public static byte[] run(List<String> command, boolean capture) throws IOException, InterruptedException {
        Path output = capture ? Files.createTempFile("raven-media-probe-", ".json") : null;
        ProcessBuilder builder = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.redirectOutput(capture ? ProcessBuilder.Redirect.to(output.toFile()) : ProcessBuilder.Redirect.DISCARD);
        Process process = builder.start(); ACTIVE.add(process);
        try {
            if (!process.waitFor(120, TimeUnit.SECONDS) || process.exitValue() != 0) {
                throw new IOException("Media conversion failed or exceeded its time limit.");
            }
            if (!capture) return new byte[0];
            if (Files.size(output) > 8192) throw new IOException("Media probe exceeded its metadata limit.");
            return Files.readAllBytes(output);
        } finally {
            try { if (process.isAlive()) { process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS); } }
            finally { if (!process.isAlive()) ACTIVE.remove(process); if (output != null) Files.deleteIfExists(output); }
        }
    }
}
