package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenSettingsService;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Durable title planning, source selection and ownership for bulk download batches. */
public final class BulkQueueCoordinator implements BulkRunGateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() { };
    private final DownloaderService downloader;
    private final DownloadProviderRegistry providers;
    private final LibraryService library;
    private final DownloadIntakeService intake;
    private final RavenBrokerClient broker;
    private final RavenSettingsService settings;
    private final Map<String, Object> runGates = new ConcurrentHashMap<>();
    private final Set<String> cancelledRuns = ConcurrentHashMap.newKeySet();

    /** Assemble the provider, broker and queue boundary. */
    BulkQueueCoordinator(DownloaderService downloader, DownloadProviderRegistry providers, LibraryService library,
        DownloadIntakeService intake, RavenBrokerClient broker, RavenSettingsService settings) {
        this.downloader = downloader;
        this.providers = providers;
        this.library = library;
        this.intake = intake;
        this.broker = broker;
        this.settings = settings;
    }

    @Override
    public CompletableFuture<Void> restoreCompletion() { return downloader.restorationCompletion(); }

    @Override
    public BulkQueueDownloadResult queueBatch(String runId, String batchId, String providerId, String type,
        boolean nsfw, String prefix, String actor, BooleanSupplier cancelled, Consumer<Map<String, Object>> checkpoint) {
        if (!restoreCompletion().isDone() || restoreCompletion().isCompletedExceptionally()) {
            throw new IllegalStateException("Raven download restoration has not completed successfully.");
        }
        if (text(runId).isEmpty() || text(batchId).isEmpty()) throw new IllegalArgumentException("A durable bulk run and batch are required.");
        return queue(runId, batchId, providerId, type, nsfw, prefix, actor,
            cancelled == null ? () -> false : cancelled, checkpoint == null ? value -> { } : checkpoint);
    }

    /** Preserve the direct single-batch API while sharing strict source selection. */
    BulkQueueDownloadResult queueLegacy(String providerId, String type, Boolean nsfw, String prefix, String actor) {
        if (nsfw == null) return invalid(type, false, prefix, "providerId, type, nsfw, and titlePrefix are required.");
        return queue("", "", providerId, type, nsfw, prefix, actor, () -> false, value -> { });
    }

    private BulkQueueDownloadResult queue(String runId, String batchId, String providerId, String type,
        boolean nsfw, String prefix, String actor, BooleanSupplier cancelled, Consumer<Map<String, Object>> checkpoint) {
        String wantedType = BulkTitleSelection.type(type);
        if (!"weebcentral".equals(text(providerId).toLowerCase(Locale.ROOT)) || wantedType == null || text(prefix).isEmpty()) {
            return invalid(type, nsfw, prefix, "A supported WeebCentral type, nsfw flag, and titlePrefix are required.");
        }
        DownloadProvider provider = providers.getById("weebcentral")
            .filter(p -> settings.isDownloadProviderEnabled(p.id())).orElse(null);
        if (provider == null) return invalid(type, nsfw, prefix, "WeebCentral is disabled in Raven settings.");
        boolean durable = !runId.isBlank();
        BooleanSupplier stop = () -> cancelled.getAsBoolean() || cancelledRuns.contains(runId) || Thread.currentThread().isInterrupted();
        checkCancelled(stop);
        Map<String, Map<String, Object>> records = durable ? plans(runId, batchId) : Map.of();
        String discoveryId = "bulk_discovery_" + hash(batchId);
        Map<String, Object> discovery = records.get(discoveryId);
        if (discovery == null && records.containsKey("__legacy_batch")) {
            Map<String, Object> legacy = map(records.get("__legacy_batch").get("result"));
            legacy.put("stage", "legacy-ownership-reconciliation");
            legacy.put("discoveryComplete", false);
            legacy.put("unresolvedPlanIds", List.of("legacy_batch:" + batchId));
            checkpoint.accept(legacy);
            throw new IllegalStateException("Existing bulk task IDs have no durable discovery/ownership plan; reconcile those exact IDs before resuming.");
        }
        List<Map<String, String>> titles;
        int pages;
        if (discovery != null && Boolean.TRUE.equals(map(discovery.get("payload")).get("discoveryComplete"))) {
            Map<String, Object> payload = map(discovery.get("payload"));
            titles = stringMaps(payload.get("titles"));
            pages = number(payload.get("pagesScanned"));
        } else {
            checkpoint.accept(Map.of("stage", "discovering", "discoveryComplete", false, "taskIds", List.of(), "unresolvedPlanIds", List.of()));
            BulkBrowseResult result = provider.browseTitlesAlphabetically(wantedType, nsfw, text(prefix), stop,
                scanned -> checkpoint.accept(Map.of("stage", "discovering", "pagesScanned", scanned, "discoveryComplete", false, "taskIds", List.of(), "unresolvedPlanIds", List.of())));
            checkCancelled(stop);
            Map<String, Map<String, String>> uniqueTitles = new LinkedHashMap<>();
            for (Map<String, String> row : result.titles()) {
                if (row == null || !BulkTitleSelection.matchesPrefix(row.get("title"), prefix)) continue;
                String confirmedType = BulkTitleSelection.type(row.get("type"));
                if (confirmedType != null && !wantedType.equals(confirmedType)) continue;
                Map<String, String> title = new LinkedHashMap<>(row);
                String canonical = BulkTitleSelection.canonicalSeriesUrl(row.get("href"));
                if (canonical != null) title.put("href", canonical);
                uniqueTitles.putIfAbsent(text(title.get("href")), title);
            }
            titles = List.copyOf(uniqueTitles.values());
            pages = result.pagesScanned();
            if (durable) save(runId, discoveryId, "bulk-discovery-plan", batchId, "completed",
                Map.of("titles", titles, "pagesScanned", pages, "discoveryComplete", true), Map.of());
        }
        Summary summary = new Summary(wantedType, nsfw, text(prefix), pages, titles.size());
        List<LibraryTitle> existing = library == null ? List.of() : library.listTitles();
        List<String> unresolved = new ArrayList<>();
        Map<String, Map<String, Object>> knownOwned = new LinkedHashMap<>();
        if (durable && records.values().stream().anyMatch(record -> Set.of("queued", "appended").contains(text(map(record.get("result")).get("category"))))) {
            ownedTasks(runId, batchId).forEach(task -> knownOwned.put(text(task.get("taskId")), task));
        }
        for (Map<String, String> title : titles) {
            checkCancelled(stop);
            String url = text(title.get("href"));
            String name = text(title.get("title"));
            String planId = "bulk_title_" + hash(batchId + "\n" + url);
            String taskId = "task_bulk_" + hash(runId + "\n" + batchId + "\n" + url);
            Map<String, Object> prior = records.get(planId);
            if (prior != null && "cancelled".equals(text(prior.get("status")))) throw new CancellationException("This durable title plan was cancelled.");
            Map<String, Object> priorPayload = prior == null ? Map.of() : map(prior.get("payload"));
            Map<String, Object> outcome = prior == null ? Map.of() : map(prior.get("result"));
            String category = text(outcome.get("category"));
            if (Set.of("queued", "appended").contains(category) && !knownOwned.containsKey(text(outcome.get("downloadTaskId")))) {
                category = "unresolved";
            }
            if (!category.isEmpty() && !"unresolved".equals(category)) {
                summary.add(category, name, text(outcome.get("downloadTaskId")));
                continue;
            }
            Map<String, Object> plan = new LinkedHashMap<>(priorPayload);
            plan.putAll(Map.of("titleName", name, "titleUrl", url, "requestType", wantedType, "requestedBy", text(actor).isBlank() ? "scriptarr-portal" : text(actor), "downloadTaskId", taskId));
            if (durable && prior == null) save(runId, planId, "bulk-title-plan", batchId, "planned", plan, Map.of());
            try {
                if (!BulkTitleSelection.validSeriesUrl(url)) {
                    category = "invalidSource";
                } else if (downloader.bulkTitleAlreadyActive(url, wantedType, durable ? taskId : "")) {
                    category = "active";
                } else {
                    if (!plan.containsKey("request")) {
                        TitleDetails details = provider.getTitleDetails(url);
                        checkCancelled(stop);
                        if (details == null || !wantedType.equals(BulkTitleSelection.type(details.type()))) {
                            throw new IllegalStateException("The provider did not confirm the requested content type.");
                        }
                        if (!nsfw && !Boolean.FALSE.equals(details.adultContent())) {
                            category = "adult";
                        } else {
                            LibraryTitle catalog = existingTitle(existing, url, name, wantedType);
                            CanonicalSourceOwnership.assertCompatible(catalog, url);
                                Map<String, Object> selectedMetadata = new LinkedHashMap<>();
                                Map<String, Object> selectedDownload = new LinkedHashMap<>();
                                if (catalog != null) {
                                    DownloadIntakeService.BulkMetadataResolution binding = intake.resolveBulkMetadata(provider.id(), url, name, wantedType, details.associatedNames());
                                    if (binding == null || binding.unmatched() || binding.ambiguous() || !BulkMetadataAnchor.matches(name, details.associatedNames(), binding.metadataSnapshot())) {
                                        throw new IllegalStateException("metadata_source_ambiguous: Catalog metadata is not anchored to the original provider title or edition.");
                                    }
                                    selectedMetadata.putAll(binding.metadataSnapshot()); selectedDownload.putAll(binding.downloadSnapshot());
                                }
                                if (catalog != null) {
                                    List<Map<String, String>> source = provider.getChapters(url);
                                    checkCancelled(stop);
                                    if (source == null || source.isEmpty()) throw new IllegalStateException("The provider did not return a verifiable chapter list.");
                                    List<Map<String, String>> missing = missingChapters(catalog, source);
                                    if (missing.isEmpty()) category = "completed".equalsIgnoreCase(text(catalog.status())) ? "completed" : "current";
                                    else {
                                        selectedDownload.put("downloadMode", "append");
                                        selectedDownload.put("appendTitleId", catalog.id());
                                        selectedDownload.put("chapterNumbers", missing.stream().map(c -> chapterNumber(c.get("chapter_number"))).toList());
                                        selectedDownload.put("expectedChapters", missing);
                                    }
                                } else {
                                    DownloadIntakeService.BulkMetadataResolution metadata = intake.resolveBulkMetadata(provider.id(), url, name, wantedType, details.associatedNames());
                                    checkCancelled(stop);
                                    if (metadata == null) throw new IllegalStateException("Metadata discovery returned no verifiable outcome.");
                                    if (metadata.unmatched()) category = "noMetadata";
                                    else if (metadata.ambiguous()) category = "ambiguous";
                                    else {
                                        selectedMetadata.putAll(metadata.metadataSnapshot());
                                        selectedDownload.putAll(metadata.downloadSnapshot());
                                        if (durable) {
                                            List<Map<String, String>> source = provider.getChapters(url);
                                            checkCancelled(stop);
                                            if (source == null || source.isEmpty()) throw new IllegalStateException("The provider did not return a verifiable chapter list.");
                                            selectedDownload.put("expectedChapters", source);
                                        }
                                    }
                                }
                                if (category.isEmpty() || "unresolved".equals(category)) {
                                    selectedDownload.putAll(Map.of("providerId", provider.id(), "providerName", provider.name(), "titleName", name,
                                        "titleUrl", url, "requestType", wantedType, "libraryTypeLabel", wantedType, "libraryTypeSlug", LibraryNaming.normalizeTypeSlug(wantedType)));
                                    selectedDownload.put("sourceAliases", details.associatedNames() == null ? List.of() : details.associatedNames());
                                    if (text(selectedDownload.get("coverUrl")).isEmpty() && text(selectedMetadata.get("coverUrl")).isEmpty()
                                        && text(map(selectedMetadata.get("details")).get("coverUrl")).isEmpty()
                                        && text(map(selectedMetadata.get("details")).get("coverImageUrl")).isEmpty()
                                        && !text(title.get("coverUrl")).isEmpty()) selectedDownload.put("coverUrl", title.get("coverUrl"));
                                    if (details.adultContent() != null) selectedDownload.putAll(Map.of("adultContent", details.adultContent(), "nsfw", details.adultContent()));
                                    plan.put("request", Map.of("selectedMetadata", selectedMetadata, "selectedDownload", selectedDownload));
                                    if (durable) save(runId, planId, "bulk-title-plan", batchId, "prepared", plan, Map.of());
                                    category = "";
                                }
                        }
                    } else category = "";
                    if (category.isEmpty()) {
                        Map<String, Object> request = map(plan.get("request"));
                        DownloadRequest download = new DownloadRequest(name, url, wantedType, text(plan.get("requestedBy")), provider.id(), "",
                            map(request.get("selectedMetadata")), map(request.get("selectedDownload")), "", "normal");
                        Map<String, Object> queued;
                        synchronized (gate(runId)) {
                            checkCancelled(stop);
                            queued = durable ? downloader.queueBulkOwned(taskId, runId, batchId, planId, download) : downloader.queueDownload(download);
                            if (stop.getAsBoolean()) {
                                if (durable) downloader.cancelBulkOwned(text(queued.get("taskId")), runId);
                                throw new CancellationException("Bulk run cancelled while enqueueing a title.");
                            }
                        }
                        taskId = text(queued.get("taskId"));
                        category = "append".equals(text(map(request.get("selectedDownload")).get("downloadMode"))) ? "appended" : "queued";
                    }
                }
                if ("invalidSource".equals(category)) {
                    unresolved.add(planId);
                    if (durable) save(runId, planId, "bulk-title-plan", batchId, "failed", plan,
                        Map.of("category", "unresolved", "failureKind", "invalidSource", "error", "Rejected source origin or series path.", "downloadTaskId", taskId));
                } else if (durable) save(runId, planId, "bulk-title-plan", batchId, "queued".equals(category) || "appended".equals(category) ? "queued" : "completed",
                    plan, Map.of("category", category, "downloadTaskId", category.equals("queued") || category.equals("appended") ? taskId : ""));
                summary.add(category, name, taskId);
            } catch (CancellationException error) { throw error;
            } catch (Exception error) {
                if (Thread.currentThread().isInterrupted()) throw new CancellationException("Bulk discovery interrupted.");
                unresolved.add(planId);
                summary.add("failed", name, "");
                if (durable) save(runId, planId, "bulk-title-plan", batchId, "failed", plan,
                    Map.of("category", "unresolved", "error", safeError(error), "downloadTaskId", taskId));
            }
            checkpoint.accept(summary.checkpoint(unresolved));
        }
        checkpoint.accept(summary.checkpoint(unresolved));
        return summary.result(null, null);
    }

    @Override
    public List<Map<String, Object>> ownedTasks(String runId, String batchId) {
        try {
            Map<String, Map<String, Object>> rows = new LinkedHashMap<>();
            JsonNode payload = broker.listDownloadTasks();
            if (payload == null || !payload.isArray()) throw new IllegalStateException("Invalid durable task snapshot.");
            payload.forEach(node -> {Map<String, Object> task = JSON.convertValue(node, MAP); if (owned(task, runId, batchId)) rows.put(text(task.get("taskId")), task);});
            downloader.bulkTaskSnapshots().stream().filter(task -> owned(task, runId, batchId)).forEach(live -> {
                String id = text(live.get("taskId"));
                Map<String, Object> durable = rows.get(id);
                if (durable == null) return;
                Map<String, Object> merged = new LinkedHashMap<>(durable);
                if ("running".equals(text(durable.get("status"))) && "running".equals(text(live.get("status")))) {
                    for (String key : List.of("actualProgressAt", "stage", "ingestCompletedPages", "ingestTotalPages", "ingestCompletedChapters", "ingestTotalChapters", "ingestCompletedSegments", "ingestTotalSegments")) {
                        if (live.containsKey(key)) merged.put(key, live.get(key));
                    }
                }
                if (!"completed".equals(text(durable.get("status"))) && live.containsKey("persistenceError")) merged.put("persistenceError", live.get("persistenceError"));
                rows.put(id, merged);
            });
            return List.copyOf(rows.values());
        } catch (Exception error) {throw new IllegalStateException("Could not load durable bulk-owned title tasks.", error);}
    }

    @Override
    public void cancelRun(String runId) {
        cancelledRuns.add(runId);
        synchronized (gate(runId)) {
            downloader.bulkTaskSnapshots().stream().filter(task -> owned(task, runId, ""))
                .forEach(task -> downloader.cancelBulkOwned(text(task.get("taskId")), runId));
            for (Map<String, Object> task : ownedTasks(runId, "")) downloader.cancelBulkOwned(text(task.get("taskId")), runId);
            for (Map.Entry<String, Map<String, Object>> entry : plans(runId, "").entrySet()) {
                Map<String, Object> payload = map(entry.getValue().get("payload"));
                if (!"bulk-title-plan".equals(text(payload.get("kind")))) continue;
                if (Set.of("planned", "prepared", "failed").contains(text(entry.getValue().get("status")))) {
                    save(runId, entry.getKey(), "bulk-title-plan", text(payload.get("batchId")), "cancelled", payload, map(entry.getValue().get("result")));
                }
            }
        }
    }

    /** Check the immediate cancellation marker without acquiring the enqueue gate. */
    boolean isRunCancelled(String runId) { return cancelledRuns.contains(runId); }

    private Object gate(String runId) { return runGates.computeIfAbsent(runId, key -> new Object()); }

    private Map<String, Map<String, Object>> plans(String runId, String batchId) {
        try {
            JsonNode payload = broker.listJobTasks(runId, "");
            if (payload == null || !payload.isArray()) throw new IllegalStateException("Invalid durable bulk plan snapshot.");
            Map<String, Map<String, Object>> result = new LinkedHashMap<>();
            payload.forEach(node -> {Map<String, Object> record = JSON.convertValue(node, MAP); Map<String, Object> detail = map(record.get("payload"));
                if (batchId.equals(text(record.get("taskId"))) && map(record.get("result")).get("taskIds") instanceof List<?> ids && !ids.isEmpty()) result.put("__legacy_batch", record);
                if (Set.of("bulk-title-plan", "bulk-discovery-plan").contains(text(detail.get("kind")))
                    && (batchId.isEmpty() || batchId.equals(text(detail.get("batchId"))))) result.put(text(record.get("taskId")), record);});
            return result;
        } catch (Exception error) {throw new IllegalStateException("Could not load durable bulk title plans.", error);}
    }

    private void save(String runId, String id, String kind, String batchId, String status, Map<String, Object> values, Map<String, Object> result) {
        Map<String, Object> payload = new LinkedHashMap<>(values);
        payload.putAll(Map.of("kind", kind, "batchId", batchId, "runId", runId));
        try {
            broker.putJobTask(runId, id, Map.of("taskId", id, "jobId", runId, "status", status, "label", text(values.get("titleName")),
                "percent", "completed".equals(status) ? 100 : 0, "payload", payload, "result", result, "updatedAt", Instant.now().toString()));
        } catch (Exception error) {throw new IllegalStateException("Could not persist the durable bulk plan; work was not accepted safely.", error);}
    }

    private boolean owned(Map<String, Object> task, String runId, String batchId) {
        Map<String, Object> details = map(task.get("details"));
        return runId.equals(text(details.get("bulkRunId"))) && (batchId.isEmpty() || batchId.equals(text(details.get("bulkBatchId"))));
    }

    private LibraryTitle existingTitle(List<LibraryTitle> titles, String url, String name, String type) {
        return titles.stream().filter(t -> t != null && (url.equals(text(t.sourceUrl()))
            || (name.equalsIgnoreCase(text(t.title())) && LibraryNaming.normalizeTypeSlug(type).equals(t.libraryTypeSlug())))).findFirst().orElse(null);
    }

    private List<Map<String, String>> missingChapters(LibraryTitle title, List<Map<String, String>> source) {
        return source.stream().filter(row -> title.chapters() == null || title.chapters().stream().noneMatch(chapter ->
            chapterNumber(chapter.chapterNumber()).equals(chapterNumber(row.get("chapter_number"))) && downloader.bulkChapterHealthy(chapter)))
            .<Map<String, String>>map(LinkedHashMap::new).toList();
    }

    private BulkQueueDownloadResult invalid(String type, boolean nsfw, String prefix, String message) {
        return new Summary(text(type), nsfw, text(prefix), 0, 0).result(BulkQueueDownloadResult.STATUS_INVALID_REQUEST, message);
    }

    private static void checkCancelled(BooleanSupplier cancelled) {if (cancelled.getAsBoolean()) throw new CancellationException("Bulk discovery cancelled.");}
    private static String text(Object value) {return value == null ? "" : String.valueOf(value).trim();}
    private static int number(Object value) {try{return Integer.parseInt(text(value));}catch(Exception error){return 0;}}
    private static String chapterNumber(Object value) {return text(value).replaceAll("(?i)^chapter\\s*", "").replaceAll("\\.0+$", "");}
    private static String safeError(Exception error) {return error instanceof BulkDiscoveryException ? error.getMessage() : text(error.getMessage()).replaceAll("(?i)(token|password|secret)=[^\\s]+", "$1=[REDACTED]");}
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {return value instanceof Map<?, ?> ? new LinkedHashMap<>((Map<String, Object>) value) : new LinkedHashMap<>();}
    private static List<Map<String, String>> stringMaps(Object value) {if (!(value instanceof List<?> rows)) return List.of();return rows.stream().map(row -> {Map<String, String> result = new LinkedHashMap<>();map(row).forEach((k,v)->result.put(k,text(v)));return result;}).toList();}
    private static String hash(String value) {try{return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))).substring(0,32);}catch(Exception error){throw new IllegalStateException(error);}}

    private static final class Summary {
        private final BulkQueueDownloadResult.Filters filters;
        private final int pages;
        private final int matched;
        private final Map<String, List<String>> groups = new LinkedHashMap<>();
        private final List<String> ids = new ArrayList<>();

        private Summary(String type, boolean nsfw, String prefix, int pages, int matched) {
            this.filters = new BulkQueueDownloadResult.Filters(type, nsfw, prefix);
            this.pages = pages;
            this.matched = matched;
            for (String key : List.of("queued","active","adult","noMetadata","ambiguous","completed","current","appended","invalidSource","failed")) groups.put(key,new ArrayList<>());
        }

        private void add(String category, String title, String id) {
            String key = "appended".equals(category) ? "appended" : category;
            if (groups.containsKey(key)) groups.get(key).add(title);
            if ("queued".equals(category) || "appended".equals(category)) {
                if ("appended".equals(category)) groups.get("queued").add(title);
                if (!id.isBlank() && !ids.contains(id)) ids.add(id);
            }
        }

        private List<String> list(String key) {return List.copyOf(groups.get(key));}
        private int size(String key) {return groups.get(key).size();}
        private Map<String, Object> checkpoint(List<String> unresolved) {
            Map<String, Object> result = JSON.convertValue(result(null,null), MAP);
            result.put("taskIds",List.copyOf(ids));result.put("discoveryComplete",true);result.put("unresolvedPlanIds",List.copyOf(unresolved));
            result.put("stage",unresolved.isEmpty()?"waiting-for-titles":"planning-incomplete");result.put("lastActualProgressAt",Instant.now().toString());
            return result;
        }

        private BulkQueueDownloadResult result(String forcedStatus, String forcedMessage) {
            String status = forcedStatus != null ? forcedStatus : matched == 0 ? BulkQueueDownloadResult.STATUS_EMPTY_RESULTS
                : size("failed") > 0 || size("adult") > 0 || size("noMetadata") > 0 || size("ambiguous") > 0 || size("invalidSource") > 0 ? BulkQueueDownloadResult.STATUS_PARTIAL
                : size("queued") > 0 ? BulkQueueDownloadResult.STATUS_QUEUED : BulkQueueDownloadResult.STATUS_ALREADY_ACTIVE;
            String message=forcedMessage!=null?forcedMessage:"Queued "+size("queued")+" title(s); "+size("failed")+" unresolved title plan(s).";
            return new BulkQueueDownloadResult(status,message,filters,pages,matched,size("queued"),size("active"),size("adult"),size("noMetadata"),size("ambiguous"),size("completed"),size("current"),size("appended"),size("invalidSource"),size("failed"),
                List.copyOf(ids),list("queued"),list("active"),list("adult"),list("noMetadata"),list("ambiguous"),list("completed"),list("current"),list("appended"),list("invalidSource"),list("failed"));
        }
    }
}
