package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Verify durable replay, checked persistence, cancellation and uncapped ownership evidence. */
class BulkQueueCoordinatorTest {
    /** Every supported type selects thirty stable titles after complete discovery and before its first enqueue. */
    @Test void cappedTypeBatchesPersistAllMembershipBeforeEnqueueAndReplay() {
        for (String type : List.of("Manga", "Manhwa", "Manhua", "OEL")) {
            Fixture f = cappedFixture(type, 35);
            when(f.downloader.queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any())).thenAnswer(call -> {
                var rows = f.broker.listJobTasks("run", "");
                assertTrue(rows.toString().contains("bulk-selection-plan"));
                assertEquals(30, java.util.stream.StreamSupport.stream(rows.spliterator(), false)
                    .filter(row -> row.path("payload").has("request")).count());
                return f.accept(call);
            });
            var state = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();
            BulkQueueCoordinator coordinator = f.coordinator();
            var first = coordinator.queueBatchLimited("run", "batch", "weebcentral", type, false, "a", "owner", 30, () -> false, state::set);
            assertEquals(30, first.queuedCount()); assertEquals(35, first.matchedCount());
            assertEquals(30, state.get().get("selectedCount")); assertEquals(5, state.get().get("deferredByLimitCount"));
            var replay = f.coordinator().queueBatchLimited("run", "batch", "weebcentral", type, false, "a", "owner", 30, () -> false, state::set);
            assertEquals(first.queuedTaskIds(), replay.queuedTaskIds());
            assertEquals("Alpha 00", first.queuedTitles().getFirst()); assertEquals("Alpha 29", first.queuedTitles().getLast());
            verify(f.downloader, times(30)).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
            verify(f.provider, times(1)).browseTitlesAlphabetically(anyString(), anyBoolean(), anyString(), any(), any());
        }
    }

    /** An unresolved selected slot pauses all dispatch and survives explicit retry without replacement. */
    @Test void cappedPreparationFailureRetainsSlotAndDefersDispatchUntilResolved() {
        Fixture f = cappedFixture("Manhua", 5);
        String failed = candidateUrl(0);
        when(f.provider.getTitleDetails(eq(failed))).thenThrow(new IllegalStateException("Source temporarily unavailable."));
        var state = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();
        var first = f.coordinator().queueBatchLimited("run", "batch", "weebcentral", "Manhua", false, "a", "owner", 3, () -> false, state::set);
        assertEquals(1, first.failedCount()); assertEquals(3, state.get().get("selectedCount"));
        verify(f.downloader, never()).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
        when(f.provider.getTitleDetails(eq(failed))).thenReturn(new TitleDetails("", "Manhua", List.of(), "Ongoing", "", false, false, false, List.of(), List.of()));
        var retry = f.coordinator().queueBatchLimited("run", "batch", "weebcentral", "Manhua", false, "a", "owner", 3, () -> false, state::set);
        assertEquals(List.of("Alpha 00", "Alpha 01", "Alpha 02"), retry.queuedTitles());
        assertEquals(2, state.get().get("deferredByLimitCount"));
    }

    /** A failed membership commit cannot dispatch any title, even when every request was prepared. */
    @Test void cappedManifestWriteFailureDoesNotDispatch() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient() {
            @Override public JsonNode putJobTask(String jobId, String taskId, Map<String, Object> payload) {
                if (taskId.startsWith("bulk_selection_")) throw new IllegalStateException("Lost manifest write.");
                return super.putJobTask(jobId, taskId, payload);
            }
        };
        Fixture f = new Fixture(broker);
        assertThrows(IllegalStateException.class, () -> f.coordinator().queueBatchLimited("run", "batch", "weebcentral", "Manhua", false, "a", "owner", 30, () -> false, ignored -> { }));
        verify(f.downloader, never()).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
    }

    /** Cancellation during capped preparation cannot dispatch any partially prepared title. */
    @Test void cancellationDuringCappedPreparationCannotEscapeToQueue() {
        Fixture f = cappedFixture("Manhua", 5);
        var cancelled = new java.util.concurrent.atomic.AtomicBoolean();
        when(f.provider.getTitleDetails(anyString())).thenAnswer(call -> {
            cancelled.set(true);
            return new TitleDetails("", "Manhua", List.of(), "Ongoing", "", false, false, false, List.of(), List.of());
        });
        assertThrows(java.util.concurrent.CancellationException.class, () -> f.coordinator().queueBatchLimited(
            "run", "batch", "weebcentral", "Manhua", false, "a", "owner", 3, cancelled::get, ignored -> { }));
        verify(f.downloader, never()).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
        assertFalse(f.broker.listJobTasks("run", "").toString().contains("bulk-selection-plan"));
    }

    /** Metadata rechecks of policy skips cannot expand membership or permanently block a frozen capped batch. */
    @Test void metadataRecheckOutsideFrozenCapIsExplicitlyDeferredWithoutReplacingSelectedWork() {
        Fixture f = cappedFixture("Manhua", 3);
        when(f.intake.resolveBulkMetadata(anyString(), eq(candidateUrl(0)), anyString(), anyString(), anyList()))
            .thenReturn(new DownloadIntakeService.BulkMetadataResolution("unmatched", Map.of(), Map.of()));
        var state = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();
        var first = f.coordinator().queueBatchLimited("run", "batch", "weebcentral", "Manhua", false, "a", "owner", 1, () -> false, state::set);
        assertEquals(List.of("Alpha 01"), first.queuedTitles());
        JsonNode skipped = java.util.stream.StreamSupport.stream(f.broker.listJobTasks("run", "").spliterator(), false)
            .filter(row -> "noMetadata".equals(row.path("result").path("category").asText())).findFirst().orElseThrow();
        var row = new com.fasterxml.jackson.databind.ObjectMapper().convertValue(skipped, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() { });
        var payload = new java.util.LinkedHashMap<>((Map<String, Object>)row.get("payload"));
        payload.put("metadataRecheckHistory", Map.of("recheck-1", Map.of("result", row.get("result"))));
        row.put("payload", payload); row.put("result", Map.of("category", "unresolved", "reason", "Metadata policy recheck requested.")); row.put("status", "planned");
        f.broker.putJobTask("run", skipped.path("taskId").asText(), row);
        for (int replay = 0; replay < 2; replay++) {
            var result = f.coordinator().queueBatchLimited("run", "batch", "weebcentral", "Manhua", false, "a", "owner", 1, () -> false, state::set);
            assertEquals(first.queuedTaskIds(), result.queuedTaskIds()); assertEquals(0, result.failedCount());
            assertEquals(1, state.get().get("selectedCount")); assertEquals(2, state.get().get("deferredByLimitCount"));
        }
        assertTrue(f.broker.listJobTasks("run", "").toString().contains("use a new bounded run"));
        assertTrue(f.broker.listJobTasks("run", "").toString().contains("recheck-1"));
        verify(f.downloader, times(1)).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
    }

    /** Healthy complete titles do not consume slots; partially downloaded titles use one append slot. */
    @Test void cappedSelectionSkipsHealthyCurrentAndRetainsAppendPlan() {
        Fixture f = cappedFixture("Manhua", 4);
        var current = mock(com.scriptarr.raven.library.LibraryTitle.class);
        var partial = mock(com.scriptarr.raven.library.LibraryTitle.class);
        var chapter = mock(com.scriptarr.raven.library.LibraryChapter.class);
        when(chapter.chapterNumber()).thenReturn("1"); when(f.downloader.bulkChapterHealthy(chapter)).thenReturn(true);
        for (var title : List.of(current, partial)) {
            int index = title == current ? 0 : 1;
            when(title.id()).thenReturn("catalog-" + index); when(title.title()).thenReturn("Alpha 0" + index);
            when(title.sourceUrl()).thenReturn(candidateUrl(index)); when(title.libraryTypeSlug()).thenReturn("manhua");
            when(title.status()).thenReturn("Ongoing"); when(title.chapters()).thenReturn(title == current ? List.of(chapter) : List.of());
        }
        when(f.library.listTitles()).thenReturn(List.of(current, partial));
        var result = f.coordinator().queueBatchLimited("run", "batch", "weebcentral", "Manhua", false, "a", "owner", 2, () -> false, ignored -> { });
        assertEquals(List.of("Alpha 01", "Alpha 02"), result.queuedTitles());
        assertEquals(1, result.skippedCurrentCount()); assertEquals(1, result.appendedCount());
        var request = org.mockito.ArgumentCaptor.forClass(DownloadRequest.class);
        verify(f.downloader, times(2)).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), request.capture());
        assertEquals("catalog-1", request.getAllValues().getFirst().selectedDownload().get("appendTitleId"));
        assertEquals(List.of("1"), request.getAllValues().getFirst().selectedDownload().get("chapterNumbers"));
    }

    /** Strict cap parsing never truncates fractions, overflows, zero, or booleans into an uncapped run. */
    @Test void titleLimitParsingIsExactAndLegacyAbsenceRemainsUnlimited() {
        assertEquals(0, BulkTitleLimit.parse(null)); assertEquals(30, BulkTitleLimit.parse(30));
        for (Object value : List.of(0, -1, 1.5, true, "", "30x", "2147483648")) assertThrows(IllegalArgumentException.class, () -> BulkTitleLimit.parse(value));
    }

    /** @param index candidate identity @return valid canonical source URL */
    private static String candidateUrl(int index) { return "https://weebcentral.com/series/" + String.format(java.util.Locale.ROOT, "%026d", index); }

    /** @param type exact source type @param count candidate count @return deterministic reversed source fixture */
    private Fixture cappedFixture(String type, int count) {
        Fixture f = new Fixture(new FakeRavenBrokerClient());
        var rows = new java.util.ArrayList<Map<String, String>>();
        for (int index = count - 1; index >= 0; index--) rows.add(Map.of("title", String.format(java.util.Locale.ROOT, "Alpha %02d", index), "href", candidateUrl(index), "type", type));
        when(f.provider.browseTitlesAlphabetically(anyString(), anyBoolean(), anyString(), any(), any())).thenReturn(new BulkBrowseResult(rows, 2));
        when(f.provider.getTitleDetails(anyString())).thenReturn(new TitleDetails("", type, List.of(), "Ongoing", "", false, false, false, List.of(), List.of()));
        when(f.intake.resolveBulkMetadata(anyString(), anyString(), anyString(), anyString(), anyList())).thenAnswer(call ->
            new DownloadIntakeService.BulkMetadataResolution("matched", Map.of("title", call.getArgument(2), "provider", "mangadex", "providerSeriesId", call.getArgument(1)), Map.of()));
        return f;
    }
    /** A verified unavailable row retains evidence and is separately skipped without accepting a title task. */
    @Test void unavailableSourceIsAnExplicitRetainedPolicySkip() {
        Fixture f = new Fixture(new FakeRavenBrokerClient());
        when(f.provider.discoverChapters(anyString())).thenReturn(new ChapterDiscoveryResult(List.of(), true, ""));
        var checkpoint = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();
        var result = f.coordinator().queueBatch("run", "batch", "weebcentral", "Manhua", false, "a", "owner", () -> false, checkpoint::set);
        assertEquals(0, result.failedCount()); assertEquals(0, result.queuedCount());
        assertEquals(1, checkpoint.get().get("skippedUnavailableCount"));
        assertTrue(f.broker.listJobTasks("run", "").toString().contains("sourceUnavailableEvidence"));
        verify(f.downloader, never()).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
        assertEquals(0, f.queue().queuedCount());
    }
    /** An emptied completed placeholder cannot reuse a shortened, unrelated metadata match. */
    @Test void emptyCompletedPlaceholderRequiresOriginalSourceAnchor() {
        Fixture f = new Fixture(new FakeRavenBrokerClient()); var title = mock(com.scriptarr.raven.library.LibraryTitle.class);
        when(title.id()).thenReturn("canonical"); when(title.title()).thenReturn("Alpha"); when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669");
        when(title.status()).thenReturn("completed"); when(title.chapters()).thenReturn(List.of()); when(f.library.listTitles()).thenReturn(List.of(title));
        when(f.intake.resolveBulkMetadata(anyString(), anyString(), anyString(), anyString(), anyList())).thenReturn(new DownloadIntakeService.BulkMetadataResolution("matched", Map.of("title", "Unrelated", "matchedQuery", "Alpha"), Map.of()));
        assertEquals(1, f.queue().failedCount()); verify(f.downloader, never()).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
        assertTrue(f.broker.listJobTasks("run", "").toString().contains("metadata_source_ambiguous"));
    }

    /** Distinct provider editions that map to one retained canonical title cannot enqueue an overwrite. */
    @Test void existingCanonicalSourceRejectsDifferentEdition() {
        Fixture f = new Fixture(new FakeRavenBrokerClient()); var title = mock(com.scriptarr.raven.library.LibraryTitle.class);
        when(title.id()).thenReturn("canonical"); when(title.title()).thenReturn("Alpha"); when(title.libraryTypeSlug()).thenReturn("manhua");
        when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843"); when(f.library.listTitles()).thenReturn(List.of(title));
        assertEquals(1, f.queue().failedCount()); verify(f.downloader, never()).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), any());
        assertTrue(f.broker.listJobTasks("run", "").toString().contains("source_identity_conflict"));
    }

    /** An append with no metadata snapshot must keep source art already found during browse. */
    @Test
    void appendRetainsBrowsedCoverInItsFrozenRequest() {
        Fixture f = new Fixture(new FakeRavenBrokerClient());
        var title = mock(com.scriptarr.raven.library.LibraryTitle.class);
        when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669");
        when(title.id()).thenReturn("canonical-alpha");
        when(title.status()).thenReturn("completed");
        when(title.chapters()).thenReturn(List.of());
        when(f.library.listTitles()).thenReturn(List.of(title));
        when(f.provider.browseTitlesAlphabetically(anyString(), anyBoolean(), anyString(), any(), any())).thenReturn(
            new BulkBrowseResult(List.of(Map.of("title", "Alpha", "href", "https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669", "type", "Manhua",
                "coverUrl", "https://images.example/browse.jpg")), 1));
        assertEquals(1, f.queue().appendedCount());
        var request = org.mockito.ArgumentCaptor.forClass(DownloadRequest.class);
        verify(f.downloader).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), request.capture());
        assertEquals("https://images.example/browse.jpg", request.getValue().selectedDownload().get("coverUrl"));
        assertEquals("Alpha", request.getValue().selectedMetadata().get("title"));
        verify(f.intake).resolveBulkMetadata(anyString(), anyString(), anyString(), anyString(), anyList());
    }

    /** Browse artwork is a final fallback and cannot override an earlier metadata cover selection. */
    @Test
    void browseCoverPreservesSelectedMetadataPrecedence() {
        for (Map<String, Object> metadata : List.<Map<String, Object>>of(
            Map.of("coverUrl", "https://images.example/metadata.jpg"),
            Map.of("details", Map.of("coverImageUrl", "https://images.example/metadata.jpg")))) {
            Fixture f = new Fixture(new FakeRavenBrokerClient());
            when(f.provider.browseTitlesAlphabetically(anyString(), anyBoolean(), anyString(), any(), any())).thenReturn(
                new BulkBrowseResult(List.of(Map.of("title", "Alpha", "href", "https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669", "type", "Manhua",
                    "coverUrl", "https://images.example/browse.jpg")), 1));
            when(f.intake.resolveBulkMetadata(anyString(), anyString(), anyString(), anyString(), anyList())).thenReturn(
                new DownloadIntakeService.BulkMetadataResolution("matched", metadata, Map.of()));
            assertEquals(1, f.queue().queuedCount());
            var request = org.mockito.ArgumentCaptor.forClass(DownloadRequest.class);
            verify(f.downloader).queueBulkOwned(anyString(), anyString(), anyString(), anyString(), request.capture());
            assertFalse(request.getValue().selectedDownload().containsKey("coverUrl"));
            assertEquals(metadata, request.getValue().selectedMetadata());
        }
    }

    /** Verify complete discovery and a prepared stable plan exist before queue acceptance. */
    @Test
    void persistsBeforeEnqueueAndReplaysWithoutRediscovery() throws Exception {
        Fixture f = new Fixture(new FakeRavenBrokerClient());
        when(f.downloader.queueBulkOwned(anyString(),eq("run"),eq("batch"),anyString(),any())).thenAnswer(call->{
            JsonNode plans=f.broker.listJobTasks("run","");
            assertTrue(plans.findValuesAsText("status").contains("prepared"));
            assertTrue(plans.toString().contains("expectedChapters"));
            return f.accept(call);
        });
        BulkQueueDownloadResult first=f.queue();
        BulkQueueDownloadResult replay=f.coordinator().queueBatch("run","batch","weebcentral","Manhua",false,"a","owner",()->false,state->{});
        assertEquals(1,first.queuedCount());
        assertEquals(first.queuedTaskIds(),replay.queuedTaskIds());
        verify(f.provider,times(1)).browseTitlesAlphabetically(eq("Manhua"),eq(false),eq("a"),any(),any());
        verify(f.downloader,times(1)).queueBulkOwned(anyString(),eq("run"),eq("batch"),anyString(),any());
    }

    /** Verify a failed prepared-plan write cannot enqueue a title or appear fully resolved. */
    @Test
    void failedPlanPersistenceNeverQueuesWork() {
        FakeRavenBrokerClient broker=new FakeRavenBrokerClient(){
            @Override public JsonNode putJobTask(String jobId,String taskId,Map<String,Object> payload){
                if("prepared".equals(payload.get("status")))throw new IllegalStateException("Simulated plan write failure.");
                return super.putJobTask(jobId,taskId,payload);
            }
        };
        Fixture f=new Fixture(broker);
        java.util.concurrent.atomic.AtomicReference<Map<String,Object>> last=new java.util.concurrent.atomic.AtomicReference<>();
        BulkQueueDownloadResult result=f.coordinator().queueBatch("run","batch","weebcentral","Manhua",false,"a","owner",()->false,last::set);
        assertEquals(0,result.queuedCount());
        assertEquals(1,result.failedCount());
        assertFalse(((List<?>)last.get().get("unresolvedPlanIds")).isEmpty());
        verify(f.downloader,never()).queueBulkOwned(anyString(),anyString(),anyString(),anyString(),any());
    }

    /** Verify cancelling between queue acceptance and checkpoint cancels the newly owned identity. */
    @Test
    void cancellationRaceCannotLeaveUntrackedOwnedWork() throws Exception {
        Fixture f=new Fixture(new FakeRavenBrokerClient());
        CountDownLatch accepting=new CountDownLatch(1),release=new CountDownLatch(1);
        when(f.downloader.queueBulkOwned(anyString(),anyString(),anyString(),anyString(),any())).thenAnswer(call->{
            accepting.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));return f.accept(call);
        });
        BulkQueueCoordinator coordinator=f.coordinator();
        var worker=Executors.newFixedThreadPool(2);
        try {
            var queued=worker.submit(()->coordinator.queueBatch("run","batch","weebcentral","Manhua",false,"a","owner",()->false,state->{}));
            assertTrue(accepting.await(5,TimeUnit.SECONDS));
            var cancellation=worker.submit(()->coordinator.cancelRun("run"));
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(!coordinator.isRunCancelled("run")&&System.nanoTime()<deadline)Thread.sleep(5);
            assertTrue(coordinator.isRunCancelled("run"));release.countDown();
            assertThrows(java.util.concurrent.ExecutionException.class,()->queued.get(5,TimeUnit.SECONDS));
            cancellation.get(5,TimeUnit.SECONDS);
            verify(f.downloader,atLeastOnce()).cancelBulkOwned(startsWith("task_bulk_"),eq("run"));
        } finally {release.countDown();worker.shutdownNow();}
    }

    /** Verify durable owned outcomes beyond the UI terminal-history limit remain visible. */
    @Test
    void ownershipLookupIsNotCappedAtTwoHundredTasks() {
        Fixture f=new Fixture(new FakeRavenBrokerClient());
        for(int i=0;i<225;i++)f.broker.putDownloadTask("owned-"+i,Map.of("taskId","owned-"+i,"status","completed","details",Map.of("bulkRunId","run","bulkBatchId","batch")));
        f.broker.putDownloadTask("shared",Map.of("taskId","shared","status","running","details",Map.of()));
        List<Map<String,Object>> tasks=f.coordinator().ownedTasks("run","batch");
        assertEquals(225,tasks.size());
        assertTrue(tasks.stream().noneMatch(t->"shared".equals(t.get("taskId"))));
    }

    /** Verify uncommitted local completion cannot replace authoritative durable running evidence. */
    @Test
    void localCompletionRequiresDurableTerminalEvidence() {
        Fixture f=new Fixture(new FakeRavenBrokerClient());
        Map<String,Object> owner=Map.of("bulkRunId","run","bulkBatchId","batch");
        f.broker.putDownloadTask("task",Map.of("taskId","task","status","running","percent",98,"details",owner));
        when(f.downloader.bulkTaskSnapshots()).thenReturn(List.of(Map.of("taskId","task","status","completed","percent",100,"details",owner,"persistenceError","Uncommitted completion.")));
        Map<String,Object> result=f.coordinator().ownedTasks("run","batch").getFirst();
        assertEquals("running",result.get("status"));
        assertEquals(98,((Number)result.get("percent")).intValue());
        assertEquals("Uncommitted completion.",result.get("persistenceError"));
    }

    /** Verify explicit replay repairs only the missing stable owned identity from its prepared request. */
    @Test
    void missingOwnedRowReplaysSavedRequestWithoutRediscovery() {
        Fixture f=new Fixture(new FakeRavenBrokerClient());
        BulkQueueDownloadResult first=f.queue();
        f.broker.deleteDownloadTask(first.queuedTaskIds().getFirst());
        BulkQueueDownloadResult repaired=f.queue();
        assertEquals(first.queuedTaskIds(),repaired.queuedTaskIds());
        verify(f.provider,times(1)).browseTitlesAlphabetically(eq("Manhua"),eq(false),eq("a"),any(),any());
        verify(f.provider,times(1)).getTitleDetails(anyString());
        verify(f.downloader,times(2)).queueBulkOwned(eq(first.queuedTaskIds().getFirst()),anyString(),anyString(),anyString(),any());
    }

    /** Verify a pending restoration barrier prevents all discovery and queue acceptance. */
    @Test
    void pendingRestorationCannotBeMistakenForAnEmptyQueue() {
        Fixture f=new Fixture(new FakeRavenBrokerClient());
        CompletableFuture<Void> restore=new CompletableFuture<>();
        when(f.downloader.restorationCompletion()).thenReturn(restore);
        BulkQueueCoordinator coordinator=f.coordinator();
        assertSame(restore,coordinator.restoreCompletion());
        assertThrows(IllegalStateException.class,()->coordinator.queueBatch("run","batch","weebcentral","Manhua",false,"a","owner",()->false,state->{}));
        verify(f.provider,never()).browseTitlesAlphabetically(anyString(),anyBoolean(),anyString(),any(),any());
    }

    /** Test dependencies with a deterministic safe WeebCentral source. */
    private static final class Fixture {
        private final FakeRavenBrokerClient broker;
        private final DownloaderService downloader=mock(DownloaderService.class);
        private final DownloadProvider provider=mock(DownloadProvider.class);
        private final LibraryService library=mock(LibraryService.class);
        private final DownloadIntakeService intake=mock(DownloadIntakeService.class);
        private final RavenSettingsService settings;
        private final DownloadProviderRegistry registry;

        private Fixture(FakeRavenBrokerClient broker) {
            this.broker=broker;
            broker.setSetting("raven.download.providers",Map.of("providers",List.of(Map.of("id","weebcentral","enabled",true,"priority",1))));
            settings=new RavenSettingsService(broker,mock(ScriptarrLogger.class),List.of());
            when(provider.id()).thenReturn("weebcentral");when(provider.name()).thenReturn("WeebCentral");
            registry=new DownloadProviderRegistry(List.of(provider),settings);
            when(downloader.restorationCompletion()).thenReturn(CompletableFuture.completedFuture(null));
            when(downloader.bulkTaskSnapshots()).thenReturn(List.of());
            when(library.listTitles()).thenReturn(List.of());
            when(provider.browseTitlesAlphabetically(anyString(),anyBoolean(),anyString(),any(),any())).thenReturn(new BulkBrowseResult(List.of(Map.of("title","Alpha","href","https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669","type","Manhua")),1));
            when(provider.getTitleDetails(anyString())).thenReturn(new TitleDetails("","Manhua",List.of(),"Ongoing","",false,false,false,List.of(),List.of()));
            org.mockito.Mockito.doCallRealMethod().when(provider).getTitleDetails(anyString(), any());
            org.mockito.Mockito.doCallRealMethod().when(provider).discoverChapters(anyString(), any());
            when(provider.getChapters(anyString())).thenReturn(List.of(Map.of("chapter_number","1","href","https://weebcentral.com/chapters/one")));
            when(intake.resolveBulkMetadata(anyString(),anyString(),anyString(),anyString(),anyList())).thenReturn(new DownloadIntakeService.BulkMetadataResolution("matched",Map.of("provider","mangadex","providerSeriesId","alpha","title","Alpha"),Map.of()));
            when(downloader.queueBulkOwned(anyString(),anyString(),anyString(),anyString(),any())).thenAnswer(this::accept);
        }

        private BulkQueueCoordinator coordinator(){return new BulkQueueCoordinator(downloader,registry,library,intake,broker,settings);}
        private BulkQueueDownloadResult queue(){return coordinator().queueBatch("run","batch","weebcentral","Manhua",false,"a","owner",()->false,state->{});}
        private Map<String,Object> accept(org.mockito.invocation.InvocationOnMock call){
            String id=call.getArgument(0);
            broker.putDownloadTask(id,Map.of("taskId",id,"status","queued","details",Map.of("bulkRunId",call.getArgument(1),"bulkBatchId",call.getArgument(2),"bulkPlanId",call.getArgument(3))));
            return Map.of("taskId",id);
        }
    }
}
