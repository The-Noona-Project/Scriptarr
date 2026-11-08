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
            when(provider.browseTitlesAlphabetically(anyString(),anyBoolean(),anyString(),any(),any())).thenReturn(new BulkBrowseResult(List.of(Map.of("title","Alpha","href","https://weebcentral.com/series/alpha","type","Manhua")),1));
            when(provider.getTitleDetails(anyString())).thenReturn(new TitleDetails("","Manhua",List.of(),"Ongoing","",false,false,false,List.of(),List.of()));
            when(provider.getChapters(anyString())).thenReturn(List.of(Map.of("chapter_number","1","href","https://weebcentral.com/chapters/one")));
            when(intake.resolveBulkMetadata(anyString(),anyString(),anyString(),anyString())).thenReturn(new DownloadIntakeService.BulkMetadataResolution("matched",Map.of("provider","mangadex","providerSeriesId","alpha"),Map.of()));
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
