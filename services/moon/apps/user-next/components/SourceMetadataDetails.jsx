"use client";

/** @file On-demand edition facts and complete grouped tags for a reader title. */
import {useMoonJson} from "../lib/api.js";

/**
 * Show verified provider facts with source fallback and understandable tag categories.
 * @param {{titleId: string, title: any}} props Title identity and compatible catalog fields.
 * @returns {import("react").ReactNode} Title metadata details.
 */
export const SourceMetadataDetails = ({titleId, title}) => {
  const {data, loading, error} = useMoonJson(`/api/moon-v3/user/title/${encodeURIComponent(titleId)}/metadata`, {fallback: null});
  const provider = data?.provider || {};
  const providerNames = {mangadex: "MangaDex", mangaupdates: "MangaUpdates", anilist: "AniList", animeplanet: "Anime-Planet", mal: "MyAnimeList", comicvine: "Comic Vine"};
  const groupNames = {genre: "Genres", theme: "Themes", format: "Format", demographic: "Audience", content: "Content", other: "Additional tags"};
  const source = data?.source || {};
  const groups = data?.tagGroups?.length ? data.tagGroups : [{group: "Tags", tags: title.tags || []}];
  return <section className="moon-title-detail-panel">
    <span className="moon-kicker">Edition and tags</span>
    {loading ? <p>Loading metadata…</p> : null}
    {error ? <p className="moon-muted">Additional metadata is unavailable. Saved tags are shown below.</p> : null}
    <dl>
      <div><dt>Edition</dt><dd>{source.title || title.title} · {provider.year || source.year || title.releaseLabel || "Year unknown"}</dd></div>
      <div><dt>Creators</dt><dd>{[provider.author, ...(provider.artists || [])].filter(Boolean).join(", ") || source.authors?.join(", ") || title.author || "Unknown"}</dd></div>
      <div><dt>Metadata</dt><dd>{data?.decision === "source-backed" ? "From download source" : providerNames[provider.id] || provider.id || title.metadataProvider || "Unverified"}</dd></div>
      <div><dt>Other names</dt><dd>{[...new Set([...(provider.aliases || []), ...(source.aliases || [])])].join(" · ") || "None listed"}</dd></div>
    </dl>
    {groups.map(({group, tags}) => <details key={group} open><summary>{groupNames[group] || group} ({tags.length})</summary><div className="moon-tag-preference-list">{tags.map((tag) => <span className="moon-pill" key={tag}>{tag}</span>)}</div></details>)}
  </section>;
};
