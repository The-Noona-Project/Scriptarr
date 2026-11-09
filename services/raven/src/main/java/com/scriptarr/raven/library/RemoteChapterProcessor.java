package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenNamingSettings;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Coordinator-owned chapter transport and fenced artifact acceptance; never runs a local encoder. */
@Service
public final class RemoteChapterProcessor {
    private final IngestBrokerClient client;
    private final RavenBrokerClient catalog;
    private final Path root;
    private final ObjectMapper json = new ObjectMapper();
    private final boolean required;
    /** Immutable output profile shared by coordinator and workers. */
    public static final Map<String, Object> PROFILE = Map.of("format", "webp", "quality", 85, "method", 4,
        "threads", 2, "pageConcurrency", 1, "maxDimension", 16383, "segmentationVersion", 2);

    /** @param catalog strict Sage catalog transport @param logger coordinator data-root owner */
    @Autowired
    public RemoteChapterProcessor(RavenBrokerClient catalog, ScriptarrLogger logger) {
        this.catalog = catalog; client = new IngestBrokerClient(System.getenv());
        Path downloads = logger.getDownloadsRoot(); root = (downloads == null ? Path.of("/downloads") : downloads).resolve(".ingest-jobs").toAbsolutePath().normalize();
        required = remoteRequired(System.getenv());
    }

    /** @param catalog isolated strict catalog @param downloads isolated managed root @param client explicit test broker transport @param required remote-only policy */
    RemoteChapterProcessor(RavenBrokerClient catalog, Path downloads, IngestBrokerClient client, boolean required) {
        this.catalog = catalog; this.root = downloads.resolve(".ingest-jobs").toAbsolutePath().normalize(); this.client = client; this.required = required;
    }

    /** @return whether this coordinator requires remote WebP conversion */
    public boolean required() { return required; }

