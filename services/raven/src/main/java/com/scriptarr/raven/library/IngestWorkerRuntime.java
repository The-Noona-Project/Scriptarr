package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** Standalone worker lifecycle, deliberately started before any coordinator Spring beans exist. */
public final class IngestWorkerRuntime {
    /** Prevent construction of this role entry point. */
    private IngestWorkerRuntime() { }

    /**
     * Run one chapter at a time, using only Sage leases and disposable worker scratch.
     * @param env isolated worker environment
     * @throws Exception when startup configuration or health binding is invalid
     */
    public static void run(Map<String, String> env) throws Exception {
        String workerId = env.getOrDefault("SCRIPTARR_RAVEN_WORKER_ID", "");
        if (!workerId.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("A bounded worker identity is required.");
        Path root = Path.of(env.getOrDefault("SCRIPTARR_RAVEN_WORKER_SCRATCH_ROOT", "/work")).toAbsolutePath().normalize(); Files.createDirectories(root);
        if (Files.isSymbolicLink(root)) throw new IOException("Worker scratch must not be a symbolic link.");
        IngestBrokerClient broker = new IngestBrokerClient(env); AtomicBoolean active = new AtomicBoolean(), selfTest = new AtomicBoolean(), stopping = new AtomicBoolean(); AtomicLong brokerSeen = new AtomicLong();
        String instanceId = UUID.randomUUID().toString();
        HttpServer health = HttpServer.create(new InetSocketAddress(Integer.parseInt(env.getOrDefault("SERVER_PORT", "8080"))), 0);
        health.createContext("/health", exchange -> { boolean ready = selfTest.get() && System.currentTimeMillis() - brokerSeen.get() < 120000;
            byte[] body = ("{\"status\":\"ok\",\"role\":\"ingest-worker\",\"ready\":" + ready + ",\"jobActive\":" + active.get() + "}").getBytes(StandardCharsets.UTF_8); exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, body.length); exchange.getResponseBody().write(body); exchange.close(); });
        health.start(); Thread poller = Thread.currentThread(); Runtime.getRuntime().addShutdownHook(new Thread(() -> { stopping.set(true); poller.interrupt(); MediaProcess.stopAll(); health.stop(0); }));
        var liveness = Executors.newSingleThreadScheduledExecutor();
        liveness.scheduleWithFixedDelay(() -> {
            try { broker.json("POST", "/workers/heartbeat", Map.of("workerId", workerId, "instanceId", instanceId,
                "capabilities", Map.of("format", "webp", "profileVersion", 1, "selfTestPassed", selfTest.get())), null); brokerSeen.set(System.currentTimeMillis()); }
            catch (Exception unavailable) { brokerSeen.set(0); }
        }, 0, 20, TimeUnit.SECONDS);
        Runtime.getRuntime().addShutdownHook(new Thread(liveness::shutdownNow));
        String claimId = UUID.randomUUID().toString(), leaseToken = UUID.randomUUID().toString() + UUID.randomUUID();
        while (!Thread.currentThread().isInterrupted()) {
            if (!selfTest.get()) { selfTest.set(new WebpChapterEncoder().selfTest(root.resolve("self-test"))); if (!selfTest.get()) { TimeUnit.SECONDS.sleep(30); continue; } }
            JsonNode claim;
            try { claim = broker.json("POST", "/claims", Map.of("workerId", workerId, "instanceId", instanceId, "claimId", claimId, "leaseToken", leaseToken,
                "capabilities", Map.of("format", "webp", "profileVersion", 1, "selfTestPassed", true)), null); brokerSeen.set(System.currentTimeMillis()); }
            catch (IOException unavailable) {
                if (unavailable instanceof IngestBrokerClient.Rejected rejected && java.util.Set.of(409, 410).contains(rejected.status())) {
                    claimId = UUID.randomUUID().toString(); leaseToken = UUID.randomUUID().toString() + UUID.randomUUID();
                }
                TimeUnit.SECONDS.sleep(5); continue;
            }
            if (claim == null) { claimId = UUID.randomUUID().toString(); leaseToken = UUID.randomUUID().toString() + UUID.randomUUID(); TimeUnit.SECONDS.sleep(5); continue; }
            active.set(true);
            try { process(broker, workerId, leaseToken, claim, root); }
            catch (InterruptedException leaseLost) { Thread.interrupted(); if (stopping.get()) break; }
            finally { active.set(false); claimId = UUID.randomUUID().toString(); leaseToken = UUID.randomUUID().toString() + UUID.randomUUID(); }
        }
    }

