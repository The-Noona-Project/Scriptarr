package com.scriptarr.raven.metadata.providers;

import com.scriptarr.raven.metadata.MetadataProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Anime-Planet metadata provider definition.
 */
@Component
public final class AnimePlanetProvider implements MetadataProvider {
    @Override
    public String id() {
        return "animeplanet";
    }

    @Override
    public String name() {
        return "Anime-Planet";
    }

    @Override
    public List<String> scopes() {
        return List.of("manga", "webtoon");
    }
}
