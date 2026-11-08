package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenBrokerClient;

import java.io.IOException;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Small scan-local identity indexes; canonical folders survive display-title metadata changes. */
final class ScanCatalogOwnership {
    private static final int MAX_DIAGNOSTICS = 100;
    private final Map<Path, Set<String>> ownersByRoot = new LinkedHashMap<>();
    private final Map<String, String> legacyOwners = new LinkedHashMap<>();
    private final Set<String> canonicalIds = new LinkedHashSet<>();
    private final List<Map<String, Object>> diagnostics = new ArrayList<>();
    private int failedFolders;
    private int ambiguousRootCount;
    private int scanErrorCount;

    /** Construct only through a completely acknowledged catalog load. */
    private ScanCatalogOwnership() { }

    /**
     * Read one strict raw census, retaining only identity fields and never parsing chapter DTOs.
     * Raw rows preserve distinct same-name owners which display-oriented card projections deduplicate.
     * @param broker existing Sage-backed catalog client
     * @return complete scan-local indexes with no retained chapter payloads
     * @throws IOException when the complete raw census or any canonical identity cannot be verified
     */
    static ScanCatalogOwnership load(RavenBrokerClient broker) throws IOException {
        try {
            ScanCatalogOwnership ownership = new ScanCatalogOwnership();
            JsonNode census = broker.listLibraryTitles();
            if (census == null || !census.isArray()) throw new IOException("Catalog ownership census is malformed.");
            for (JsonNode row : census) {
                String id = identity(row);
                if (row.has("error") || !row.has("downloadRoot") || !row.path("chapters").isArray()) {
                    throw new IOException("Catalog ownership row is incomplete.");
                }
                String title = text(row, "title");
                String type = first(text(row, "libraryTypeSlug"), text(row, "mediaType"));
                if (title.isBlank() || type.isBlank()) throw new IOException("Catalog ownership labels are incomplete.");
                if (!ownership.canonicalIds.add(id)) throw new IOException("Catalog ownership repeated a canonical title.");
                String storedRoot = text(row, "downloadRoot");
                if (!storedRoot.isBlank()) ownership.addRoot(normalizeRoot(storedRoot), id);
                ownership.legacyOwners.putIfAbsent(legacyKey(type, title), id);
            }
            return ownership;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Catalog ownership loading was interrupted.", interrupted);
        } catch (IOException unavailable) {
            throw new IOException("Could not load complete catalog ownership.", unavailable);
        } catch (RuntimeException malformed) {
            throw new IOException("Could not verify catalog ownership.", malformed);
        }
    }

    /**
     * Prefer one durable normalized folder owner before the compatible title/type fallback.
     * @param folder absolute scanned folder
     * @param typeSlug scanned library type
     * @param titleName label derived from the folder
     * @return canonical title id, or null when the folder is genuinely new
     * @throws IOException when the root is invalid or has more than one canonical owner
     */
    String resolve(Path folder, String typeSlug, String titleName) throws IOException {
        Path root = normalizeRoot(folder);
        Set<String> owners = ownersByRoot.get(root);
        if (owners != null && owners.size() > 1) throw new AmbiguousOwnership(root, owners);
        return owners == null || owners.isEmpty() ? legacyOwners.get(legacyKey(typeSlug, titleName)) : owners.iterator().next();
    }

    /**
     * Revalidate root-selected ownership against the exact title reloaded under its writer lock.
     * Legacy name/type fallback without a known owner for this root keeps its existing behavior.
     * @param folder scanned absolute folder
     * @param canonicalId exact freshly reloaded canonical id
     * @param currentRoot freshly acknowledged stored root, nullable for legacy rows
     * @throws IOException when a root-selected identity moved or lost its durable root
     */
    void assertReloadMatches(Path folder, String canonicalId, String currentRoot) throws IOException {
        Path root = normalizeRoot(folder);
        Set<String> owners = ownersByRoot.get(root);
        if (owners == null || owners.isEmpty()) return;
        if (owners.size() > 1) throw new AmbiguousOwnership(root, owners);
        if (!owners.contains(canonicalId) || currentRoot == null || currentRoot.isBlank()
            || !root.equals(normalizeRoot(currentRoot))) throw new IOException("Canonical folder ownership changed during the scan.");
    }

    /**
     * Remember the actual canonical id acknowledged for a successfully indexed folder.
     * @param folder absolute scanned folder
     * @param typeSlug scanned type
     * @param titleName scanned display label
     * @param canonicalId broker-acknowledged canonical title identity
     * @throws IOException when registration would conceal a conflicting folder owner
     */
    void register(Path folder, String typeSlug, String titleName, String canonicalId) throws IOException {
        Path root = normalizeRoot(folder);
        if (canonicalId == null || canonicalId.isBlank() || canonicalId.length() > 512
            || canonicalId.chars().anyMatch(Character::isISOControl)) throw new IOException("Invalid canonical scan identity.");
        Set<String> existing = ownersByRoot.get(root);
        if (existing != null && (!existing.contains(canonicalId) || existing.size() > 1)) {
            Set<String> conflicting = new LinkedHashSet<>(existing);
            conflicting.add(canonicalId);
            throw new AmbiguousOwnership(root, conflicting);
        }
        canonicalIds.add(canonicalId);
        addRoot(root, canonicalId);
        legacyOwners.putIfAbsent(legacyKey(typeSlug, titleName), canonicalId);
    }