    /**
     * Process one fenced claim; lease loss interrupts the actual encoder subprocess.
     * @param broker Sage transport
     * @param workerId assigned worker identity
     * @param token transient lease secret
     * @param claim immutable job and accepted lease
     * @param root worker-private scratch root
     * @throws InterruptedException when worker shutdown interrupts processing
     */
    private static void process(IngestBrokerClient broker, String workerId, String token, JsonNode claim, Path root) throws InterruptedException {
        JsonNode job = claim.path("job"), lease = claim.path("lease"); String id = job.path("jobId").asText(); long epoch = lease.path("epoch").asLong();
        if (!id.matches("[A-Za-z0-9_-]{1,180}") || epoch <= 0) throw new IllegalArgumentException("Invalid fenced job identity.");
        Path scratch = root.resolve(id + "-" + epoch); Thread owner = Thread.currentThread();
        AtomicReference<WebpChapterEncoder.Progress> progress = new AtomicReference<>(new WebpChapterEncoder.Progress(0, job.path("spec").path("input").path("sourcePageCount").asInt(), 0, 0));
        AtomicLong expires = new AtomicLong(Instant.parse(lease.path("expiresAt").asText()).toEpochMilli());
        var heartbeat = Executors.newSingleThreadScheduledExecutor();
        heartbeat.scheduleWithFixedDelay(() -> {
            try { WebpChapterEncoder.Progress snapshot = progress.get(); JsonNode next = broker.jsonUntil("POST", "/jobs/" + id + "/heartbeat", Map.of("workerId", workerId, "epoch", epoch,
                "completedLogicalPages", snapshot.completedLogicalPages(), "totalLogicalPages", snapshot.totalLogicalPages(), "completedSegments", snapshot.completedSegments(), "totalSegments", snapshot.totalSegments()), token, expires.get());
                String until = next.path("lease").path("expiresAt").asText(); if (!until.isBlank()) expires.set(Instant.parse(until).toEpochMilli());
            } catch (Exception unavailable) { if (unavailable instanceof IngestBrokerClient.Rejected rejected && java.util.Set.of(403, 404, 409, 410).contains(rejected.status()) || System.currentTimeMillis() >= expires.get()) owner.interrupt(); }
        }, 20, 20, TimeUnit.SECONDS);
        String phase = "input_transfer";
        try {
            if (Files.exists(scratch)) delete(scratch); Files.createDirectories(scratch);
            Path input = scratch.resolve("input.cbz"); String query = "?workerId=" + workerId + "&epoch=" + epoch;
            retryTransfer(() -> broker.download("/jobs/" + id + "/input" + query, input, token, job.path("spec").path("input").path("sourceFingerprint").path("size").asLong()), expires);
            phase = "encoding";
            Path output = new WebpChapterEncoder().encodeWithProgress(input, job.path("spec"), scratch.resolve("output"), progress::set);
            phase = "artifact_upload";
            retryTransfer(() -> broker.upload("/jobs/" + id + "/artifact" + query, output, token), expires);
        } catch (IOException | RuntimeException failure) {
            try { broker.json("POST", "/jobs/" + id + "/fail", Map.of("workerId", workerId, "epoch", epoch,
                "error", Map.of("code", phase + "_failed", "message", "Worker " + phase + " failed (" + failure.getClass().getSimpleName()
                    + (failure instanceof IngestBrokerClient.Rejected rejected ? ", HTTP " + rejected.status() : "") + "); canonical input is unchanged.")), token); }
            catch (IOException ignored) { /* A lost lease cannot publish or mutate another execution. */ }
        } finally {
            heartbeat.shutdownNow();
            try { delete(scratch); } catch (IOException ignored) { /* Only disposable worker scratch may remain. */ }
        }
    }

    private static void retryTransfer(Transfer operation, AtomicLong expires) throws IOException, InterruptedException {
        long deadline = System.currentTimeMillis() + 120000;
        for (int attempt = 0; ; attempt++) {
            if (Thread.currentThread().isInterrupted() || System.currentTimeMillis() >= expires.get()) throw new InterruptedException("Worker transfer lease ended.");
            try { operation.run(); return; }
            catch (IOException failure) {
                if (!IngestBrokerClient.transientFailure(failure) || System.currentTimeMillis() >= Math.min(deadline, expires.get())) throw failure;
                Thread.sleep(Math.min(10000, 1000L << Math.min(4, attempt)));
            }
        }
    }

    @FunctionalInterface
    private interface Transfer { void run() throws IOException, InterruptedException; }

    /** @param root exact job scratch directory @throws IOException when scratch cannot be removed */
    private static void delete(Path root) throws IOException { if (Files.exists(root)) try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); } }
}
