package com.scriptarr.raven.metadata.providers;

import com.scriptarr.raven.metadata.MetadataProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * AniList metadata provider definition.
 * Related files:
 * - com.scriptarr.raven.metadata.MetadataProvider
 * - com.scriptarr.raven.metadata.MetadataService
 * Times this file has been edited: 1
 */
@Component
public final class AniListProvider implements MetadataProvider {
    @Override
    public String id() {
        return "anilist";
    }

    @Override
    public String name() {
        return "AniList";
    }

    @Override
    public List<String> scopes() {
        return List.of("manga");
    }
}
