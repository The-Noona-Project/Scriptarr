package com.scriptarr.raven.metadata.providers;

import com.scriptarr.raven.metadata.MetadataProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * MyAnimeList metadata provider definition.
 */
@Component
public final class MalProvider implements MetadataProvider {
    @Override
    public String id() {
        return "mal";
    }

    @Override
    public String name() {
        return "MyAnimeList";
    }

    @Override
    public List<String> scopes() {
        return List.of("manga");
    }
}
