package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.DownloaderService;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Exact-plan content cleanup, retaining metadata, progress, aliases and immutable run history. */
@Service
public final class ScopedContentCleanup {
    private final Path downloads;
    private final DownloaderService downloader;
    private final LibraryIngestService ingest;
    private final RavenBrokerClient catalog;
    private final IngestBrokerClient broker;
    private final ObjectMapper json = new ObjectMapper();

    /** @param logger canonical storage owner @param downloader actual execution registry @param ingest actual page work registry @param catalog strict catalog broker */
    @Autowired
    public ScopedContentCleanup(ScriptarrLogger logger, DownloaderService downloader, LibraryIngestService ingest, RavenBrokerClient catalog) {
        this(logger.getDownloadsRoot(), downloader, ingest, catalog, new IngestBrokerClient(System.getenv()));
    }

    /** @param root isolated canonical root @param downloader actual execution registry @param ingest actual page registry @param catalog strict catalog @param broker explicit isolated broker transport */
    ScopedContentCleanup(Path root, DownloaderService downloader, LibraryIngestService ingest, RavenBrokerClient catalog, IngestBrokerClient broker) {
        this.downloader = downloader; this.ingest = ingest; this.catalog = catalog; this.broker = broker;
        if (root == null) throw new IllegalStateException("Managed storage root is unavailable.");
        downloads = root.toAbsolutePath().normalize();
        if (!Files.isDirectory(downloads) || Files.isSymbolicLink(downloads)) throw new IllegalStateException("Managed storage must be an existing nonsymlink directory.");
        try { ContentMaintenance.restore(downloads); } catch (IOException failure) { throw new IllegalStateException("Scoped maintenance fences could not be restored safely.", failure); }
    }

    /** @param request exact cancelled-run/plan selection @return reviewable scoped paths and an immutable filesystem digest @throws Exception when ownership or source scope is uncertain */
    public synchronized Map<String, Object> preview(Map<String, Object> request) throws Exception {
        JsonNode scope = broker.json("POST", "/content-reset/preview", request, null);
        CleanupInventoryJournal journal = new CleanupInventoryJournal(downloads, scope.path("operationId").asText()); Map<String, Object> reviewed = journal.reviewedPreview();
        if (reviewed == null) reviewed = journal.saveOrLoad(describe(scope));
        if (!scope.path("scopeDigest").asText().equals(reviewed.get("scopeDigest"))) throw new IOException("Reviewed cleanup selection changed.");
        @SuppressWarnings("unchecked") List<String> keys = (List<String>) reviewed.get("maintenanceKeys");
        reviewed.remove("inventory"); reviewed.put("activity", activity(scope, keys)); return reviewed;
    }

