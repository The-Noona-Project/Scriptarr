package com.scriptarr.raven.metadata.providers;

import com.scriptarr.raven.metadata.MetadataProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * MangaUpdates metadata provider definition.
 */
@Component
public final class MangaUpdatesProvider implements MetadataProvider {
    @Override
    public String id() {
        return "mangaupdates";
    }

    @Override
    public String name() {
        return "MangaUpdates";
    }

    @Override
    public List<String> scopes() {
        return List.of("manga", "webtoon");
    }
}
