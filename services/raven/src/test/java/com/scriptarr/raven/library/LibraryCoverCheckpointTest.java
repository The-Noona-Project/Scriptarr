package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenSageClient;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Verify compact exact-id artwork preservation and failed lookup write suppression. */
class LibraryCoverCheckpointTest {
    private static final String COVER = "https://images.example/retained.jpg";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** A successful empty lookup permits genuine new titles without inventing cover art. */
    @Test
    void newCoverlessTitleUsesSuccessfulEmptyLookup() {
        Broker broker = new Broker();
        LibraryTitle title = title("title", "");
        assertEquals("", service(broker).upsertTitle(title).coverUrl());
        assertEquals(1, broker.writes);
        assertEquals(List.of(Map.of("ids", "title", "pageSize", "1")), broker.queries);
        assertFalse(broker.lastPayload.containsKey("chapters"));
    }

    /** Invalid exact-id inputs must never degrade into an unscoped or multi-title lookup. */
    @Test
    void invalidLookupIdentityNeverReadsOrWritesBrokerState() {
        for (String id : new String[]{null, "", " \t ", "one,two"}) {
            Broker broker = new Broker();
            assertThrows(IllegalStateException.class, () -> service(broker).upsertTitle(title(id, "")));
            assertTrue(broker.queries.isEmpty());
            assertEquals(0, broker.writes);
        }
        Broker legacy = new Broker();
        assertEquals("legacy:Title.12", service(legacy).upsertTitle(title("legacy:Title.12", "")).id());
        assertEquals(List.of(Map.of("ids", "legacy:Title.12", "pageSize", "1")), legacy.queries);
    }

