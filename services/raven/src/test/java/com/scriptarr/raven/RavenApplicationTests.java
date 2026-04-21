package com.scriptarr.raven;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Smoke tests for the Raven application scaffold.
 */
@SpringBootTest(
    classes = RavenApplication.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        "SCRIPTARR_RAVEN_DATA_ROOT=build/test-downloads",
        "SCRIPTARR_RAVEN_LOG_DIR=build/test-logs"
    }
)
class RavenApplicationTests {
    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate restTemplate;

    /**
     * Verify the health payload surfaces Raven defaults used by Moon admin.
     */
    @Test
    void healthIncludesProviderDefaultsAndVpnStatus() {
        Map<?, ?> payload = restTemplate.getForObject("http://127.0.0.1:" + port + "/health", Map.class);
        assertEquals("scriptarr-raven", payload.get("service"));

        List<Map<String, Object>> providers = (List<Map<String, Object>>) payload.get("metadataProviders");
        assertEquals(6, providers.size());
        assertTrue(providers.stream().anyMatch(entry -> "mangadex".equals(entry.get("id")) && Boolean.TRUE.equals(entry.get("enabled"))));
        assertTrue(providers.stream().anyMatch(entry -> "animeplanet".equals(entry.get("id")) && Boolean.TRUE.equals(entry.get("enabled"))));
        assertTrue(providers.stream().anyMatch(entry -> "mangaupdates".equals(entry.get("id"))));
        assertTrue(providers.stream().anyMatch(entry -> "mal".equals(entry.get("id")) && Boolean.FALSE.equals(entry.get("enabled"))));
        List<Map<String, Object>> downloadProviders = (List<Map<String, Object>>) payload.get("downloadProviders");
        assertEquals(2, downloadProviders.size());
        assertTrue(downloadProviders.stream().anyMatch(entry -> "weebcentral".equals(entry.get("id")) && Boolean.TRUE.equals(entry.get("enabled"))));
        assertTrue(downloadProviders.stream().anyMatch(entry -> "mangadex".equals(entry.get("id")) && Boolean.TRUE.equals(entry.get("enabled"))));

        Map<?, ?> vpn = (Map<?, ?>) payload.get("vpn");
        assertEquals(false, vpn.get("enabled"));
    }

    /**
     * Verify Raven starts with an empty library and reader routes stay honest
     * about missing titles.
     */
    @Test
    void libraryStartsEmptyAndReaderRoutesReturnNotFound() {
        Map<?, ?> payload = restTemplate.getForObject("http://127.0.0.1:" + port + "/v1/library", Map.class);
        List<?> titles = (List<?>) payload.get("titles");
        assertTrue(titles.isEmpty());

        ResponseEntity<String> titleResponse = restTemplate.getForEntity(
            "http://127.0.0.1:" + port + "/v1/library/missing-title",
            String.class
        );
        assertEquals(HttpStatus.NOT_FOUND, titleResponse.getStatusCode());

        ResponseEntity<String> manifestResponse = restTemplate.getForEntity(
            "http://127.0.0.1:" + port + "/v1/reader/missing-title",
            String.class
        );
        assertEquals(HttpStatus.NOT_FOUND, manifestResponse.getStatusCode());

        ResponseEntity<String> chapterResponse = restTemplate.getForEntity(
            "http://127.0.0.1:" + port + "/v1/reader/missing-title/chapter-1",
            String.class
        );
        assertEquals(HttpStatus.NOT_FOUND, chapterResponse.getStatusCode());

        ResponseEntity<String> pageResponse = restTemplate.getForEntity(
            "http://127.0.0.1:" + port + "/v1/reader/missing-title/chapter-1/page/0",
            String.class
        );
        assertEquals(HttpStatus.NOT_FOUND, pageResponse.getStatusCode());
    }
}
