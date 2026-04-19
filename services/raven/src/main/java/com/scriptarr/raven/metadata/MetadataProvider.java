package com.scriptarr.raven.metadata;

import java.util.List;
import java.util.Map;

/**
 * Metadata provider contract for Raven 3.0.
 * Related files:
 * - com.scriptarr.raven.metadata.MetadataService
 * - com.scriptarr.raven.metadata.providers.AniListProvider
 * Times this file has been edited: 1
 */
public interface MetadataProvider {
    String id();

    String name();

    List<String> scopes();

    default Map<String, Object> describe() {
        return Map.of(
            "id", id(),
            "name", name(),
            "scopes", scopes()
        );
    }
}
