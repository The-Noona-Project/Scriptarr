package com.scriptarr.raven.downloader;

import com.scriptarr.raven.api.RavenController;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** HTTP contract coverage for additive approval bodies and conflict responses. */
class BulkRunControllerTest {
    /** Captured approval and request identities reach the durable decision method unchanged. */
    @Test
    void continueForwardsTheCapturedDecisionBody() throws Exception {
        BulkRunService service = mock(BulkRunService.class);
        when(service.resumeRun("run", "approval_old", "discord:decision:123"))
            .thenReturn(Map.of("runId", "run", "status", "running", "approvalId", "approval_new"));
        mvc(service).perform(post("/v1/downloads/bulk-runs/run/continue").contentType(MediaType.APPLICATION_JSON)
                .content("{\"approvalId\":\"approval_old\",\"requestId\":\"discord:decision:123\"}"))
            .andExpect(status().isAccepted()).andExpect(jsonPath("$.approvalId").value("approval_new"));
        verify(service).resumeRun("run", "approval_old", "discord:decision:123");
    }

    /** An absent body remains valid for explicitly invoked legacy internal callers. */
    @Test
    void legacyResumeWithoutBodyRetainsCompatibility() throws Exception {
        BulkRunService service = mock(BulkRunService.class);
        when(service.resumeRun("run", "", "")).thenReturn(Map.of("status", "running", "batches", List.of()));
        mvc(service).perform(post("/v1/downloads/bulk-runs/run/resume"))
            .andExpect(status().isAccepted()).andExpect(jsonPath("$.batches").isArray());
        verify(service).resumeRun("run", "", "");
    }

    /** Stale and opposite decision conflicts are HTTP 409 rather than a misleading 404. */
    @Test
    void decisionConflictsReturnConflictWithAnErrorBody() throws Exception {
        BulkRunService service = mock(BulkRunService.class);
        when(service.resumeRun("run", "old", "request")).thenThrow(new BulkRunConflictException("Approval is stale."));
        when(service.cancelRun("run", "old", "request")).thenThrow(new BulkRunConflictException("Opposite action already accepted."));
        MockMvc mvc = mvc(service);
        for (String action : List.of("resume", "continue", "cancel")) {
            mvc.perform(post("/v1/downloads/bulk-runs/run/" + action).contentType(MediaType.APPLICATION_JSON)
                    .content("{\"approvalId\":\"old\",\"requestId\":\"request\"}"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error").isString());
        }
    }

    /** Reusing a creation key with changed options is a conflict in the public controller. */
    @Test
    void creationFingerprintConflictReturnsConflict() throws Exception {
        BulkRunService service = mock(BulkRunService.class);
        when(service.createRun(anyMap())).thenThrow(new BulkRunConflictException("Creation options changed."));
        mvc(service).perform(post("/v1/downloads/bulk-runs").contentType(MediaType.APPLICATION_JSON)
                .content("{\"requestId\":\"discord:interaction:123\"}"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.error").value("Creation options changed."));
    }

    /** Durable broker outages remain retryable rather than looking like missing runs or key conflicts. */
    @Test
    void durableStorageFailuresReturnServiceUnavailable() throws Exception {
        BulkRunService service = mock(BulkRunService.class);
        when(service.createRun(anyMap())).thenThrow(new IllegalStateException("Raven could not persist the durable bulk run."));
        when(service.resumeRun("run", "", "")).thenThrow(new IllegalStateException("Raven could not load durable bulk runs."));
        when(service.cancelRun("run", "", "")).thenThrow(new IllegalStateException("Raven could not persist the durable bulk run."));
        MockMvc mvc = mvc(service);
        mvc.perform(post("/v1/downloads/bulk-runs").contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isServiceUnavailable());
        mvc.perform(post("/v1/downloads/bulk-runs/run/resume")).andExpect(status().isServiceUnavailable());
        mvc.perform(post("/v1/downloads/bulk-runs/run/cancel")).andExpect(status().isServiceUnavailable());
    }

    private MockMvc mvc(BulkRunService service) {
        return MockMvcBuilders.standaloneSetup(new RavenController(null, null, null, service, null, null, null, null)).build();
    }
}
