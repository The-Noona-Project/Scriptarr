package com.scriptarr.raven;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

    @Test
    void healthIncludesProviderDefaultsAndVpnStatus() {
        Map<?, ?> payload = restTemplate.getForObject("http://127.0.0.1:" + port + "/health", Map.class);
        assertEquals("scriptarr-raven", payload.get("service"));

        List<Map<String, Object>> providers = (List<Map<String, Object>>) payload.get("metadataProviders");
        assertEquals(3, providers.size());
        assertTrue(providers.stream().anyMatch(entry -> "mangadex".equals(entry.get("id")) && Boolean.TRUE.equals(entry.get("enabled"))));

        Map<?, ?> vpn = (Map<?, ?>) payload.get("vpn");
        assertEquals(false, vpn.get("enabled"));
    }
}