    /**
     * Record bounded operator evidence without copying broker exceptions or chapter bodies.
     * @param folder failed scanned folder
     * @param error failure observed by the scan
     */
    void recordFailure(Path folder, Exception error) {
        failedFolders++;
        Map<String, Object> diagnostic;
        if (error instanceof AmbiguousOwnership ambiguous) {
            ambiguousRootCount++;
            diagnostic = Map.of("code", "ambiguous_download_root", "root", ambiguous.root(),
                "ownerIds", ambiguous.ownerIds(), "ownerCount", ambiguous.ownerCount(),
                "message", "Canonical archive folder has multiple catalog owners; no owner was selected.");
        } else {
            scanErrorCount++;
            String root;
            try { root = normalizeRoot(folder).toString(); } catch (IOException invalid) { root = ""; }
            diagnostic = Map.of("code", "scan_folder_failed", "root", root,
                "message", "The folder could not be safely indexed; retry the library scan after review.");
        }
        if (diagnostics.size() < MAX_DIAGNOSTICS) diagnostics.add(diagnostic);
    }

    /** @return immutable compact scan counters and bounded recovery diagnostics */
    Map<String, Object> result() {
        return Map.of("titles", canonicalIds.size(), "failedFolders", failedFolders,
            "ambiguousRootCount", ambiguousRootCount, "scanErrorCount", scanErrorCount,
            "recoveryRequired", hasFailures(), "diagnostics", List.copyOf(diagnostics),
            "diagnosticsTruncated", Math.max(0, failedFolders - diagnostics.size()),
            "recoveryAction", ambiguousRootCount > 0 ? "review-catalog-ownership" : scanErrorCount > 0 ? "retry-library-rescan" : "");
    }

    /** @return whether at least one folder requires operator recovery */
    boolean hasFailures() { return failedFolders > 0; }

    /** @param root normalized root @param id canonical owner */
    private void addRoot(Path root, String id) { ownersByRoot.computeIfAbsent(root, ignored -> new LinkedHashSet<>()).add(id); }

    /** @param type type label or slug @param title current display title @return compatible legacy lookup key */
    private static String legacyKey(String type, String title) {
        return LibraryNaming.normalizeTypeSlug(type) + ":" + LibraryNaming.slugifySegment(title);
    }

    /** @param values nullable labels @return first nonblank label or empty */
    private static String first(String... values) {
        for (String value : values) if (value != null && !value.isBlank()) return value;
        return "";
    }

    /** @param row raw card or detail @return verified canonical identity @throws IOException for malformed identity */
    private static String identity(JsonNode row) throws IOException {
        String value = text(row, "id");
        if (value.isBlank() || value.length() > 512 || value.chars().anyMatch(Character::isISOControl)) throw new IOException("Missing canonical scan identity.");
        return value;
    }

    /** @param row raw JSON object @param key identity field @return text or empty @throws IOException for malformed fields */
    private static String text(JsonNode row, String key) throws IOException {
        if (row == null || !row.isObject()) throw new IOException("Malformed catalog identity object.");
        JsonNode value = row.get(key);
        if (value == null || value.isNull()) return "";
        if (!value.isTextual() || value.textValue().length() > 8192) throw new IOException("Malformed catalog identity field.");
        return value.textValue();
    }

    /** @param raw stored absolute root @return normalized root @throws IOException for unsafe roots */
    private static Path normalizeRoot(String raw) throws IOException {
        if (raw.chars().anyMatch(Character::isISOControl)) throw new IOException("Invalid catalog root.");
        try { return normalizeRoot(Path.of(raw)); } catch (InvalidPathException invalid) { throw new IOException("Invalid catalog root.", invalid); }
    }

    /** @param root absolute catalog or scanned root @return lexical normalized root @throws IOException for invalid roots */
    private static Path normalizeRoot(Path root) throws IOException {
        if (root == null || !root.isAbsolute() || root.toString().length() > 8192
            || root.toString().chars().anyMatch(Character::isISOControl)) throw new IOException("Catalog root must be a valid absolute path.");
        return root.toAbsolutePath().normalize();
    }

    /** A shared canonical folder requires explicit reconciliation, never arbitrary owner selection. */
    static final class AmbiguousOwnership extends IOException {
        private static final long serialVersionUID = 1L;
        private final String root;
        private final List<String> ownerIds;
        private final int ownerCount;

        /** @param path normalized conflicting root @param owners distinct known or attempted canonical owners */
        private AmbiguousOwnership(Path path, Collection<String> owners) {
            super("Canonical archive folder has multiple catalog owners.");
            root = path.toString();
            TreeSet<String> sorted = new TreeSet<>(owners);
            ownerCount = sorted.size();
            ownerIds = sorted.stream().limit(20).toList();
        }

        /** @return normalized root whose content was left untouched */
        String root() { return root; }
        /** @return bounded sorted canonical identities for the operator */
        List<String> ownerIds() { return ownerIds; }
        /** @return actual distinct owner count even when the displayed list is bounded */
        int ownerCount() { return ownerCount; }
    }
}