    /** @param env explicit deployment settings @return remote-only processing whenever WebP output or the remote policy is selected */
    static boolean remoteRequired(Map<String, String> env) {
        return "webp".equalsIgnoreCase(env.getOrDefault("SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT", "").trim())
            || "true".equalsIgnoreCase(env.getOrDefault("SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "").trim());
    }

    /**
     * Persist an immutable chapter job and wait for a worker without falling back to Plex encoding.
     * @param title owning catalog title
     * @param chapter owning catalog chapter
     * @param archive canonical input
     * @param naming frozen source page ordering settings
     * @param cancelled caller cancellation predicate
     * @param progress actual logical-page completion callback
     * @return fenced artifact ready for coordinator publication
     * @throws Exception when conversion fails, is cancelled, or cannot be verified
     */
    public Result convert(LibraryTitle title, LibraryChapter chapter, Path archive, RavenNamingSettings naming,
                          BooleanSupplier cancelled, Consumer<IngestProgress> progress) throws Exception {
        String hash = WebpChapterEncoder.sha256(archive); List<String> entries;
        try (ZipFile zip = new ZipFile(archive.toFile())) {
            entries = zip.stream().filter(e -> !e.isDirectory() && ArchiveImageEntries.isImage(e.getName()))
                .sorted(Comparator.comparingInt((ZipEntry e) -> LibraryNaming.extractPageOrder(e.getName(), naming, title.libraryTypeSlug())).thenComparing(ZipEntry::getName)).map(ZipEntry::getName).toList();
        }
        if (entries.isEmpty()) throw new IOException("Canonical input has no source pages.");
        String id = jobId(title.id(), chapter.id(), hash, entries);
        Map<String, Object> input = new LinkedHashMap<>(Map.of("titleId", title.id(), "chapterId", chapter.id(), "sourceFingerprint", Map.of("sha256", hash, "size", Files.size(archive)),
            "sourcePageCount", entries.size(), "archiveName", "chapter.cbz", "entries", entries));
        String legacyId = jobId(title.id(), chapter.id(), hash);
        if (reattachLegacy(legacyId, input)) id = legacyId;
        else input.putAll(OrderedPageIdentity.create(entries));
        Map<String, Object> owner = new LinkedHashMap<>(IngestExecutionContext.current()); owner.put("titleId", title.id()); owner.put("chapterId", chapter.id());
        JsonNode job = unwrap(client.json("POST", "/jobs", Map.of("jobId", id, "priority", owner.get("kind"), "spec", Map.of("input", input, "profile", PROFILE, "owner", owner)), null));
        Path descriptor = root.resolve(id); Files.createDirectories(descriptor); json.writeValue(descriptor.resolve("job.json").toFile(), job);
        if (List.of("failed", "cancelled").contains(job.path("status").asText())) {
            long epoch = job.path("lease").path("epoch").asLong();
            job = unwrap(client.json("POST", "/jobs/" + id + "/retry", Map.of("expectedEpoch", epoch, "requestId", "approved_ingest_" + id + "_" + epoch,
                "priority", owner.get("kind"), "owner", owner), null));
        }
        String generation = job.path("spec").path("coordinatorGeneration").asText();
        if (generation.isBlank()) throw new IOException("Conversion execution identity was not acknowledged.");
        int lastPages = -1, lastSegments = -1;
        try {
        while (true) {
            if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("Remote ingest cancelled.");
            }
            if (!generation.equals(job.path("spec").path("coordinatorGeneration").asText())) throw new IOException("Conversion ownership changed; this older waiter cannot publish it.");
            String status = job.path("status").asText(); int pages = job.path("progress").path("completedLogicalPages").asInt();
            int segments = job.path("progress").path("completedSegments").asInt(), totalSegments = job.path("progress").path("totalSegments").asInt();
            progress.accept(new IngestProgress("queued".equals(status) ? "waiting-for-worker" : "waiting-for-encoder", pages, entries.size(), 0, 1,
                (pages > lastPages && pages > 0) || (segments > lastSegments && segments > 0), segments, totalSegments)); lastPages = pages; lastSegments = segments;
            if (List.of("failed", "cancelled").contains(status)) throw new IOException("The remote chapter conversion requires attention.");
            if (List.of("result-ready", "publishing", "completed").contains(status)) {
                long epoch = job.path("lease").path("epoch").asLong(); JsonNode artifact = job.path("result").path("artifact");
                Path directory = jobRoot(id, epoch).resolve("files");
                if (!Files.isRegularFile(directory.resolve("bundle.json"))) throw new IOException("Accepted chapter artifact is missing from coordinator storage.");
                JsonNode bundle = json.readTree(directory.resolve("bundle.json").toFile());
                OrderedPageIdentity.requireBundle(bundle, job.path("spec").path("input"));
                if (!WebpChapterEncoder.sha256(archive).equals(hash)) throw new IOException("Canonical input changed while conversion was pending.");
                if (!"completed".equals(status)) client.json("POST", "/jobs/" + id + "/publish", Map.of("epoch", epoch, "artifactSha256", artifact.path("sha256").asText()), null);
                JsonNode completedChapter = "completed".equals(status) ? job.path("result").path("chapter") : null;
                if (completedChapter != null && !completedChapter.isObject()) throw new IOException("Completed conversion has no original chapter receipt.");
                return new Result(id, epoch, artifact.path("sha256").asText(), directory, bundle, completedChapter == null ? null : completedChapter.deepCopy());
            }
            Thread.sleep(1000); job = unwrap(client.json("GET", "/jobs/" + id, null, null));
        }
        } catch (InterruptedException cancelledWork) { cancelAfterInterrupt(id, generation); throw cancelledWork; }
    }

    /** @param id exact old content identity @param expected current source and ordered entries @return whether a strictly matching legacy job can recover through normal create fencing @throws Exception when lookup or stored ownership data is malformed */
    private boolean reattachLegacy(String id, Map<String, Object> expected) throws Exception {
        JsonNode job;
        try { job = unwrap(client.json("GET", "/jobs/" + id, null, null)); }
        catch (IngestBrokerClient.Rejected rejected) { if (rejected.status() == 404) return false; throw rejected; }
        JsonNode wanted = json.valueToTree(expected);
        if (job == null || !job.isObject() || !id.equals(job.path("jobId").asText())
            || !List.of("queued", "running", "result-ready", "publishing", "completed", "failed", "cancelled").contains(job.path("status").asText())
            || !job.path("spec").path("profile").equals(json.valueToTree(PROFILE))
            || !job.path("spec").path("coordinatorGeneration").isTextual() || job.path("spec").path("coordinatorGeneration").asText().isBlank()) throw new IOException("Legacy conversion lookup is malformed.");
        JsonNode saved = job.path("spec").path("input"), names = saved.path("entries");
        if (!OrderedPageIdentity.fields(saved).isEmpty() || !saved.path("titleId").equals(wanted.path("titleId")) || !saved.path("chapterId").equals(wanted.path("chapterId"))
            || !saved.path("archiveName").equals(wanted.path("archiveName")) || !saved.path("sourceFingerprint").path("sha256").equals(wanted.path("sourceFingerprint").path("sha256"))
            || !saved.path("sourceFingerprint").path("size").isIntegralNumber() || !saved.path("sourceFingerprint").path("size").canConvertToLong() || saved.path("sourceFingerprint").path("size").asLong() != wanted.path("sourceFingerprint").path("size").asLong()
            || !names.isArray() || names.isEmpty() || !saved.path("sourcePageCount").isIntegralNumber() || !saved.path("sourcePageCount").canConvertToInt()
            || saved.path("sourcePageCount").asInt() != names.size()) throw new IOException("Legacy conversion source identity differs.");
        java.util.Set<String> unique = new java.util.HashSet<>();
        for (JsonNode name : names) {
            String value = name.asText();
            if (!name.isTextual() || value.isBlank() || value.length() > 2048 || value.indexOf('\\') >= 0 || value.indexOf('\0') >= 0 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || value.startsWith("/") || value.matches("^[A-Za-z]:.*")
                || java.util.Arrays.stream(value.split("/", -1)).anyMatch(part -> part.equals(".") || part.equals(".."))
                || !unique.add(value) || !ArchiveImageEntries.isImage(value)) throw new IOException("Legacy conversion page order is malformed.");
        }
        return names.equals(wanted.path("entries"));
    }

    /** @param id exact child job to cancel after an interrupted coordinator wait @param generation captured server-issued owning execution token */
    private void cancelAfterInterrupt(String id, String generation) {
        boolean interrupted = Thread.interrupted();
        try { client.json("POST", "/jobs/" + id + "/cancel", Map.of("reason", "Owning ingest was cancelled.", "expectedCoordinatorGeneration", generation), null); }
        catch (Exception unavailable) { /* Parent cancellation and maintenance reconciliation retain the durable fence. */ }
        finally { if (interrupted) Thread.currentThread().interrupt(); }
    }

    /**
     * Resolve a lease-checked canonical input using catalog identity, never a worker-supplied path.
     * @param id immutable job identity
     * @param workerId worker assigned to the lease
     * @param epoch fencing epoch
     * @return exact validated canonical archive
     * @throws Exception when scope, lease or input differs
     */
    public Path input(String id, String workerId, long epoch) throws Exception {
        JsonNode job = requireLease(id, workerId, epoch), input = job.path("spec").path("input");
        JsonNode title = catalog.getLibraryTitle(input.path("titleId").asText()), found = null;
        for (JsonNode chapter : title.path("chapters")) if (input.path("chapterId").asText().equals(chapter.path("id").asText())) found = chapter;
        if (found == null) throw new IOException("Assigned canonical chapter is unavailable.");
        Path archive = Path.of(found.path("archivePath").asText()).toAbsolutePath().normalize();
        Path downloads = root.getParent();
        if (!archive.startsWith(downloads.resolve("downloaded")) || Files.isSymbolicLink(archive) || !Files.isRegularFile(archive)
            || !archive.toRealPath().startsWith(downloads.resolve("downloaded").toRealPath())
            || Files.size(archive) != input.path("sourceFingerprint").path("size").asLong()
            || !WebpChapterEncoder.sha256(archive).equals(input.path("sourceFingerprint").path("sha256").asText())) throw new IOException("Assigned source fingerprint differs.");
        return archive;
    }

    /**
     * Stream, validate and durably submit a worker result before it can become reader-visible.
     * @param id immutable job identity
     * @param workerId assigned worker
     * @param epoch current fencing epoch
     * @param token transient forwarded lease secret
     * @param source streamed ZIP body
     * @return accepted durable job state
     * @throws Exception when archive, output or lease validation fails
     */
    public JsonNode accept(String id, String workerId, long epoch, String token, InputStream source) throws Exception {
        JsonNode job = requireLease(id, workerId, epoch);
        try (var writer = ContentMaintenance.enter("title:" + job.path("spec").path("input").path("titleId").asText(), ContentMaintenance.pathKey(root.resolve(id)))) {
        input(id, workerId, epoch);
        Files.createDirectories(root.resolve(id)); json.writeValue(root.resolve(id).resolve("job.json").toFile(), job);
        Path attempt = jobRoot(id, epoch); Files.createDirectories(attempt); Path upload = Files.createTempFile(attempt, "upload-", ".zip"), candidate = Files.createTempDirectory(attempt, "candidate-");
        try {
            try (var out = Files.newOutputStream(upload)) { byte[] buffer = new byte[65536]; long total = 0; int count; while ((count = source.read(buffer)) >= 0) { total += count; if (total > 2_147_483_648L) throw new IOException("Chapter artifact exceeds its transfer budget."); out.write(buffer, 0, count); } }
            String hash = WebpChapterEncoder.sha256(upload); Path files = attempt.resolve("files");
            JsonNode bundle = unpack(upload, candidate, job.path("spec"));
            int segments = 0; for (JsonNode page : bundle.path("pages")) segments += page.path("segments").size();
            Map<String, Object> artifact = Map.of("sha256", hash, "size", Files.size(upload), "pageCount", bundle.path("pageCount").asInt(), "segmentCount", segments, "manifestSha256", WebpChapterEncoder.sha256(candidate.resolve("bundle.json")));
            requireLease(id, workerId, epoch);
            json.writeValue(candidate.resolve("artifact-proof.json").toFile(), artifact);
            if (Files.exists(files)) {
                if (!json.readTree(files.resolve("artifact-proof.json").toFile()).equals(json.readTree(json.writeValueAsBytes(artifact)))) throw new IOException("A different immutable artifact was already accepted for this epoch.");
            } else {
                try { Files.move(candidate, files, StandardCopyOption.ATOMIC_MOVE); }
                catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(candidate, files); }
            }
            JsonNode accepted = client.json("POST", "/jobs/" + id + "/submit", Map.of("workerId", workerId, "epoch", epoch, "artifact", artifact), token);
            return accepted;
        } finally { Files.deleteIfExists(upload); if (Files.exists(candidate)) try (var paths = Files.walk(candidate)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); } }
        }
    }

    /**
     * Atomically checkpoint the final chapter and completion receipt through Vault's epoch fence.
     * @param result accepted conversion result
     * @param chapter final coordinator-owned chapter checkpoint
     * @return acknowledged catalog chapter
     * @throws Exception when fencing or persistence rejects the checkpoint
     */
    public LibraryChapter complete(Result result, LibraryChapter chapter) throws Exception {
        JsonNode currentJob = unwrap(client.json("GET", "/jobs/" + result.jobId(), null, null));
        Map<String, Object> payload = json.convertValue(chapter, new com.fasterxml.jackson.core.type.TypeReference<>() { });
        payload.putAll(DerivedPageManifest.catalogFields(chapter));
        LibraryChapter expected = json.convertValue(payload, LibraryChapter.class);
        Map<String, Object> request;
        if ("completed".equals(currentJob.path("status").asText())) {
            if (currentJob.path("lease").path("epoch").asLong() != result.epoch() || !result.artifactSha256().equals(currentJob.path("result").path("artifact").path("sha256").asText())) throw new IOException("Completed conversion belongs to another fenced artifact.");
            JsonNode title = catalog.getLibraryTitle(currentJob.path("spec").path("input").path("titleId").asText());
            JsonNode current = null;
            for (JsonNode row : title.path("chapters")) if (chapter.id().equals(row.path("id").asText())) current = row;
            if (acknowledged(current, expected)) return json.treeToValue(current, LibraryChapter.class);
            request = CompletedArtifactRepair.request(currentJob, current, payload);
        } else {
            request = Map.of("epoch", result.epoch(), "artifactSha256", result.artifactSha256(), "chapter", payload);
        }
        JsonNode response = client.json("POST", "/jobs/" + result.jobId() + "/complete", request, null);
        LibraryChapter saved = json.treeToValue(response.path("chapter"), LibraryChapter.class);
        if (!acknowledged(response.path("chapter"), expected)) throw new IOException("The fenced chapter checkpoint was not acknowledged.");
        return saved;
    }

    /** @param row current or acknowledged broker checkpoint @param expected validated output identity @return whether the saved ready chapter matches its logical page and immutable manifest identity */
    private static boolean acknowledged(JsonNode row, LibraryChapter expected) {
        return row != null && row.isObject() && expected.id().equals(row.path("id").asText())
            && expected.ingestRevision().equals(row.path("ingestRevision").asText()) && "ready".equals(row.path("ingestStatus").asText())
            && expected.ingestManifestPath().equals(row.path("ingestManifestPath").asText())
            && expected.pageCount() == row.path("pageCount").asInt(-1) && expected.ingestedPageCount() == row.path("ingestedPageCount").asInt(-1)
            && (expected.sourcePageCount() == null || expected.sourcePageCount() == row.path("sourcePageCount").asInt(-1))
            && (expected.expectedSegmentCount() == null || expected.expectedSegmentCount() == row.path("expectedSegmentCount").asInt(-1))
            && (expected.ingestedSegmentCount() == null || expected.ingestedSegmentCount() == row.path("ingestedSegmentCount").asInt(-1))
            && (expected.segmentsReady() == null || expected.segmentsReady().equals(row.path("segmentsReady").isBoolean() ? row.path("segmentsReady").booleanValue() : null));
    }

    /** @param id job identity @param workerId assigned worker @param epoch fence @return current leased job @throws Exception when scope differs */
    private JsonNode requireLease(String id, String workerId, long epoch) throws Exception {
        if (!id.matches("raven_webp_[a-f0-9]{64}") || epoch <= 0) throw new IOException("Invalid conversion identity.");
        JsonNode job = unwrap(client.json("GET", "/jobs/" + id, null, null));
        if (job.path("lease").path("epoch").asLong() != epoch || !workerId.equals(job.path("lease").path("workerId").asText())
            || !List.of("running", "result-ready", "publishing", "completed").contains(job.path("status").asText())) throw new IOException("Conversion lease is stale.");
        if ("running".equals(job.path("status").asText()) && Instant.parse(job.path("lease").path("expiresAt").asText()).isBefore(Instant.now())) throw new IOException("Conversion lease expired.");
        return job;
    }

    /** @param id exact job id @param epoch fence @return coordinator-owned job scratch @throws IOException when scope is invalid */
    private Path jobRoot(String id, long epoch) throws IOException { if (!id.matches("raven_webp_[a-f0-9]{64}") || epoch <= 0) throw new IOException("Invalid conversion identity."); return root.resolve(id).resolve(Long.toString(epoch)); }

    /**
     * Validate every bounded artifact file and exact segment geometry before acceptance.
     * @param zipPath streamed result ZIP
     * @param target attempt-scoped staging directory
     * @param spec frozen source/output specification
     * @return validated logical-page metadata
     * @throws Exception when any file or ownership assertion fails
     */
    private JsonNode unpack(Path zipPath, Path target, JsonNode spec) throws Exception {
        try (ZipFile zip = new ZipFile(zipPath.toFile())) {
            ZipEntry metadata = zip.getEntry("bundle.json"); if (metadata == null || metadata.getSize() <= 0 || metadata.getSize() > 8_388_608) throw new IOException("Invalid artifact manifest.");
            try (InputStream in = zip.getInputStream(metadata)) { WebpChapterEncoder.copyBounded(in, target.resolve("bundle.json"), metadata.getSize(), 8_388_608); }
            JsonNode bundle = json.readTree(target.resolve("bundle.json").toFile());
            OrderedPageIdentity.requireBundle(bundle, spec.path("input"));
            if (!"webp".equals(bundle.path("format").asText()) || !"image/webp".equals(bundle.path("mediaType").asText())
                || !"ffmpeg/libwebp".equals(bundle.path("encoder").asText()) || !bundle.path("profile").equals(spec.path("profile"))
                || bundle.path("pageCount").asInt() != spec.path("input").path("sourcePageCount").asInt()
                || !bundle.path("pages").isArray() || bundle.path("pages").size() != bundle.path("pageCount").asInt()) throw new IOException("Artifact specification differs.");
            List<String> allowed = new ArrayList<>(); allowed.add("bundle.json"); long[] remaining = {2_147_483_648L - metadata.getSize()};
            for (int index = 0; index < bundle.path("pages").size(); index++) {
                JsonNode page = bundle.path("pages").get(index); if (page.path("index").asInt(-1) != index) throw new IOException("Logical page order differs.");
                List<WebpSegmentation.Rectangle> rectangles = WebpSegmentation.split(page.path("width").asInt(), page.path("height").asInt(), spec.path("profile").path("segmentationVersion").asInt());
                if (page.path("segments").size() != rectangles.size()) throw new IOException("Logical page coverage differs.");
                for (WebpSegmentation.Rectangle rectangle : rectangles) {
                    JsonNode segment = page.path("segments").get(rectangle.index());
                    if (segment.path("index").asInt(-1) != rectangle.index() || segment.path("x").asInt(-1) != rectangle.x() || segment.path("y").asInt(-1) != rectangle.y()
                        || segment.path("width").asInt() != rectangle.width() || segment.path("height").asInt() != rectangle.height()) throw new IOException("Segment geometry differs.");
                    extract(zip, target, segment, allowed, remaining);
                }
                if (index == 0) { JsonNode thumbnail = page.path("thumbnail"); double scale = Math.min(1, Math.min(512.0 / page.path("width").asInt(), 768.0 / page.path("height").asInt()));
                    if (thumbnail.path("width").asInt() != Math.max(1, (int) (page.path("width").asInt() * scale)) || thumbnail.path("height").asInt() != Math.max(1, (int) (page.path("height").asInt() * scale))) throw new IOException("Full-page cover thumbnail geometry differs."); extract(zip, target, thumbnail, allowed, remaining); }
            }
            if (zip.size() != allowed.size() || allowed.stream().distinct().count() != allowed.size()) throw new IOException("Unexpected or duplicate artifact files.");
            return bundle;
        }
    }

    /** @param zip validated result container @param target exact attempt directory @param row file declaration @param allowed collected exact names @param remaining aggregate actual extraction budget @throws Exception when bytes or ownership differ */
    private static void extract(ZipFile zip, Path target, JsonNode row, List<String> allowed, long[] remaining) throws Exception {
        String slug = row.path("slug").asText(); if (!slug.matches("p[0-9]{6}(?:-s[0-9]{4}|-thumbnail)\\.webp")) throw new IOException("Invalid WebP artifact filename.");
        ZipEntry entry = zip.getEntry(slug); if (entry == null || entry.isDirectory() || entry.getSize() <= 12 || entry.getSize() > 134_217_728 || entry.getSize() != row.path("size").asLong()) throw new IOException("WebP artifact size differs.");
        remaining[0] -= entry.getSize(); if (remaining[0] < 0) throw new IOException("Chapter extraction exceeds its actual byte budget.");
        Path output = target.resolve(slug); if (Files.isSymbolicLink(output)) throw new IOException("Artifact target must not be a link.");
        try (InputStream in = zip.getInputStream(entry)) { WebpChapterEncoder.copyBounded(in, output, entry.getSize(), 134_217_728L); }
        if (!WebpChapterEncoder.sha256(output).equals(row.path("sha256").asText())) throw new IOException("WebP artifact hash differs.");
        try (InputStream in = Files.newInputStream(output)) { byte[] header = in.readNBytes(12); if (!new String(header, 0, 4, java.nio.charset.StandardCharsets.US_ASCII).equals("RIFF") || !new String(header, 8, 4, java.nio.charset.StandardCharsets.US_ASCII).equals("WEBP")) throw new IOException("Artifact is not WebP."); }
        JsonNode dimensions = new ObjectMapper().readTree(MediaProcess.run(List.of("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", output.toString()), true)).path("streams").path(0);
        if (dimensions.path("width").asInt() != row.path("width").asInt() || dimensions.path("height").asInt() != row.path("height").asInt()) throw new IOException("Decoded WebP geometry differs.");
        MediaProcess.run(List.of("ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-i", output.toString(), "-frames:v", "1", "-f", "null", "-"), false);
        allowed.add(slug);
    }

    /** @param titleId logical title @param chapterId logical chapter @param sourceHash immutable input @return protocol-stable conversion id @throws Exception when hashing fails */
    public static String jobId(String titleId, String chapterId, String sourceHash) throws Exception {
        ObjectMapper json = new ObjectMapper(); Object identity = canonical(Map.of("titleId", titleId, "chapterId", chapterId, "sourceSha256", sourceHash, "profile", PROFILE));
        return "raven_webp_" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(identity)));
    }

    /** @param titleId logical title @param chapterId logical chapter @param sourceHash immutable input @param entries frozen logical page order @return versioned content/order identity @throws Exception when hashing fails */
    public static String jobId(String titleId, String chapterId, String sourceHash, List<String> entries) throws Exception {
        Map<String, Object> identity = new LinkedHashMap<>(Map.of("titleId", titleId, "chapterId", chapterId, "sourceSha256", sourceHash, "profile", PROFILE));
        identity.putAll(OrderedPageIdentity.create(entries));
        return "raven_webp_" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(new ObjectMapper().writeValueAsBytes(canonical(identity))));
    }

    /** @param value JSON-like identity @return recursively key-sorted identity */
    private static Object canonical(Object value) { if (value instanceof Map<?, ?> map) { Map<String, Object> sorted = new TreeMap<>(); map.forEach((key, entry) -> sorted.put(String.valueOf(key), canonical(entry))); return sorted; } if (value instanceof List<?> list) return list.stream().map(RemoteChapterProcessor::canonical).toList(); return value; }

    /** @param value broker envelope @return contained job or unwrapped value */
    private static JsonNode unwrap(JsonNode value) { return value != null && value.has("job") ? value.path("job") : value; }

    /** Accepted worker output awaiting coordinator publication and atomic catalog completion. */
    public record Result(String jobId, long epoch, String artifactSha256, Path directory, JsonNode bundle, JsonNode completedChapter) {
        /** @param jobId immutable job @param epoch transport fence @param artifactSha256 accepted transfer digest @param directory private accepted files @param bundle validated artifact metadata */
        public Result(String jobId, long epoch, String artifactSha256, Path directory, JsonNode bundle) { this(jobId, epoch, artifactSha256, directory, bundle, null); }
    }
}
