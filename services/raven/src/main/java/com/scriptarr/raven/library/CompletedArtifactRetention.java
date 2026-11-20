package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenBrokerClient;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.nio.file.StandardCopyOption;

/** Reclaims only acknowledged duplicate WebP payloads; receipts and canonical reader files remain intact. */
final class CompletedArtifactRetention {
    private static final ObjectMapper JSON = new ObjectMapper();
    private CompletedArtifactRetention() { }

    /** @param downloads managed root @param catalog strict broker @param job completed conversion @return validated canonical output @throws Exception when durable or physical proof is incomplete */
    static LibraryChapter canonical(Path downloads, RavenBrokerClient catalog, JsonNode job) throws Exception {
        if (!"completed".equals(job.path("status").asText())) throw new IOException("Conversion is not durably completed.");
        JsonNode input = job.path("spec").path("input"), receipt = job.path("result").path("chapter");
        JsonNode title = catalog.getLibraryTitle(input.path("titleId").asText()), current = null;
        if (title != null) for (JsonNode chapter : title.path("chapters")) if (input.path("chapterId").asText().equals(chapter.path("id").asText())) current = chapter;
        if (current == null || !current.path("ingestManifestPath").equals(receipt.path("ingestManifestPath"))
            || !current.path("ingestRevision").equals(receipt.path("ingestRevision"))) throw new IOException("Completed artifact does not match the current catalog checkpoint.");
        LibraryChapter chapter = JSON.treeToValue(current, LibraryChapter.class);
        Path manifest = Path.of(chapter.ingestManifestPath()).toAbsolutePath().normalize(), archive = Path.of(chapter.archivePath()).toAbsolutePath().normalize();
        requireScoped(archive, downloads.resolve("downloaded"));
        if (Files.size(archive) != input.path("sourceFingerprint").path("size").asLong(-1)
            || !WebpChapterEncoder.sha256(archive).equals(input.path("sourceFingerprint").path("sha256").asText())) throw new IOException("Canonical source changed.");
        if (!manifest.startsWith(downloads.resolve("ingested").toAbsolutePath().normalize()) || Files.isSymbolicLink(manifest)) throw new IOException("Unsafe canonical reader scope.");
        JsonNode saved;
        try { requireScoped(manifest, downloads.resolve("ingested")); saved = DerivedPageManifest.read(chapter); }
        catch (IOException missing) { throw new OutputUnavailable("Canonical reader output is unavailable.", missing); }
        JsonNode publication = job.path("result").path("publication");
        long publishedEpoch = publication.isObject() ? publication.path("epoch").asLong() : job.path("lease").path("epoch").asLong();
        String publishedArtifact = publication.isObject() ? publication.path("artifactSha256").asText() : job.path("result").path("artifact").path("sha256").asText();
        if (!job.path("jobId").asText().equals(saved.path("conversionJobId").asText())
            || publishedEpoch != saved.path("conversionEpoch").asLong() || !publishedArtifact.equals(saved.path("artifactSha256").asText())
            || (publication.isObject() && (!job.path("jobId").asText().equals(publication.path("jobId").asText())
                || !WebpChapterEncoder.sha256(manifest).equals(publication.path("manifestSha256").asText())))) throw new IOException("Canonical reader output identity changed.");
        if (!DerivedPageManifest.reusable(chapter)) throw new OutputUnavailable("Canonical reader output is incomplete.", null);
        OrderedPageIdentity.requireBundle(saved, input);
        return chapter;
    }

    /** @param root managed downloads @param catalog strict catalog @param job exact completed conversion @param now UTC clock @return whether payload was reclaimed @throws Exception on invalid proof or unsafe scope */
    static boolean reclaim(Path root, RavenBrokerClient catalog, JsonNode job, Instant now) throws Exception {
        if (!"completed".equals(job.path("status").asText())) return false;
        Instant completed = Instant.parse(job.path("updatedAt").asText());
        if (Duration.between(completed, now).compareTo(Duration.ofHours(24)) < 0) return false;
        String id = job.path("jobId").asText(); long epoch = job.path("lease").path("epoch").asLong();
        if (!id.matches("raven_webp_[a-f0-9]{64}") || epoch <= 0) throw new IOException("Invalid conversion identity.");
        String titleId = job.path("spec").path("input").path("titleId").asText();
        Path files = root.resolve(".ingest-jobs").resolve(id).resolve(String.valueOf(epoch)).resolve("files");
        if (!Files.exists(files)) return false;
        Path marker = files.resolve("payload-reclaimed.json");
        if (Files.isRegularFile(marker) && "completed".equals(JSON.readTree(marker.toFile()).path("phase").asText())) return false;
        requireScoped(files, root.resolve(".ingest-jobs"));
        String operation = "artifact_gc_" + id.substring("raven_webp_".length());
        List<String> keys = List.of("title:" + titleId, ContentMaintenance.pathKey(files));
        var fence = ContentMaintenance.tryQuiescent(operation, keys);
        if (fence == null) return false;
        try (fence) {
            LibraryChapter canonical = canonical(root, catalog, job);
            Map<String, JsonNode> expected = new LinkedHashMap<>();
            for (JsonNode page : DerivedPageManifest.read(canonical).path("pages")) {
                for (JsonNode segment : page.path("segments")) expected.put(segment.path("slug").asText(), segment);
                if (page.path("thumbnail").isObject()) expected.put(page.path("thumbnail").path("slug").asText(), page.path("thumbnail"));
            }
            List<Path> payload;
            try (var entries = Files.list(files)) { payload = entries.filter(p -> p.getFileName().toString().endsWith(".webp")).toList(); }
            for (Path entry : payload) {
                JsonNode evidence = expected.get(entry.getFileName().toString());
                if (evidence == null || Files.isSymbolicLink(entry) || !Files.isRegularFile(entry)
                    || Files.size(entry) != evidence.path("size").asLong() || !WebpChapterEncoder.sha256(entry).equals(evidence.path("sha256").asText())) throw new IOException("Unverified duplicate artifact payload is preserved.");
            }
            writeMarker(marker, Map.of("phase", "reclaiming", "jobId", id, "epoch", epoch,
                "artifactSha256", job.path("result").path("artifact").path("sha256").asText(), "manifest", canonical.ingestManifestPath(), "reclaimedAt", now.toString()));
            for (Path entry : payload) Files.delete(entry);
            writeMarker(marker, Map.of("phase", "completed", "jobId", id, "epoch", epoch, "reclaimedAt", now.toString()));
            return true;
        }
    }

    /** @param marker exact receipt path @param value bounded phase receipt @throws IOException when the atomic phase cannot be checkpointed */
    private static void writeMarker(Path marker, Map<String, Object> value) throws IOException {
        Path temporary = marker.resolveSibling("payload-reclaimed.partial");
        JSON.writeValue(temporary.toFile(), value);
        Files.move(temporary, marker, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    /** Verified source/catalog binding whose published reader payload needs reconstruction. */
    static final class OutputUnavailable extends IOException {
        /** @param message missing-output reason @param cause optional physical validation failure */
        OutputUnavailable(String message, Throwable cause) { super(message, cause); }
    }

    /** @param path existing managed object @param root exact permitted category @throws IOException when a path escapes its physical category */
    private static void requireScoped(Path path, Path root) throws IOException {
        if (Files.isSymbolicLink(path) || !path.toAbsolutePath().normalize().startsWith(root.toAbsolutePath().normalize())
            || !path.toRealPath().startsWith(root.toRealPath())) throw new IOException("Artifact recovery scope is unsafe.");
    }
}
