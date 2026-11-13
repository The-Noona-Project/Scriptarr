package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.ArchiveDownloadEvidence;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real image HTTP requests prove expired repair page lists refresh without discarding partial evidence. */
class ChapterRepairPageRefreshTest {
    /** A refreshed source list replaces expired URLs while the failed private CBZ stays retained. */
    @Test void expiredUrlsRefreshToCompleteCandidate(@TempDir Path root) throws Exception {
        var image = new java.io.ByteArrayOutputStream(); javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(8,8,java.awt.image.BufferedImage.TYPE_INT_RGB), "png", image);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/", exchange -> {boolean expired = exchange.getRequestURI().getPath().contains("expired"); byte[] bytes = expired ? new byte[0] : image.toByteArray();
            exchange.sendResponseHeaders(expired ? 404 : 200, expired ? -1 : bytes.length); if (!expired) exchange.getResponseBody().write(bytes); exchange.close();}); server.start();
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient(); ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        RavenSettingsService settings = new RavenSettingsService(broker,logger,List.of());
        DownloaderService service = new DownloaderService(new DownloadProviderRegistry(List.of(),settings),null,mock(LibraryService.class),mock(DownloadIntakeService.class),mock(MetadataService.class),broker,settings,logger);
        try {
            String base = "http://127.0.0.1:"+server.getAddress().getPort(), source = "https://weebcentral.com/chapters/ABC";
            DownloadProvider provider = mock(DownloadProvider.class);
            when(provider.resolvePages(source)).thenReturn(List.of(base+"/001.png",base+"/expired.png"),List.of(base+"/001.png",base+"/fresh.png"));
            DownloadRequest request = new DownloadRequest("QA","https://weebcentral.com/series/ABC/QA","Manhua","owner","weebcentral","",Map.of(),Map.of(),"","normal");
            DownloaderService.ChapterDownloadResult result = ReflectionTestUtils.invokeMethod(service,"downloadRepairCandidate",provider,request,
                Map.of("chapter_number","1","chapter_title","Chapter 1","href",source,"expectedPageCount",2),root.resolve("private"));
            assertNotNull(result); assertEquals("clean",result.qualityStatus()); assertEquals(0,result.missingPageCount()); verify(provider,times(2)).resolvePages(source);
            try (var paths = Files.walk(root.resolve("private"))) {
                var archives = paths.filter(p -> p.toString().endsWith(".cbz")).toList(); assertEquals(2,archives.size());
                Path retained = archives.stream().filter(p -> !p.equals(result.archivePath())).findFirst().orElseThrow();
                assertEquals(List.of(2),ArchiveDownloadEvidence.read(retained,source,2).missing());
            }
        } finally {service.shutdown();server.stop(0);}
    }
}
