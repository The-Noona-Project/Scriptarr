package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Verify the real queue cannot start unpersisted owned work or release restoration prematurely. */
class DownloaderOwnedPersistenceTest {
    /** An original's exact owner wins over its separately owned reboot's shared English alias. */
    @Test void originalPassesDespiteRebootAlias(@TempDir Path root) throws Exception {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        DownloadProvider provider = mock(DownloadProvider.class);
        when(provider.supportsUrl(anyString())).thenReturn(true);
        CountDownLatch reached = new CountDownLatch(1);
        when(provider.getChapters(anyString())).thenAnswer(call -> {reached.countDown(); return List.of();});
        String original = "https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669/The-Kings-Avatar";
        String reboot = "https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843/The-Kings-Avatar-Reboot";
        String name = "The King's Avatar";
        broker.putLibraryTitle("original", Map.of("id", "original", "title", name, "sourceUrl", original, "libraryTypeSlug", "manhua", "chapters", List.of()));
        broker.putLibraryTitle("reboot", Map.of("id", "reboot", "title", name + " (Reboot)", "aliases", List.of(name),
            "sourceUrl", reboot, "libraryTypeSlug", "manhua", "chapters", List.of()));
        TitleDetails source = new TitleDetails("Glory returns.", "Manhua", List.of("Quan Zhi Gao Shou"), "Canceled", "2015",
            false, false, false, List.of(), List.of(), name, List.of(), "");
        Map<String, Object> metadata = com.scriptarr.raven.metadata.SourceMetadataFacts.bind("weebcentral", original, name, source,
            Map.of("provider", "mangadex", "providerSeriesId", "original", "title", name, "releaseLabel", "2015", "type", "Manhua"), "verified-provider");
        DownloaderService downloader = service(broker, provider, root);
        try {
            downloader.queueBulkOwned("bound-original", "run", "batch", "plan", new DownloadRequest(name, original, "Manhua", "owner", "weebcentral", "", metadata, Map.of("appendTitleId", "original"), "", "normal"));
            assertTrue(reached.await(5, TimeUnit.SECONDS));
        } finally {downloader.shutdown();}
    }
    /** A verified year-backed reboot reaches real execution instead of exhausting retries at the legacy anchor. */
    @Test void boundRebootPassesExecutionFence(@TempDir Path root) throws Exception {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        DownloadProvider provider = mock(DownloadProvider.class);
        when(provider.supportsUrl(anyString())).thenReturn(true);
        CountDownLatch reached = new CountDownLatch(1);
        when(provider.getChapters(anyString())).thenAnswer(call -> {reached.countDown(); return List.of();});
        String url = "https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843/The-Kings-Avatar-Reboot";
        String name = "The King's Avatar (Reboot)";
        TitleDetails source = new TitleDetails("Glory returns.", "Manhua", List.of("The King's Avatar (2020)"), "Ongoing", "2020",
            false, false, false, List.of(), List.of(), name, List.of(), "");
        Map<String, Object> metadata = com.scriptarr.raven.metadata.SourceMetadataFacts.bind("weebcentral", url, name, source,
            Map.of("provider", "mangadex", "providerSeriesId", "reboot", "title", "The King's Avatar", "releaseLabel", "2020", "type", "Manhua"), "verified-provider");
        assertFalse(BulkMetadataAnchor.matches(name, source.associatedNames(), metadata));
        broker.putLibraryTitle("original", Map.of("id", "original", "title", "The King's Avatar", "aliases", List.of("The King's Avatar"),
            "sourceUrl", "https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669/The-Kings-Avatar", "libraryTypeSlug", "manhua", "chapters", List.of()));
        broker.putLibraryTitle("reboot", Map.of("id", "reboot", "title", name, "aliases", List.of("The King's Avatar"),
            "sourceUrl", url, "libraryTypeSlug", "manhua", "chapters", List.of()));
        DownloaderService downloader = service(broker, provider, root);
        try {
            downloader.queueBulkOwned("bound-reboot", "run", "batch", "plan", new DownloadRequest(name, url, "Manhua", "owner", "weebcentral", "", metadata, Map.of(), "", "normal"));
            assertTrue(reached.await(5, TimeUnit.SECONDS));
        } finally {downloader.shutdown();}
    }
    /** Verify restart cannot complete an unfinished append merely because its older catalog title exists. */
    @Test
    void unfinishedAppendWhoseSourceChapterDisappearedDoesNotRecoverAsComplete(@TempDir Path root) throws Exception {
        FakeRavenBrokerClient broker=new FakeRavenBrokerClient();
        LibraryService library=mock(LibraryService.class);
        LibraryTitle old=mock(LibraryTitle.class);
        when(old.id()).thenReturn("existing");
        when(old.chapters()).thenReturn(List.of(new LibraryChapter("one","Chapter1","1",1,"",true,root.resolve("old.cbz").toString(),"https://weebcentral.com/chapters/one",null)));
        when(library.findTitle("existing")).thenReturn(old);
        when(library.listTitles()).thenReturn(List.of(old));
        DownloadProvider provider=mock(DownloadProvider.class);
        when(provider.supportsUrl(anyString())).thenReturn(true);
        when(provider.getChapters(anyString())).thenReturn(List.of(Map.of("chapter_number","1","href","https://weebcentral.com/chapters/one")));
        Map<String,Object> selected=Map.of("downloadMode","append","appendTitleId","existing","chapterNumbers",List.of("2"),"expectedChapters",List.of(Map.of("chapter_number","2","href","https://weebcentral.com/chapters/two")));
        broker.putDownloadTask("append",Map.ofEntries(Map.entry("taskId","append"),Map.entry("jobId","append"),Map.entry("titleId","existing"),Map.entry("titleName","Alpha"),Map.entry("titleUrl","https://weebcentral.com/series/8ED3F6AD685B959EAD7022518E"),Map.entry("requestType","Manhua"),Map.entry("providerId","weebcentral"),Map.entry("status","running"),Map.entry("percent",98),Map.entry("details",Map.of("bulkRunId","run","bulkBatchId","batch","bulkPlanId","plan","selectedDownload",selected))));
        DownloaderService service=service(broker,provider,root,library);
        try {
            service.restorePersistedTasks();
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            Map<String,Object> task=Map.of();
            while(System.nanoTime()<deadline){task=service.snapshot().stream().filter(t->"append".equals(t.get("taskId"))).findFirst().orElse(Map.of());if("failed".equals(task.get("status")))break;Thread.sleep(10);}
            assertEquals("failed",task.get("status"));
            assertTrue(((Number)task.get("percent")).intValue()<100);
            assertTrue(String.valueOf(task.get("message")).contains("disappeared"));
            verify(provider,never()).resolvePages(anyString());
            verify(library,never()).ingestTitle(anyString(),anyString(),any(),any());
        } finally {service.shutdown();}
    }
    /** Verify failed authoritative persistence leaves no in-memory or executable title task. */
    @Test
    void failedOwnedPersistenceCannotEnqueue(@TempDir Path root) {
        FakeRavenBrokerClient broker=new FakeRavenBrokerClient(){
            @Override public JsonNode putDownloadTask(String id,Map<String,Object> task){throw new IllegalStateException("Broker unavailable.");}
        };
        DownloadProvider provider=mock(DownloadProvider.class);
        DownloaderService service=service(broker,provider,root);
        try {
            DownloadRequest request=new DownloadRequest("Alpha","https://weebcentral.com/series/8ED3F6AD685B959EAD7022518E","Manhua","owner","weebcentral","",Map.of(),Map.of(),"","normal");
            assertThrows(IllegalStateException.class,()->service.queueBulkOwned("stable","run","batch","plan",request));
            assertTrue(service.snapshot().isEmpty());
            assertTrue(broker.listDownloadTasks().isEmpty());
            verify(provider,after(200).never()).getChapters(anyString());
        } finally {service.shutdown();}
    }

