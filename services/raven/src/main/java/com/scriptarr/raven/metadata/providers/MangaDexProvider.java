package com.scriptarr.raven.metadata.providers;

import com.scriptarr.raven.metadata.MetadataProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * MangaDex metadata provider definition.
 * Related files:
 * - com.scriptarr.raven.metadata.MetadataProvider
 * - com.scriptarr.raven.metadata.MetadataService
 * Times this file has been edited: 1
 */
@Component
public final class MangaDexProvider implements MetadataProvider {
    @Override
    public String id() {
        return "mangadex";
    }

    @Override
    public String name() {
        return "MangaDex";
    }

    @Override
    public List<String> scopes() {
        return List.of("manga", "webtoon");
    }
}
