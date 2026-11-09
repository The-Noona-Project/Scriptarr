package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Actual asynchronous migration preparation must persist trustworthy scope or a failure. */
class MigrationCatalogPreparationTest {
    /** The previous compact-card outage was a completed empty run; a failed raw census must persist failure instead. */
    @Test void failedEnumerationCannotCompleteAnEmptyRun() throws Exception {
        Fixture f = new Fixture(); f.broker.rawFailure = true;
        try { String id = f.startPreparation(); var result = await(f.runs, id, "failed");
            assertEquals("failed", result.get("status")); assertTrue(f.broker.listJobTasks(id, "").isEmpty()); verifyNoInteractions(f.library);
        } finally { f.runs.shutdown(); }
    }

    /** A successful full empty census still completes without creating content or invoking ingest. */
    @Test void genuineEmptyEnumerationCompletesWithZeroTitles() throws Exception {
        Fixture f = new Fixture();
        try { String id = f.startPreparation(); var result = await(f.runs, id, "completed");
            assertEquals(0, ((Map<?, ?>) result.get("result")).get("totalTitles")); verifyNoInteractions(f.library);
        } finally { f.runs.shutdown(); }
    }

    /** Distinct same-name canonical titles produce separate durable tasks and never use display-deduped card scope. */
    @Test void completeRawOwnershipCreatesBothSameNameTasks() throws Exception {
        Fixture f = new Fixture(); f.seed("a"); f.seed("b");
        when(f.library.ingestTitle(anyString(), anyString(), any(), any(), eq(false))).thenAnswer(call -> new ObjectMapper().treeToValue(f.broker.getLibraryTitle(call.getArgument(0)), LibraryTitle.class));
        when(f.library.ingestMigrationTitle(anyString(), anyString(), any(), any())).thenAnswer(call -> new LibraryService.MigrationPass(new ObjectMapper().treeToValue(f.broker.getLibraryTitle(call.getArgument(0)), LibraryTitle.class), false));
        try { String id = f.startPreparation(); var result = await(f.runs, id, "completed");
            assertEquals(2, ((Map<?, ?>) result.get("result")).get("totalTitles")); var tasks = f.broker.listJobTasks(id, ""); assertEquals(2, tasks.size());
            assertEquals(java.util.Set.of("a", "b"), java.util.stream.StreamSupport.stream(tasks.spliterator(), false).map(row -> row.path("payload").path("titleId").asText()).collect(java.util.stream.Collectors.toSet()));
            assertEquals(0, f.broker.listLibraryTitleCardsCalls()); assertEquals(1, f.broker.listLibraryTitlesCalls());
        } finally { f.runs.shutdown(); }
    }

    /** Failed exact ownership reload cannot be filtered away as if the canonical title never existed. */
    @Test void failedFullTitleReloadFailsPreparation() throws Exception {
        Fixture f = new Fixture(); f.seed("a"); f.broker.detailFailure = true;
        try { String id = f.startPreparation(); await(f.runs, id, "failed"); verifyNoInteractions(f.library); }
        finally { f.runs.shutdown(); }
    }

    /** Explicit per-type creation also rejects an unknown census before inventing a zero-title job. */
    @Test void unavailableExplicitCreationDoesNotPersistAnEmptyJob() {
        Fixture f = new Fixture(); f.broker.rawFailure = true;
        try { assertThrows(IllegalStateException.class, () -> f.runs.createRun(Map.of("libraryTypeSlug", "manga"))); assertTrue(f.broker.listJobs("scriptarr-raven", "raven-library-ingest", "").isEmpty()); }
        finally { f.runs.shutdown(); }
    }

    /** Incomplete chapter eligibility on a later full reload cannot turn an originally eligible owner into an empty scope. */
    @Test void malformedFullChapterReloadFailsPreparation() throws Exception {
        Fixture f = new Fixture(); f.seed("a"); f.broker.malformedChapter = true;
        try { String id = f.startPreparation(); await(f.runs, id, "failed"); verifyNoInteractions(f.library); }
        finally { f.runs.shutdown(); }
    }

    /** @param runs actual async service @param id exact run @param status required durable terminal state @return completed status @throws Exception when bounded waiting fails */
    private static Map<String, Object> await(LibraryIngestRunService runs, String id, String status) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos(); Map<String, Object> current;
        do { current = runs.status(id); if (status.equals(current.get("status"))) return current; Thread.sleep(10); } while (System.nanoTime() < deadline);
        fail("Expected " + status + " but observed " + current.get("status")); return current;
    }

    /** Broker and actual scheduler with only the title codec boundary mocked. */
    private static final class Fixture {
        private final Broker broker = new Broker();
        private final LibraryService library = mock(LibraryService.class);
        private final LibraryIngestRunService runs = new LibraryIngestRunService(library, broker, mock(ScriptarrLogger.class), true);

        /** @return exact durable preparation identity recovered by the actual asynchronous lifecycle */
        private String startPreparation() {
            String id = "ingestrun_census_fixture"; boolean webp = WebpMigrationControl.webp();
            new WebpMigrationControl(broker).set(true, "isolated-fixture");
            broker.putJob(id, Map.of("jobId", id, "kind", "raven-library-ingest", "ownerService", "scriptarr-raven", "status", "preparing", "requestedBy", "isolated-fixture",
                "payload", Map.of("libraryTypeSlug", "manga", "preparing", true, "format", webp ? "webp" : "avif", "mode", webp ? "webp-migrate" : "avif-force-rebuild"), "result", Map.of()));
            runs.resumeInterruptedRuns(); return id;
        }

        /** @param id unique canonical identity */
        private void seed(String id) {
            broker.putLibraryTitle(id, Map.of("id", id, "title", "Same display title", "libraryTypeSlug", "manga", "libraryTypeLabel", "Manga", "mediaType", "Manga"));
            broker.putLibraryChapters(id, Map.of("chapters", List.of(Map.of("id", id + "-c1", "available", true, "archivePath", "/downloads/downloaded/manga/" + id + "/c1.cbz", "pageCount", 1, "ingestStatus", "ready", "ingestedPageCount", 1))));
        }
    }

    /** Deterministic outage injection at the existing broker transport boundary. */
    private static final class Broker extends FakeRavenBrokerClient {
        private volatile boolean rawFailure, detailFailure, malformedChapter;
        /** @return complete raw snapshot or a transport failure */
        @Override public JsonNode listLibraryTitles() { if (rawFailure) throw new IllegalStateException("Isolated census transport failure."); return super.listLibraryTitles(); }
        /** @param id exact primary identity @return full title or malformed unavailable payload */
        @Override public JsonNode getLibraryTitle(String id) {
            if (detailFailure) return new ObjectMapper().createObjectNode().put("error", "Isolated lookup failure.");
            JsonNode row = super.getLibraryTitle(id);
            if (malformedChapter) ((com.fasterxml.jackson.databind.node.ObjectNode) row.path("chapters").get(0)).remove("available");
            return row;
        }
    }
}
