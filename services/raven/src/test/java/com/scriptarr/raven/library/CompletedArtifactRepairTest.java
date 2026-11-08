package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Completed-file repairs bind raw broker state without changing source identity, quality history or attempt ownership. */
class CompletedArtifactRepairTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() { };
    private static final String CURRENT_JSON = """
        {
          "updatedAt":"2026-11-08T00:00:01.000Z",
          "futureCheckpoint":{"z":null,"a":[{"b":2,"a":"saved evidence"}]},
          "id":"chapter",
          "label":"Retained source label",
          "chapterNumber":"1",
          "pageCount":1,
          "releaseDate":null,
          "available":true,
          "archivePath":"/downloads/downloaded/manhua/Retained/c001.cbz",
          "sourceUrl":"https://source.invalid/chapter/1",
          "qualityStatus":"possible_missing_page",
          "expectedPageCount":1,
          "missingPageCount":1,
          "missingPages":[1],
          "qualityNotes":["Reader page 1 was unavailable.","Retain provider evidence."],
          "ingestStatus":"failed",
          "ingestRevision":"webp-aaaaaaaaaaaaaaaa",
          "ingestedPageCount":1,
          "ingestedAt":"2026-11-08T00:00:00.000Z",
          "ingestError":"A saved reader page is missing.",
          "ingestManifestPath":"/downloads/ingested/manhua/title/chapter/webp-aaaaaaaaaaaaaaaa/manifest.json",
          "sourcePageCount":1,
          "expectedSegmentCount":10,
          "ingestedSegmentCount":10,
          "segmentsReady":false
        }
        """;
    private static final String EXPECTED_RAW_FINGERPRINT = "c7b9723ac2457f30167f799490ccccda4b41e7cecc5b11a2c52b49f206325110";

    /** Verify the exact wire shape and a raw fingerprint independently calculated using Node's server JSON convention. */
    @Test void buildsFencedRepairWithoutDroppingRawUnknownFields() throws Exception {
        ObjectNode current = current(), job = job(current); Map<String, Object> desired = desired(current);
        Map<String, Object> request = CompletedArtifactRepair.request(job, current, desired);
        JsonNode result = JSON.valueToTree(request);
        assertEquals(7, result.path("epoch").asLong());
        assertEquals("b".repeat(64), result.path("artifactSha256").asText());
        assertEquals("generation-1", result.path("expectedCoordinatorGeneration").asText());
        assertEquals(EXPECTED_RAW_FINGERPRINT, result.path("repair").path("expectedCurrentChapterFingerprint").asText());
        assertTrue(result.path("repair").path("requestId").asText().matches("repair_[a-f0-9]{64}"));
        assertEquals("ready", result.path("chapter").path("ingestStatus").asText());
        assertTrue(result.path("chapter").path("segmentsReady").asBoolean());
        assertEquals(current.path("qualityNotes"), result.path("chapter").path("qualityNotes"));
        assertEquals(current.path("missingPages"), result.path("chapter").path("missingPages"));
        assertFalse(result.path("chapter").has("futureCheckpoint"), "Unknown metadata stays on the server and is still fingerprint-bound.");
    }

    /** Verify raw key order is irrelevant while nulls, unknown values and ordered arrays remain bound. */
    @Test void rawFingerprintRetainsNullUnknownAndArraySemantics() throws Exception {
        ObjectNode current = current(), reversed = JSON.createObjectNode(); List<String> fields = new ArrayList<>(); current.fieldNames().forEachRemaining(fields::add); Collections.reverse(fields);
        fields.forEach(name -> reversed.set(name, current.path(name)));
        JsonNode original = JSON.valueToTree(CompletedArtifactRepair.request(job(current), current, desired(current)));
        JsonNode reordered = JSON.valueToTree(CompletedArtifactRepair.request(job(current), reversed, desired(current)));
        assertEquals(original.path("repair"), reordered.path("repair"));
        ObjectNode changed = current.deepCopy(); ((ObjectNode) changed.path("futureCheckpoint")).put("z", "");
        JsonNode updated = JSON.valueToTree(CompletedArtifactRepair.request(job(current), changed, desired(current)));
        assertNotEquals(original.path("repair"), updated.path("repair"));
        ObjectNode omitted = current.deepCopy(); omitted.remove("futureCheckpoint");
        assertNotEquals(original.path("repair"), JSON.valueToTree(CompletedArtifactRepair.request(job(current), omitted, desired(current))).path("repair"));
        ObjectNode array = current.deepCopy(); array.putArray("qualityNotes").add("Retain provider evidence.").add("Reader page 1 was unavailable.");
        assertNotEquals(original.path("repair"), JSON.valueToTree(CompletedArtifactRepair.request(job(current), array, desired(array))).path("repair"));
    }

    /** Verify reset, already-ready, running or absent current rows cannot be republished through this repair path. */
    @Test void rejectsResetAndNonRepairableCurrentStates() throws Exception {
        ObjectNode current = current(), job = job(current);
        for (String state : List.of("ready", "running", "missing", "cancelled", "")) {
            ObjectNode changed = current.deepCopy(); changed.put("ingestStatus", state);
            assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, changed, desired(current)));
        }
        ObjectNode unavailable = current.deepCopy(); unavailable.put("available", false);
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, unavailable, desired(current)));
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, JSON.createObjectNode(), desired(current)));
        ObjectNode pending = current.deepCopy(); pending.put("ingestStatus", "pending");
        assertNotNull(CompletedArtifactRepair.request(job, pending, desired(pending)));
    }

    /** Verify changed source paths, output identities, page counts or retained segment evidence fail before any broker action. */
    @Test void rejectsChangedImmutableContentIdentity() throws Exception {
        ObjectNode current = current(), job = job(current);
        for (String field : List.of("id", "archivePath", "sourceUrl", "ingestRevision", "ingestManifestPath")) {
            ObjectNode changed = current.deepCopy(); changed.put(field, "different");
            assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, changed, desired(changed)));
        }
        for (String field : List.of("pageCount", "sourcePageCount", "ingestedPageCount", "expectedSegmentCount", "ingestedSegmentCount")) {
            ObjectNode changed = current.deepCopy(); changed.put(field, 99);
            assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, changed, desired(changed)));
        }
        ObjectNode absent = current.deepCopy(); absent.remove("sourcePageCount");
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, absent, desired(absent)));
    }

    /** Verify a readiness repair cannot rewrite labels, source quality, missing-page lists or provider evidence. */
    @Test void rejectsDesiredMetadataAndQualityChanges() throws Exception {
        ObjectNode current = current(), job = job(current);
        for (String field : List.of("label", "chapterNumber", "sourceUrl", "qualityStatus")) {
            Map<String, Object> changed = desired(current); changed.put(field, "replacement");
            assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, current, changed));
        }
        for (String field : List.of("missingPages", "qualityNotes")) {
            Map<String, Object> changed = desired(current); changed.put(field, List.of());
            assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, current, changed));
        }
        Map<String, Object> incomplete = desired(current); incomplete.put("segmentsReady", false);
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(job, current, incomplete));
    }

    /** Verify generation, completed receipt, epoch, artifact and exact input evidence are mandatory. */
    @Test void rejectsMissingOrMalformedCompletionFences() throws Exception {
        ObjectNode current = current(), job = job(current);
        ObjectNode noGeneration = job.deepCopy(); ((ObjectNode) noGeneration.path("spec")).remove("coordinatorGeneration");
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(noGeneration, current, desired(current)));
        ObjectNode wrongEpoch = job.deepCopy(); ((ObjectNode) wrongEpoch.path("lease")).put("epoch", "7");
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(wrongEpoch, current, desired(current)));
        ObjectNode active = job.deepCopy(); active.put("status", "publishing");
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(active, current, desired(current)));
        ObjectNode wrongArtifact = job.deepCopy(); ((ObjectNode) wrongArtifact.path("result").path("artifact")).put("segmentCount", 1);
        assertThrows(IOException.class, () -> CompletedArtifactRepair.request(wrongArtifact, current, desired(current)));
        ObjectNode wrongInput = job.deepCopy(); ((ObjectNode) wrongInput.path("spec").path("input")).put("chapterId", "foreign");
        IOException failure = assertThrows(IOException.class, () -> CompletedArtifactRepair.request(wrongInput, current, desired(current)));
        assertTrue(failure.getMessage().startsWith("completed_artifact_repair_conflict")); assertFalse(failure.getMessage().contains("source.invalid"));
    }

    /** Verify building a request neither changes raw inputs nor keeps mutable references to the caller's desired checkpoint. */
    @Test void requestIsDeterministicAndIndependentOfCallerMutation() throws Exception {
        ObjectNode current = current(), job = job(current); Map<String, Object> desired = desired(current);
        JsonNode savedJob = job.deepCopy(), savedCurrent = current.deepCopy();
        Map<String, Object> result = CompletedArtifactRepair.request(job, current, desired);
        assertEquals(JSON.valueToTree(result), JSON.valueToTree(CompletedArtifactRepair.request(job, current, desired)));
        desired.put("label", "Later caller change");
        assertEquals("Retained source label", JSON.valueToTree(result).path("chapter").path("label").asText());
        assertEquals(savedJob, job); assertEquals(savedCurrent, current);
    }

    /** @return exact raw broker response fixture @throws Exception when test JSON cannot be read */
    private ObjectNode current() throws Exception { return (ObjectNode) JSON.readTree(CURRENT_JSON); }

    /** @param current raw current metadata @return caller-validated ready checkpoint retaining source quality */
    private Map<String, Object> desired(ObjectNode current) {
        ObjectNode result = current.deepCopy(); result.remove("futureCheckpoint"); result.put("ingestStatus", "ready").put("ingestError", "").put("segmentsReady", true).put("updatedAt", "2026-11-08T00:00:02.000Z");
        return JSON.convertValue(result, MAP);
    }

    /** @param current damaged checkpoint @return immutable original completed conversion job */
    private ObjectNode job(ObjectNode current) {
        ObjectNode original = current.deepCopy(); original.remove("futureCheckpoint"); original.put("ingestStatus", "ready").put("ingestError", "").put("segmentsReady", true);
        original.put("qualityStatus", "clean").put("missingPageCount", 0); original.putArray("missingPages"); original.putArray("qualityNotes").add("Original provider evidence.");
        return JSON.valueToTree(Map.of("jobId", "raven_webp_" + "c".repeat(64), "status", "completed", "lease", Map.of("epoch", 7),
            "spec", Map.of("coordinatorGeneration", "generation-1", "input", Map.of("titleId", "title", "chapterId", "chapter", "sourcePageCount", 1,
                "sourceFingerprint", Map.of("sha256", "d".repeat(64), "size", 100))),
            "result", Map.of("chapter", original, "artifact", Map.of("sha256", "b".repeat(64), "segmentCount", 10))));
    }
}