    /** Verify broker failure leaves a stable pending barrier until a complete later restoration succeeds. */
    @Test
    void restorationBarrierWaitsForSuccessfulBrokerRecovery(@TempDir Path root) throws Exception {
        AtomicInteger reads=new AtomicInteger();
        CountDownLatch failed=new CountDownLatch(1);
        FakeRavenBrokerClient broker=new FakeRavenBrokerClient(){
            @Override public JsonNode listDownloadTasks(){
                if(reads.incrementAndGet()==1){failed.countDown();throw new IllegalStateException("Transient broker failure.");}
                return super.listDownloadTasks();
            }
        };
        DownloaderService service=service(broker,mock(DownloadProvider.class),root);
        try {
            CompletableFuture<Void> barrier=service.bulkRunGateway().restoreCompletion();
            CompletableFuture<Void> attempt=CompletableFuture.runAsync(service::restorePersistedTasks);
            assertTrue(failed.await(5,TimeUnit.SECONDS));
            assertSame(barrier,service.bulkRunGateway().restoreCompletion());
            assertFalse(barrier.isDone());
            service.restorePersistedTasks();
            assertFalse(barrier.isDone());
            attempt.get(12,TimeUnit.SECONDS);
            assertTrue(barrier.isDone());
            assertFalse(barrier.isCompletedExceptionally());
            assertEquals(2,reads.get());
        } finally {service.shutdown();}
    }

    private DownloaderService service(FakeRavenBrokerClient broker,DownloadProvider provider,Path root) {
        return service(broker,provider,root,mock(LibraryService.class));
    }

    private DownloaderService service(FakeRavenBrokerClient broker,DownloadProvider provider,Path root,LibraryService library) {
        ScriptarrLogger logger=mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(root);
        when(provider.id()).thenReturn("weebcentral");when(provider.name()).thenReturn("WeebCentral");
        broker.setSetting("raven.download.providers",Map.of("providers",List.of(Map.of("id","weebcentral","enabled",true,"priority",1))));
        RavenSettingsService settings=new RavenSettingsService(broker,logger,List.of());
        return new DownloaderService(new DownloadProviderRegistry(List.of(provider),settings),null,library,mock(DownloadIntakeService.class),mock(MetadataService.class),broker,settings,logger);
    }
}
