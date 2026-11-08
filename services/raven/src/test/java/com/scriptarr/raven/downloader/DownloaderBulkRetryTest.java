package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Verify durable retry identities prevent extra executions across persistence and restart windows. */
class DownloaderBulkRetryTest {
    @TempDir Path root;
    private DownloaderService downloader;

    /** Stop test workers after every case. */
    @AfterEach
    void close() { if (downloader != null) downloader.shutdown(); }

    /** Persist the accepted queued receipt before provider execution, and never replay a terminal attempt. */
    @Test
    void receiptPrecedesExecutionAndTerminalReplayDoesNotExecuteAgain() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of());
        AtomicInteger executions = new AtomicInteger();
        doAnswer(call -> {
            JsonNode durable = context.broker().listDownloadTasks().get(0);
            assertEquals("retry-2", durable.path("details").path("bulkRetryAttempt").path("attemptId").asText());
            assertEquals(2, durable.path("details").path("bulkRetryAttempt").path("cumulativeAttempt").asInt());
            executions.incrementAndGet();
            throw new IllegalStateException("Source offline.");
        }).when(context.provider()).getChapters(anyString());
        retry("retry-2", 2, 1, 2);
        awaitFailure();
        Map<String, Object> replay = retry("retry-2", 2, 1, 2);
        assertEquals("failed", replay.get("status"));
        assertEquals(1, executions.get());
        Thread.sleep(100);
        assertEquals(1, executions.get());
    }

    /** An uncommitted retry shadow cannot become a local accepted receipt or enqueue executable work. */
    @Test
    void rejectedDurableWriteDoesNotPublishOrConsumeRetry() throws Exception {
        AtomicBoolean fail = new AtomicBoolean();
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient() {
            @Override public JsonNode putDownloadTask(String id, Map<String, Object> task) {
                if (fail.get()) throw new IllegalStateException("Broker rejected write.");
                return super.putDownloadTask(id, task);
            }
        };
        Context context = context(broker, Map.of());
        fail.set(true);
        assertThrows(IllegalStateException.class, () -> retry("retry-2", 2, 1, 2));
        assertEquals("failed", downloader.snapshot().getFirst().get("status"));
        assertNull(downloader.snapshot().getFirst().get("bulkRetryAttempt"));
        assertFalse(broker.listDownloadTasks().get(0).path("details").has("bulkRetryAttempt"));
        verify(context.provider(), never()).getChapters(anyString());
        fail.set(false);
        retry("retry-2", 2, 1, 2);
        awaitFailure();
        verify(context.provider(), times(1)).getChapters(anyString());
    }

    /** A server-accepted write with a lost response is reattached once using its same durable identity. */
    @Test
    void lostWriteAcknowledgementReattachesQueuedReceiptWithoutAnExtraAttempt() throws Exception {
        AtomicBoolean loseAck = new AtomicBoolean();
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient() {
            @Override public JsonNode putDownloadTask(String id, Map<String, Object> task) {
                JsonNode saved = super.putDownloadTask(id, task);
                if (task.containsKey("bulkRetryAttempt") && loseAck.compareAndSet(true, false)) throw new IllegalStateException("Write response lost.");
                return saved;
            }
        };
        Context context = context(broker, Map.of());
        loseAck.set(true);
        assertThrows(IllegalStateException.class, () -> retry("retry-2", 2, 1, 2));
        assertEquals("queued", broker.listDownloadTasks().get(0).path("status").asText());
        verify(context.provider(), never()).getChapters(anyString());
        retry("retry-2", 2, 1, 2);
        awaitFailure();
        retry("retry-2", 2, 1, 2);
        verify(context.provider(), times(1)).getChapters(anyString());
    }

    /** An executor rejection leaves a replayable durable receipt rather than an orphan local queue entry. */
    @Test
    void acceptedRetrySurvivesExecutorRejectionBeforeDispatch() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of());
        var workerField = DownloaderService.class.getDeclaredField("queueWorker");
        workerField.setAccessible(true);
        Object original = workerField.get(downloader);
        ThreadPoolExecutor rejected = mock(ThreadPoolExecutor.class);
        doThrow(new RejectedExecutionException("Temporary test dispatch rejection.")).when(rejected).execute(any());
        workerField.set(downloader, rejected);
        try {
            assertThrows(RejectedExecutionException.class, () -> retry("retry-2", 2, 1, 2));
            assertEquals("queued", context.broker().listDownloadTasks().get(0).path("status").asText());
            verify(context.provider(), never()).getChapters(anyString());
        } finally { workerField.set(downloader, original); }
        retry("retry-2", 2, 1, 2);
        awaitFailure();
        verify(context.provider(), times(1)).getChapters(anyString());
    }

    /** Restored queued retries remain attached while a worker is between dequeue and running registration. */
    @Test
    void restoredRetryReplayCannotDuplicateTheDequeuedExecution() throws Exception {
        restoredDispatchGap(true);
    }

    /** Initial owned tasks use the same dispatch gate as retries when a durable plan is replayed. */
    @Test
    void restoredInitialPlanCannotDuplicateTheDequeuedExecution() throws Exception {
        restoredDispatchGap(false);
    }

    /** Reprioritizing a physically queued owned task releases its old dispatch and attaches its replacement. */
    @Test
    void ownedQueueReprioritizationKeepsExactlyOneExecutableEntry() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of());
        HeldWorker held = holdDispatch();
        Runnable execution;
        try {
            retry("retry-2", 2, 1, 2);
            downloader.updateTaskPriority("owned", "high");
            assertEquals(1, held.queue().size());
            verify(held.worker(), times(2)).execute(any());
            execution = held.queue().remove();
        } finally { restoreWorker(held); }
        execution.run();
        awaitFailure();
        verify(context.provider(), times(1)).getChapters(anyString());
    }

    /** Broker projections that retain only details still restore and replay the accepted terminal receipt. */
    @Test
    void terminalReceiptSurvivesDetailsOnlyRestoration() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of("attemptId", "retry-2", "cumulativeAttempt", 2,
            "approvalGeneration", 1, "approvalAttempt", 2, "acceptedAt", "2026-11-07T00:00:00Z"));
        assertNotNull(downloader.snapshot().getFirst().get("bulkRetryAttempt"));
        Map<String, Object> replay = retry("retry-2", 2, 1, 2);
        assertEquals("failed", replay.get("status"));
        verify(context.provider(), never()).getChapters(anyString());
        assertEquals(2, context.broker().listDownloadTasks().get(0).path("details").path("bulkRetryAttempt").path("cumulativeAttempt").asInt());
    }

    /** The third execution is terminal for its approval; stale identities and fourth ordinals are rejected. */
    @Test
    void conflictingIdentitiesCannotExceedThreeExecutionsPerApproval() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of("attemptId", "retry-2", "cumulativeAttempt", 2,
            "approvalGeneration", 1, "approvalAttempt", 2, "acceptedAt", "2026-11-07T00:00:00Z"));
        retry("retry-3", 3, 1, 3);
        awaitFailure();
        assertThrows(BulkRetryBlockedException.class, () -> retry("retry-4", 4, 1, 4));
        assertThrows(BulkRetryBlockedException.class, () -> retry("conflicting-3", 3, 1, 3));
        assertThrows(BulkRetryBlockedException.class, () -> retry("retry-3", 4, 2, 1));
        assertThrows(BulkRetryBlockedException.class, () -> downloader.retryBulkTask("owned", "another-run", "batch", "retry-4", 4, 2, 1));
        acceptAfterWindDown("retry-4", 4, 2, 1);
        awaitFailure();
        verify(context.provider(), times(2)).getChapters(anyString());
        assertEquals(4, context.broker().listDownloadTasks().get(0).path("details").path("bulkRetryAttempt").path("cumulativeAttempt").asInt());
    }

    /** A known winding-down thread rejects before accepting a new ordinal, preserving the retry allowance. */
    @Test
    void windingDownRejectionDoesNotSpendAnExecution() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of());
        CountDownLatch windingDown = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        doAnswer(call -> {
            windingDown.countDown();
            assertTrue(finish.await(5, TimeUnit.SECONDS));
            return null;
        }).when(context.logger()).error(anyString(), anyString(), any(Throwable.class));
        retry("retry-2", 2, 1, 2);
        try {
            assertTrue(windingDown.await(5, TimeUnit.SECONDS));
            assertThrows(BulkRetryBlockedException.class, () -> retry("retry-3", 3, 1, 3));
            assertEquals("retry-2", context.broker().listDownloadTasks().get(0).path("details").path("bulkRetryAttempt").path("attemptId").asText());
        } finally { finish.countDown(); }
        acceptAfterWindDown("retry-3", 3, 1, 3);
        awaitFailure();
        verify(context.provider(), times(2)).getChapters(anyString());
    }

    /** Replaying a queued receipt while its provider is running cannot enqueue duplicate work. */
    @Test
    void concurrentAcceptedReplayRunsOnlyOnce() throws Exception {
        Context context = context(new FakeRavenBrokerClient(), Map.of());
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        doAnswer(call -> {
            started.countDown(); assertTrue(finish.await(5, TimeUnit.SECONDS)); throw new IllegalStateException("Source offline.");
        }).when(context.provider()).getChapters(anyString());
        retry("retry-2", 2, 1, 2);
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS));
            for (int index = 0; index < 10; index++) retry("retry-2", 2, 1, 2);
        } finally { finish.countDown(); }
        awaitFailure();
        verify(context.provider(), times(1)).getChapters(anyString());
    }

    private void restoredDispatchGap(boolean retryReceipt) throws Exception {
        Map<String, Object> receipt = retryReceipt ? Map.of("attemptId", "retry-2", "cumulativeAttempt", 2,
            "approvalGeneration", 1, "approvalAttempt", 2, "acceptedAt", "2026-11-07T00:00:00Z") : Map.of();
        Context context = context(new FakeRavenBrokerClient(), receipt, false);
        Map<String, Object> persisted = new com.fasterxml.jackson.databind.ObjectMapper().convertValue(context.broker().listDownloadTasks().get(0), Map.class);
        persisted.put("status", "queued");
        context.broker().putDownloadTask("owned", persisted);
        HeldWorker held = holdDispatch();
        Runnable execution;
        try {
            downloader.restorePersistedTasks();
            assertTrue(downloader.bulkRunGateway().restoreCompletion().isDone());
            execution = held.queue().remove();
            var queuedField = DownloaderService.class.getDeclaredField("queuedTasks");
            queuedField.setAccessible(true);
            ((Map<?, ?>) queuedField.get(downloader)).remove("owned");
            // This is the real process dequeue-before-running-registration window.
            if (retryReceipt) retry("retry-2", 2, 1, 2);
            else downloader.queueBulkOwned("owned", "run", "batch", "plan", new DownloadRequest("Alpha", "https://weebcentral.com/series/alpha", "Manhua", "qa", "weebcentral", "", Map.of(), Map.of(), "", "normal"));
            verify(held.worker(), times(1)).execute(any());
            assertTrue(held.queue().isEmpty());
        } finally { restoreWorker(held); }
        execution.run();
        awaitFailure();
        verify(context.provider(), times(1)).getChapters(anyString());
    }

    private HeldWorker holdDispatch() throws Exception {
        var workerField = DownloaderService.class.getDeclaredField("queueWorker");
        workerField.setAccessible(true);
        ThreadPoolExecutor original = (ThreadPoolExecutor) workerField.get(downloader);
        ThreadPoolExecutor held = mock(ThreadPoolExecutor.class);
        BlockingQueue<Runnable> queue = new PriorityBlockingQueue<>();
        when(held.getQueue()).thenReturn(queue);
        when(held.getMaximumPoolSize()).thenReturn(2);
        when(held.getCorePoolSize()).thenReturn(2);
        doAnswer(call -> { queue.add(call.getArgument(0)); return null; }).when(held).execute(any());
        workerField.set(downloader, held);
        return new HeldWorker(original, held, queue);
    }

    private void restoreWorker(HeldWorker held) throws Exception {
        var workerField = DownloaderService.class.getDeclaredField("queueWorker");
        workerField.setAccessible(true);
        workerField.set(downloader, held.original());
    }

    private Context context(FakeRavenBrokerClient broker, Map<String, Object> receipt) throws Exception {
        return context(broker, receipt, true);
    }

    private Context context(FakeRavenBrokerClient broker, Map<String, Object> receipt, boolean restore) throws Exception {
        Map<String, Object> details = new java.util.LinkedHashMap<>(Map.of("bulkRunId", "run", "bulkBatchId", "batch", "bulkPlanId", "plan"));
        if (!receipt.isEmpty()) details.put("bulkRetryAttempt", receipt);
        broker.putDownloadTask("owned", Map.ofEntries(Map.entry("taskId", "owned"), Map.entry("jobId", "owned"), Map.entry("titleName", "Alpha"),
            Map.entry("titleUrl", "https://weebcentral.com/series/alpha"), Map.entry("requestType", "Manhua"), Map.entry("providerId", "weebcentral"),
            Map.entry("status", "failed"), Map.entry("percent", 90), Map.entry("message", "Source failure."), Map.entry("details", details)));
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(root);
        broker.setSetting("raven.download.providers", Map.of("providers", List.of(Map.of("id", "weebcentral", "enabled", true, "priority", 1))));
        RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
        DownloadProvider provider = mock(DownloadProvider.class);
        when(provider.id()).thenReturn("weebcentral"); when(provider.name()).thenReturn("WeebCentral"); when(provider.supportsUrl(anyString())).thenReturn(true);
        when(provider.getChapters(anyString())).thenThrow(new IllegalStateException("Source offline."));
        downloader = new DownloaderService(new DownloadProviderRegistry(List.of(provider), settings), null, mock(LibraryService.class),
            mock(DownloadIntakeService.class), mock(MetadataService.class), broker, settings, logger);
        if (restore) downloader.restorePersistedTasks();
        return new Context(broker, provider, logger);
    }

    private Map<String, Object> retry(String id, int cumulative, int generation, int ordinal) {
        return downloader.retryBulkTask("owned", "run", "batch", id, cumulative, generation, ordinal);
    }

    private void acceptAfterWindDown(String id, int cumulative, int generation, int ordinal) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (true) {
            try { retry(id, cumulative, generation, ordinal); return; }
            catch (BulkRetryBlockedException blocked) { if (System.nanoTime() >= deadline) throw blocked; Thread.sleep(10); }
        }
    }

    private void awaitFailure() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if ("failed".equals(downloader.bulkRunGateway().ownedTasks("run", "batch").getFirst().get("status"))) return;
            Thread.sleep(10);
        }
        fail("The accepted retry did not reach its expected source failure.");
    }

    private record Context(FakeRavenBrokerClient broker, DownloadProvider provider, ScriptarrLogger logger) { }
    private record HeldWorker(ThreadPoolExecutor original, ThreadPoolExecutor worker, BlockingQueue<Runnable> queue) { }
}
