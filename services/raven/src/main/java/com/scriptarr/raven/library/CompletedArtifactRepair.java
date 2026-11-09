package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Build a fenced repair request from immutable completed output and the exact current broker checkpoint. */
public final class CompletedArtifactRepair {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() { };
    private static final List<String> IDENTITY = List.of("id", "archivePath", "sourceUrl", "ingestRevision", "ingestManifestPath",
        "pageCount", "sourcePageCount", "ingestedPageCount", "expectedSegmentCount", "ingestedSegmentCount");
    private static final Set<String> READINESS = Set.of("ingestStatus", "ingestError", "ingestedAt", "updatedAt", "segmentsReady");
    private static final int MAX_JSON_BYTES = 8_388_608;

    /** Prevent construction of this side-effect-free request builder. */
    private CompletedArtifactRepair() { }

    /**
     * Build the existing complete-route CAS body only after the caller has verified the repaired manifest and every file.
     * This utility performs no filesystem, broker, retry, enqueue or catalog operation. The server must repeat all checks
     * under its catalog lock and preserve the original completion receipt and current source/quality metadata.
     *
     * @param job current raw completed conversion job, including its original chapter receipt
     * @param currentChapter exact raw chapter object returned by the current Vault catalog GET
     * @param desiredReadyChapter caller-validated ready checkpoint, including all four logical/physical readiness fields
     * @return complete request bound to the current raw chapter fingerprint, generation, epoch and immutable artifact
     * @throws IOException when identity, output evidence, source metadata or state is missing or changed
     */
    public static Map<String, Object> request(JsonNode job, JsonNode currentChapter,
                                              Map<String, Object> desiredReadyChapter) throws IOException {
        if (job == null || currentChapter == null || desiredReadyChapter == null || !job.isObject() || !currentChapter.isObject()) throw conflict();
        JsonNode desired = JSON.valueToTree(desiredReadyChapter), original = job.path("result").path("chapter"), input = job.path("spec").path("input");
        String jobId = job.path("jobId").asText(), artifact = job.path("result").path("artifact").path("sha256").asText();
        String generation = job.path("spec").path("coordinatorGeneration").asText();
        JsonNode epochNode = job.path("lease").path("epoch");
        if (!"completed".equals(job.path("status").asText()) || !jobId.matches("raven_webp_[a-f0-9]{64}")
            || !artifact.matches("[a-f0-9]{64}") || !generation.matches("[A-Za-z0-9_.:-]{1,160}")
            || !epochNode.isIntegralNumber() || !epochNode.canConvertToLong() || epochNode.asLong() <= 0
            || !original.isObject() || !input.isObject() || !desired.isObject()) throw conflict();
        long epoch = epochNode.asLong();
        if (!input.path("titleId").asText().matches("[A-Za-z0-9_.:-]{1,160}")
            || !input.path("chapterId").asText().matches("[A-Za-z0-9_.:-]{1,160}")
            || !input.path("chapterId").asText().equals(original.path("id").asText())
            || !input.path("sourceFingerprint").path("sha256").asText().matches("[a-f0-9]{64}")
            || positive(input.path("sourceFingerprint").path("size")) > 21_474_836_480L) throw conflict();
        if (!Set.of("failed", "pending").contains(currentChapter.path("ingestStatus").asText())
            || !"ready".equals(original.path("ingestStatus").asText()) || !"ready".equals(desired.path("ingestStatus").asText())
            || !currentChapter.path("available").isBoolean() || !currentChapter.path("available").asBoolean()
            || !original.path("available").isBoolean() || !original.path("available").asBoolean()
            || !desired.path("available").isBoolean() || !desired.path("available").asBoolean()
            || !original.path("segmentsReady").isBoolean() || !original.path("segmentsReady").asBoolean()
            || !desired.path("segmentsReady").isBoolean() || !desired.path("segmentsReady").asBoolean()
            || !original.path("ingestRevision").asText().matches("webp-[a-f0-9]{16}")) throw conflict();
        for (String field : IDENTITY) {
            if (!original.has(field) || !currentChapter.has(field) || !desired.has(field)
                || !same(original.path(field), currentChapter.path(field)) || !same(original.path(field), desired.path(field))) throw conflict();
        }
        long logicalPages = positive(input.path("sourcePageCount")), segmentCount = positive(original.path("expectedSegmentCount"));
        if (positive(original.path("pageCount")) != logicalPages || positive(original.path("sourcePageCount")) != logicalPages
            || positive(original.path("ingestedPageCount")) != logicalPages || segmentCount < logicalPages
            || positive(original.path("ingestedSegmentCount")) != segmentCount
            || positive(job.path("result").path("artifact").path("segmentCount")) != segmentCount) throw conflict();
        String archive = original.path("archivePath").asText(), manifest = original.path("ingestManifestPath").asText();
        if (!safePath(archive, "/downloads/downloaded/") || !safePath(manifest, "/downloads/ingested/")
            || !manifest.endsWith("/manifest.json")
            || !manifest.contains("/" + input.path("titleId").asText() + "/" + input.path("chapterId").asText() + "/")) throw conflict();
        // A DTO may omit unknown broker fields; those remain bound by the full raw fingerprint and server-side merge.
        for (var fields = desired.fieldNames(); fields.hasNext();) {
            String field = fields.next();
            if (!READINESS.contains(field) && (!currentChapter.has(field) || !same(currentChapter.path(field), desired.path(field)))) throw conflict();
        }
        String fingerprint = digest(currentChapter);
        String requestId = "repair_" + digest(JSON.valueToTree(Map.of("jobId", jobId, "epoch", epoch,
            "artifactSha256", artifact, "fingerprint", fingerprint)));
        return Map.of("epoch", epoch, "artifactSha256", artifact, "expectedCoordinatorGeneration", generation,
            "chapter", JSON.convertValue(desired, MAP), "repair", Map.of("requestId", requestId, "expectedCurrentChapterFingerprint", fingerprint));
    }