    /** A real HTTP 200 empty card page must permit initial title creation through the broker transport. */
    @Test
    void realHttpEmptyPageAllowsNewTitlePut() throws Exception {
        AtomicInteger gets = new AtomicInteger(), puts = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/internal/vault/raven/", exchange -> {
            byte[] body;
            if ("GET".equals(exchange.getRequestMethod()) && exchange.getRequestURI().getPath().endsWith("/title-cards")) {
                gets.incrementAndGet();
                body = page(List.of(), List.of("title"), false, 0).toString().getBytes(StandardCharsets.UTF_8);
            } else if ("PUT".equals(exchange.getRequestMethod()) && exchange.getRequestURI().getPath().endsWith("/titles/title")) {
                puts.incrementAndGet(); body = exchange.getRequestBody().readAllBytes();
            } else {
                exchange.sendResponseHeaders(404, -1); exchange.close(); return;
            }
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length); exchange.getResponseBody().write(body); exchange.close();
        });
        server.start();
        try {
            RavenSageClient transport = new RavenSageClient();
            ReflectionTestUtils.setField(transport, "sageBaseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            ScriptarrLogger logger = mock(ScriptarrLogger.class);
            LibraryService service = new LibraryService(transport, new RavenSettingsService(transport, logger, List.of()), logger);
            assertEquals("", service.upsertTitle(title("title", "")).coverUrl());
            assertEquals(1, gets.get()); assertEquals(1, puts.get());
        } finally {server.stop(0);}
    }

    /** An older blank checkpoint retains only current art and leaves chapter checkpoint APIs untouched. */
    @Test
    void staleBlankCheckpointRetainsStoredArtwork() {
        Broker broker = new Broker();
        LibraryTitle original = title("title", COVER);
        broker.setLibraryTitle(original);
        LibraryTitle saved = service(broker).upsertTitle(original.withCoverUrl(""));
        assertEquals(original, saved);
        assertEquals(1, broker.writes);
        assertEquals(0, broker.replaceChapterListWrites());
        assertEquals(0, broker.singleChapterWrites());
        assertEquals(List.of(Map.of("ids", "title", "pageSize", "1")), broker.queries);
    }

    /** Nonblank incoming artwork remains an explicit update without an additional lookup. */
    @Test
    void explicitNonblankUpdateDoesNotConsultPreservationLookup() {
        Broker broker = new Broker();
        LibraryTitle original = title("title", COVER);
        broker.setLibraryTitle(original);
        broker.lookupFailure = new IllegalStateException("Broker unavailable.");
        assertEquals("https://images.example/new.jpg", service(broker).upsertTitle(original.withCoverUrl("https://images.example/new.jpg")).coverUrl());
        assertTrue(broker.queries.isEmpty());
        assertEquals(1, broker.writes);
    }

    /** An existing title that genuinely has no artwork can still checkpoint normally. */
    @Test
    void existingCoverlessTitleStillAllowsBlankCheckpoint() {
        Broker broker = new Broker();
        LibraryTitle original = title("title", "");
        broker.setLibraryTitle(original);
        assertEquals(original, service(broker).upsertTitle(original));
        assertEquals(1, broker.writes);
    }

    /** Failed transport cannot masquerade as an absent title and erase its existing cover. */
    @Test
    void failedLookupDoesNotWriteAnyTitleState() {
        Broker broker = new Broker();
        LibraryTitle original = title("title", COVER);
        broker.setLibraryTitle(original);
        broker.lookupFailure = new IllegalStateException("Simulated failed compact lookup.");
        assertThrows(IllegalStateException.class, () -> service(broker).upsertTitle(original.withCoverUrl("")));
        assertEquals(0, broker.writes);
        assertEquals(COVER, broker.getLibraryTitle("title").path("coverUrl").asText());
    }

    /** A checked transport failure propagates without any attempted summary mutation. */
    @Test
    void checkedIoFailureNeverReachesTitlePut() throws Exception {
        RavenBrokerClient transport = mock(RavenBrokerClient.class);
        when(transport.listLibraryTitleCards(anyMap())).thenThrow(new IOException("Connection unavailable."));
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        LibraryService service = new LibraryService(transport, new RavenSettingsService(transport, logger, List.of()), logger);
        assertThrows(IllegalStateException.class, () -> service.upsertTitle(title("title", "")));
        verify(transport, never()).putLibraryTitle(anyString(), anyMap());
    }

    /** Missing, truncated, malformed and incorrectly scoped lookup data must suppress the PUT. */
    @Test
    void malformedLookupDoesNotWriteAnyTitleState() {
        List<JsonNode> invalid = new ArrayList<>();
        invalid.add(JSON.nullNode());
        invalid.add(JSON.valueToTree(Map.of("error", "Unavailable")));
        invalid.add(JSON.valueToTree(Map.of("titles", List.of())));
        invalid.add(page(List.of(), List.of("title"), true, 0));
        invalid.add(page(List.of(), List.of("title"), false, 1));
        invalid.add(page(List.of(), List.of("title", "foreign"), false, 0));
        invalid.add(page(List.of(Map.of("id", "foreign", "coverUrl", COVER)), List.of("title"), false, 1));
        invalid.add(page(List.of(Map.of("id", "title")), List.of("title"), false, 1));
        invalid.add(page(List.of(Map.of("id", "title", "coverUrl", List.of(COVER))), List.of("title"), false, 1));
        invalid.add(page(List.of(Map.of("id", "title", "coverUrl", COVER), Map.of("id", "foreign", "coverUrl", "")), List.of("title"), false, 2));
        for (JsonNode response : invalid) {
            Broker broker = new Broker();
            LibraryTitle original = title("title", COVER);
            broker.setLibraryTitle(original);
            broker.response = response;
            assertThrows(IllegalStateException.class, () -> service(broker).upsertTitle(original.withCoverUrl("")), response.toString());
            assertEquals(0, broker.writes, response.toString());
            assertEquals(COVER, broker.getLibraryTitle("title").path("coverUrl").asText());
        }
    }

    /** Vault's exact-id endpoint echoes canonical ids after resolving aliases, rather than the input alias. */
    @Test
    void aliasResolvedCardRetainsArtWithoutChangingRequestedUpsertIdentity() {
        Broker broker = new Broker();
        broker.response = page(List.of(Map.of("id", "canonical", "coverUrl", COVER)), List.of("canonical"), false, 1);
        LibraryTitle saved = service(broker).upsertTitle(title("old-alias", ""));
        assertEquals(COVER, saved.coverUrl());
        assertEquals("old-alias", broker.lastTitleId, "The broker continues to own alias canonicalization on write.");
        assertEquals(List.of(Map.of("ids", "old-alias", "pageSize", "1")), broker.queries);
        assertEquals(1, broker.writes);
    }

    /** Match the response ownership metadata emitted by both supported Vault storage drivers. */
    private JsonNode page(List<Map<String, Object>> cards, List<String> resolvedIds, boolean hasMore, int total) {
        return JSON.valueToTree(Map.of("titles", cards, "filters", Map.of("ids", resolvedIds), "pageInfo", Map.of("hasMore", hasMore, "total", total)));
    }

    /** Build the real title-summary service without network or file side effects. */
    private LibraryService service(Broker broker) {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        return new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger);
    }

    /** Construct a stable title with ready chapter metadata to detect accidental chapter writes. */
    private LibraryTitle title(String id, String cover) {
        LibraryChapter chapter = new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true, "/downloads/downloaded/manhua/Title/chapter.cbz", "",
            "clean", 1, 0, List.of(), List.of(), "ready", "avif-1234567890abcdef", 1, "2026-11-08T00:00:00Z", "",
            "/downloads/ingested/manhua/" + id + "/chapter/manifest.json", "2026-11-08T00:00:00Z");
        return new LibraryTitle(id, "Title", "manga", "Manhua", "manhua", "active", "1", "#123456", "", "", 1, 1,
            "", List.of(), List.of(), "", "", List.of(), "", cover, "", "/downloads/downloaded/manhua/Title", List.of(chapter), "2026-11-08T00:00:00Z");
    }

    /** Record exact lookup scope and reject accidental writes after controlled lookup failures. */
    private static final class Broker extends FakeRavenBrokerClient {
        private final List<Map<String, String>> queries = new ArrayList<>();
        private RuntimeException lookupFailure;
        private JsonNode response;
        private int writes;
        private String lastTitleId;
        private Map<String, Object> lastPayload;

        @Override
        public JsonNode listLibraryTitleCards(Map<String, String> query) {
            queries.add(Map.copyOf(query));
            if (lookupFailure != null) throw lookupFailure;
            return response == null ? super.listLibraryTitleCards(query) : response;
        }

        @Override
        public JsonNode putLibraryTitle(String titleId, Map<String, Object> payload) {
            writes += 1; lastTitleId = titleId; lastPayload = Map.copyOf(payload);
            return super.putLibraryTitle(titleId, payload);
        }
    }
}
