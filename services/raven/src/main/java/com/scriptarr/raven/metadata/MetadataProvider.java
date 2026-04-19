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
    /**
     * Resolve the stable provider identifier used in Raven settings and API payloads.
     *
     * @return provider id such as {@code mangadex}
     */
    String id();

    /**
     * Resolve the display name shown in Moon admin surfaces.
     *
     * @return human-readable provider name
     */
    String name();

    /**
     * Describe the media scopes the provider can identify.
     *
     * @return supported metadata scopes
     */
    List<String> scopes();

    /**
     * Convert the provider metadata into the normalized API payload shape.
     *
     * @return provider description map
     */
    default Map<String, Object> describe() {
        return Map.of(
            "id", id(),
            "name", name(),
            "scopes", scopes()
        );
    }
}