    /**
     * Fence writers, revalidate exact scope, delete only approved paths, and checkpoint empty catalog content.
     * Any failure retains the fence so restart cannot resurrect partially removed content.
     * @param request exact reviewed operation and both scope digests
     * @return acknowledged filesystem and catalog result
     * @throws Exception when any guard or checkpoint fails
     */
    public synchronized Map<String, Object> apply(Map<String, Object> request) throws Exception {
        JsonNode scope = broker.json("POST", "/content-reset/preview", request, null);
        String operation = scope.path("operationId").asText(), scopeDigest = scope.path("scopeDigest").asText();
        if (!scopeDigest.equals(request.get("scopeDigest"))) throw new IOException("Reviewed cleanup scope changed.");
        CleanupInventoryJournal journal = new CleanupInventoryJournal(downloads, operation); Map<String, Object> preview = journal.saveOrLoad(request);
        Map<String, Object> completed = journal.completedResult();
        if (completed != null) { broker.json("POST", "/content-reset/finish", Map.of("operationId", operation, "scopeDigest", scopeDigest), null); ContentMaintenance.release(downloads, operation); return completed; }
        Map<String, Object> observed = describe(scope);
        @SuppressWarnings("unchecked") List<String> reviewedRoots = (List<String>) preview.get("paths");
        @SuppressWarnings("unchecked") List<String> observedRoots = (List<String>) observed.get("paths");
        for (String value : observedRoots) if (reviewedRoots.stream().noneMatch(prior -> Path.of(value).startsWith(Path.of(prior)))) throw new IOException("A new unreviewed content root appeared.");
        @SuppressWarnings("unchecked") List<String> keys = (List<String>) preview.get("maintenanceKeys");
        ContentMaintenance.block(downloads, operation, keys);
        broker.json("POST", "/content-reset/begin", Map.of("operationId", operation, "scopeDigest", scopeDigest), null);
        Map<String, Object> activity = activity(scope, keys);
        if (!Boolean.TRUE.equals(activity.get("quiescent"))) throw new IOException("Selected content still has actual workers or media subprocesses; maintenance remains fenced.");
        journal.verifyRemaining();
        @SuppressWarnings("unchecked") List<String> roots = (List<String>) preview.get("paths");
        for (String value : roots) {
            Path root = checked(Path.of(value));
            if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) continue;
            try (var files = Files.walk(root)) { for (Path file : files.sorted(Comparator.reverseOrder()).toList()) { checked(file); Files.deleteIfExists(file); } }
        }
        int remaining = 0; for (String value : roots) if (Files.exists(Path.of(value), LinkOption.NOFOLLOW_LINKS)) remaining++;
        if (remaining != 0) throw new IOException("Scoped content removal was incomplete; maintenance remains fenced.");
        List<String> titleIds = strings(scope.path("titleIds"));
        Map<String, Object> proof = Map.of("operationId", operation, "scopeDigest", scopeDigest, "quiescent", true, "removedTitleIds", titleIds,
            "filesystemScopeDigest", preview.get("filesystemScopeDigest"), "removedPathCount", roots.size(), "remainingScopedPathCount", 0);
        JsonNode result = broker.json("POST", "/content-reset/apply", Map.of("operationId", operation, "scopeDigest", scopeDigest, "filesystemProof", proof), null);
        Map<String, Object> completedResult = Map.of("operationId", operation, "filesystemProof", proof, "catalog", result, "historyPreserved", true);
        journal.markComplete(completedResult);
        broker.json("POST", "/content-reset/finish", Map.of("operationId", operation, "scopeDigest", scopeDigest), null);
        ContentMaintenance.release(downloads, operation);
        return completedResult;
    }

    /** @param scope durable broker-owned plan selection @return exact filesystem scope and actual-writer diagnostics @throws Exception when ownership is uncertain */
    private Map<String, Object> describe(JsonNode scope) throws Exception {
        if (scope == null || !scope.path("planIds").isArray() || scope.path("planIds").isEmpty() || !scope.path("titleIds").isArray()
            || !scope.path("plans").isArray() || scope.path("plans").size() != scope.path("planIds").size()) throw new IOException("Durable selected cleanup plans are incomplete.");
        Set<Path> roots = new LinkedHashSet<>(); List<String> keys = new ArrayList<>(); Set<String> ids = Set.copyOf(strings(scope.path("titleIds")));
        for (JsonNode plan : scope.path("plans")) {
            String task = plan.path("downloadTaskId").asText(), type = LibraryNaming.normalizeTypeSlug(plan.path("requestType").asText()), name = LibraryNaming.sanitizeTitleFolder(plan.path("titleName").asText());
            if (task.isBlank() || name.isBlank() || type.isBlank()) throw new IOException("Selected plan identity is incomplete.");
            keys.add("task:" + task); keys.add("logical:" + type + ":" + name);
            roots.add(checked(downloads.resolve("downloading").resolve(type).resolve(name))); roots.add(checked(downloads.resolve("downloaded").resolve(type).resolve(name)));
        }
        for (String id : ids) { if (!id.matches("[A-Za-z0-9_-]{1,180}")) throw new IOException("Invalid scoped catalog identity."); keys.add("title:" + id); roots.add(checked(downloads.resolve(".ingest-staging").resolve(id))); }
        if (scope.path("fencedTitleIds").isArray()) for (String id : strings(scope.path("fencedTitleIds"))) keys.add("title:" + id);
        for (JsonNode title : scope.path("titles")) {
            if (!ids.contains(title.path("id").asText())) throw new IOException("Cleanup returned a foreign catalog identity.");
            addRoot(roots, title.path("workingRoot")); addRoot(roots, title.path("downloadRoot"));
            String type = title.path("libraryTypeSlug").asText();
            if (!type.matches("[a-z0-9][a-z0-9_-]{0,80}")) throw new IOException("Scoped catalog type is unavailable.");
            roots.add(checked(downloads.resolve("ingested").resolve(type).resolve(title.path("id").asText())));
            for (JsonNode chapter : title.path("chapters")) { String archive = chapter.path("archivePath").asText(); if (!archive.isBlank()) roots.add(checked(Path.of(archive).getParent())); }
        }
        for (JsonNode task : scope.path("tasks")) { addRoot(roots, task.path("workingRoot")); addRoot(roots, task.path("downloadRoot")); addRoot(roots, task.path("details").path("workingRoot")); addRoot(roots, task.path("details").path("downloadRoot")); }
        Path jobs = downloads.resolve(".ingest-jobs");
        if (Files.isDirectory(jobs)) try (var folders = Files.list(jobs)) {
            for (Path folder : folders.filter(Files::isDirectory).toList()) {
                Path descriptor = folder.resolve("job.json"); if (!Files.isRegularFile(descriptor) || Files.size(descriptor) > 1_048_576) continue;
                JsonNode job = json.readTree(descriptor.toFile()); if (ids.contains(job.path("spec").path("input").path("titleId").asText())) roots.add(checked(folder));
            }
        }
        JsonNode all = catalog.listLibraryTitles(); if (all == null || !all.isArray()) throw new IOException("Unrelated catalog ownership could not be verified.");
        for (JsonNode title : all) {
            if (ids.contains(title.path("id").asText())) continue;
            for (String field : List.of("workingRoot", "downloadRoot")) rejectShared(roots, title.path(field).asText());
            for (JsonNode chapter : title.path("chapters")) rejectShared(roots, chapter.path("archivePath").asText());
        }
        Set<String> selectedTasks = new LinkedHashSet<>(); for (JsonNode plan : scope.path("plans")) selectedTasks.add(plan.path("downloadTaskId").asText());
        JsonNode taskRows = catalog.listDownloadTasks(); if (taskRows == null || !taskRows.isArray()) throw new IOException("Unrelated task ownership could not be verified.");
        for (JsonNode task : taskRows) {
            if (selectedTasks.contains(task.path("taskId").asText()) || !Set.of("queued", "running", "preparing").contains(task.path("status").asText())) continue;
            for (String field : List.of("workingRoot", "downloadRoot")) { rejectShared(roots, task.path(field).asText()); rejectShared(roots, task.path("details").path(field).asText()); }
            String name = LibraryNaming.sanitizeTitleFolder(task.path("titleName").asText()), type = LibraryNaming.normalizeTypeSlug(task.path("requestType").asText());
            if (!name.isBlank() && !type.isBlank()) { rejectShared(roots, downloads.resolve("downloaded").resolve(type).resolve(name).toString()); rejectShared(roots, downloads.resolve("downloading").resolve(type).resolve(name).toString()); }
        }
        List<Path> minimal = roots.stream().sorted(Comparator.comparingInt(Path::getNameCount).thenComparing(Path::toString))
            .filter(path -> roots.stream().noneMatch(parent -> !parent.equals(path) && path.startsWith(parent))).toList();
        List<String> paths = minimal.stream().map(Path::toString).sorted().toList(); for (String value : paths) keys.add(ContentMaintenance.pathKey(Path.of(value)));
        keys = keys.stream().distinct().sorted().toList();
        List<Map<String, Object>> inventory = new ArrayList<>();
        for (Path root : minimal) if (Files.exists(root, LinkOption.NOFOLLOW_LINKS)) try (var files = Files.walk(root)) {
            for (Path file : files.sorted().toList()) { checked(file); BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                inventory.add(Map.of("path", file.toString(), "directory", attributes.isDirectory(), "size", attributes.size(), "modified", attributes.lastModifiedTime().toMillis(), "fileKey", String.valueOf(attributes.fileKey()))); }
        }
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(Map.of("scopeDigest", scope.path("scopeDigest").asText(), "paths", paths, "inventory", inventory))));
        Map<String, Object> result = new LinkedHashMap<>(); result.put("operationId", scope.path("operationId").asText()); result.put("scopeDigest", scope.path("scopeDigest").asText());
        result.put("planCount", scope.path("planIds").size()); result.put("titleIds", strings(scope.path("titleIds"))); result.put("paths", paths); result.put("maintenanceKeys", keys);
        result.put("filesystemScopeDigest", digest); result.put("entries", inventory.size()); result.put("inventory", inventory); result.put("activity", activity(scope, keys)); return result;
    }

    /** @param scope selected durable tasks @param keys maintenance keys @return actual execution state rather than mutable task status labels */
    private Map<String, Object> activity(JsonNode scope, List<String> keys) {
        Set<String> tasks = new LinkedHashSet<>(); for (JsonNode plan : scope.path("plans")) tasks.add(plan.path("downloadTaskId").asText());
        Map<String, Object> state = new LinkedHashMap<>(downloader.scopedExecutionActivity(tasks)); int writers = ContentMaintenance.active(keys); long media = MediaProcess.activeCount(), pages = ingest.activePageWork();
        state.put("writerLeases", writers); state.put("mediaProcesses", media); state.put("pageWork", pages);
        state.put("quiescent", state.values().stream().filter(Number.class::isInstance).map(Number.class::cast).allMatch(value -> value.longValue() == 0)); return state;
    }

    /** @param roots selected roots @param field optional persisted root @throws IOException when a root is unsafe */
    private void addRoot(Set<Path> roots, JsonNode field) throws IOException { String value = field.asText(); if (!value.isBlank()) roots.add(checked(Path.of(value))); }

    /** @param roots selected roots @param foreign unrelated persisted path @throws IOException when any selected root would remove unrelated data */
    private void rejectShared(Set<Path> roots, String foreign) throws IOException {
        if (foreign == null || foreign.isBlank()) return; Path path = Path.of(foreign).toAbsolutePath().normalize();
        if (roots.stream().anyMatch(root -> path.startsWith(root) || root.startsWith(path))) throw new IOException("Selected content shares storage with an unrelated catalog title.");
    }

    /** @param path candidate managed path @return resolved safe path without following any symbolic links @throws IOException when root, scope or symlink checks fail */
    private Path checked(Path path) throws IOException {
        if (path == null) throw new IOException("Missing managed path."); Path resolved = path.toAbsolutePath().normalize();
        if (!resolved.startsWith(downloads) || resolved.equals(downloads)) throw new IOException("Cleanup path escapes managed storage.");
        Path relative = downloads.relativize(resolved); String category = relative.getName(0).toString(); int minimum = List.of("downloading", "downloaded", "ingested").contains(category) ? 3 : List.of(".ingest-staging", ".ingest-jobs").contains(category) ? 2 : Integer.MAX_VALUE;
        if (relative.getNameCount() < minimum) throw new IOException("Cleanup path is not a title-owned directory.");
        Path cursor = downloads; for (Path segment : relative) { cursor = cursor.resolve(segment); if (Files.isSymbolicLink(cursor)) throw new IOException("Cleanup never follows symbolic links."); }
        return resolved;
    }

    /** @param array scoped text array @return exact nonblank identities @throws IOException when the array is malformed */
    private static List<String> strings(JsonNode array) throws IOException { List<String> values = new ArrayList<>(); if (!array.isArray()) throw new IOException("Invalid scope identities."); for (JsonNode item : array) { if (!item.isTextual() || item.asText().isBlank()) throw new IOException("Invalid scope identity."); values.add(item.asText()); } return List.copyOf(values); }
}