    /** @param value integral evidence @return positive value @throws IOException when evidence is absent or malformed */
    private static long positive(JsonNode value) throws IOException {
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.asLong() <= 0) throw conflict();
        return value.asLong();
    }

    /** @param path immutable managed filename @param prefix exact storage category @return whether the lexical path is safe */
    private static boolean safePath(String path, String prefix) {
        return path.startsWith(prefix) && !path.contains("\\") && !path.contains("//") && !path.contains("/../")
            && !path.contains("/./") && path.chars().noneMatch(value -> value < 32 || value == 127);
    }

    /** @param left first checkpoint value @param right second checkpoint value @return exact JSON equality independent of Java integer wrappers @throws IOException when serialization fails */
    private static boolean same(JsonNode left, JsonNode right) throws IOException { return Arrays.equals(bytes(left), bytes(right)); }

    /** @param value raw broker JSON @return recursively key-sorted compact JSON, retaining arrays, nulls and unknown fields @throws IOException when oversized */
    private static byte[] bytes(JsonNode value) throws IOException {
        byte[] result = JSON.writeValueAsBytes(sorted(value));
        if (result.length > MAX_JSON_BYTES) throw conflict();
        return result;
    }

    /** @param value raw JSON value @return independent JSON tree with recursively sorted object fields */
    private static JsonNode sorted(JsonNode value) {
        if (value.isObject()) {
            ObjectNode result = JSON.createObjectNode(); TreeSet<String> names = new TreeSet<>(); value.fieldNames().forEachRemaining(names::add);
            for (String name : names) result.set(name, sorted(value.path(name)));
            return result;
        }
        if (value.isArray()) { ArrayNode result = JSON.createArrayNode(); for (JsonNode item : value) result.add(sorted(item)); return result; }
        return value.deepCopy();
    }

    /** @param value raw JSON @return SHA256 over recursively sorted compact JSON @throws IOException when hashing or serialization fails */
    private static String digest(JsonNode value) throws IOException {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes(value))); }
        catch (java.security.NoSuchAlgorithmException unavailable) { throw new IOException("Repair fingerprinting is unavailable.", unavailable); }
    }

    /** @return bounded error containing no private source URLs, paths, raw metadata or credentials */
    private static IOException conflict() { return new IOException("completed_artifact_repair_conflict: completed output no longer matches the current chapter."); }
}
