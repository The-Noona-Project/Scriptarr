"use client";

/**
 * @file Tabbed profile hub for Moon's Next user shell.
 */

import {useState} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, ErrorView, LoadingView} from "../StateView.jsx";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {buildLibraryPath, canAccessAdmin} from "../../lib/navigationRoutes.js";
import {buildTitlePath} from "../../lib/titleRoutes.js";
import {buildAvatarProps} from "../../lib/profile.js";
import {Avatar, Button, Column, Flex} from "../UiPrimitives.jsx";

const StylePanel = dynamic(() => import("../OnceStylePanel.jsx"), {
  ssr: false,
  loading: () => <div className="moon-reader-empty">Loading presentation controls.</div>
});

const PROFILE_TABS = Object.freeze([
  {id: "overview", label: "Overview"},
  {id: "stats", label: "Stats"},
  {id: "preferences", label: "Preferences"},
  {id: "api", label: "API Keys"}
]);

const emptyProfile = Object.freeze({
  user: null,
  stats: {
    bookshelfCount: 0,
    inProgressCount: 0,
    completedCount: 0,
    followingCount: 0,
    requestCounts: {total: 0, active: 0, completed: 0, closed: 0},
    likedTagCount: 0,
    dislikedTagCount: 0
  },
  overview: {
    bookshelfPreview: [],
    requestPreview: [],
    followingPreview: []
  },
  statsPanels: {
    inProgressTitles: [],
    completedTitles: [],
    followingTitles: [],
    recentActivity: []
  },
  adminCapable: false,
  tagPreferences: {likedTags: [], dislikedTags: []}
});

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const formatDateTime = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "Not available";
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? normalized : parsed.toLocaleString();
};

const renderTitlePreview = (title, actionLabel = "Open title") => {
  const titleId = normalizeString(title?.titleId);
  const typeSlug = normalizeString(title?.libraryTypeSlug, "manga");
  const href = titleId ? buildTitlePath(typeSlug, titleId) : buildLibraryPath(typeSlug);

  return (
    <article key={`${typeSlug}:${titleId || title?.title}`} className="moon-list-row moon-profile-preview-row">
      <div>
        <strong>{normalizeString(title?.title, "Untitled")}</strong>
        <div className="moon-list-meta">
          {normalizeString(title?.chapterLabel || title?.latestChapter, normalizeString(title?.libraryTypeLabel, "Manga"))}
        </div>
      </div>
      <Link className="moon-profile-inline-link" href={href}>{actionLabel}</Link>
    </article>
  );
};

const renderRequestPreview = (request) => (
  <article key={normalizeString(request?.id, request?.title)} className="moon-list-row moon-profile-preview-row">
    <div>
      <strong>{normalizeString(request?.title, "Untitled request")}</strong>
      <div className="moon-list-meta">
        {normalizeString(request?.status, "updated")} - {formatDateTime(request?.updatedAt || request?.createdAt)}
      </div>
    </div>
    <Link className="moon-profile-inline-link" href="/myrequests">Open requests</Link>
  </article>
);

const renderActivityEntry = (entry) => (
  <article key={normalizeString(entry?.id, `${entry?.kind}:${entry?.title}`)} className="moon-list-row moon-profile-preview-row">
    <div>
      <strong>{normalizeString(entry?.title, "Untitled")}</strong>
      <div className="moon-list-meta">
        {normalizeString(entry?.label, normalizeString(entry?.kind, "updated"))} - {formatDateTime(entry?.at)}
      </div>
    </div>
    {entry?.titleId ? (
      <Link
        className="moon-profile-inline-link"
        href={buildTitlePath(normalizeString(entry?.libraryTypeSlug || entry?.typeLabel, "manga"), normalizeString(entry?.titleId))}
      >
        Open
      </Link>
    ) : (
      <Link className="moon-profile-inline-link" href="/myrequests">Open</Link>
    )}
  </article>
);

/**
 * Render Moon's profile hub.
 *
 * @returns {import("react").ReactNode}
 */
export const ProfilePageClient = () => {
  const {auth, installAvailable, loginUrl, promptInstall} = useMoonChrome();
  const [activeTab, setActiveTab] = useState("overview");
  const [installPending, setInstallPending] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiFlash, setApiFlash] = useState("");
  const [apiBusy, setApiBusy] = useState("");
  const {loading, error, status, data} = useMoonJson(auth ? "/api/moon-v3/user/profile" : null, {
    enabled: Boolean(auth),
    fallback: emptyProfile,
    deps: [auth?.discordUserId || ""]
  });
  const apiKeysState = useMoonJson(auth ? "/api/moon-v3/user/api-keys" : null, {
    enabled: Boolean(auth),
    fallback: {apiKeys: [], canManageApiKeys: false},
    deps: [auth?.discordUserId || ""]
  });

  if (!auth) {
    return (
      <AuthRequiredView
        title="Sign in to manage your Moon profile"
        detail="Profile stats, reading shortcuts, and local presentation controls need a signed-in Moon session."
        loginUrl={loginUrl}
      />
    );
  }

  if (loading) {
    return <LoadingView label="Moon is loading your profile, reading stats, and quick access routes." />;
  }

  if (error) {
    return <ErrorView detail={status ? error : "Moon could not load your profile right now."} />;
  }

  const profile = data || emptyProfile;
  const effectiveUser = profile.user || auth;
  const adminCapable = profile.adminCapable || canAccessAdmin(auth);
  const stats = profile.stats || emptyProfile.stats;
  const overview = profile.overview || emptyProfile.overview;
  const panels = profile.statsPanels || emptyProfile.statsPanels;
  const tagPreferences = profile.tagPreferences || emptyProfile.tagPreferences;
  const tab = PROFILE_TABS.find((entry) => entry.id === activeTab)?.id || "overview";

  const createApiKey = async () => {
    setApiBusy("create");
    setApiFlash("");
    const result = await requestJson("/api/moon-v3/user/api-keys", {
      method: "POST",
      json: {
        name: apiKeyName || "Reader API key"
      }
    });
    setApiBusy("");
    if (!result.ok) {
      setApiFlash(normalizeString(result.payload?.error, "Moon could not create that API key."));
      return;
    }
    setApiSecret(normalizeString(result.payload?.secret));
    setApiKeyName("");
    setApiFlash("API key created.");
    await apiKeysState.refresh();
  };

  const patchApiKey = async (apiKey, patch) => {
    setApiBusy(apiKey.id);
    setApiFlash("");
    const result = await requestJson(`/api/moon-v3/user/api-keys/${encodeURIComponent(apiKey.id)}`, {
      method: "PATCH",
      json: patch
    });
    setApiBusy("");
    if (!result.ok) {
      setApiFlash(normalizeString(result.payload?.error, "Moon could not update that API key."));
      return;
    }
    await apiKeysState.refresh();
  };

  const revokeApiKey = async (apiKey) => {
    setApiBusy(apiKey.id);
    setApiFlash("");
    const result = await requestJson(`/api/moon-v3/user/api-keys/${encodeURIComponent(apiKey.id)}`, {
      method: "DELETE"
    });
    setApiBusy("");
    if (!result.ok) {
      setApiFlash(normalizeString(result.payload?.error, "Moon could not revoke that API key."));
      return;
    }
    setApiFlash("API key revoked.");
    await apiKeysState.refresh();
  };

  const overviewContent = (
    <div className="moon-profile-tab-grid">
      <section className="moon-profile-card">
        <h3>Quick routes</h3>
        <p className="moon-muted">Fast jumps back into the parts of Moon you use most, plus install and admin shortcuts when they make sense.</p>
        <Flex gap="10" wrap>
          <Link className="moon-profile-inline-link" href="/library">Library</Link>
          <Link className="moon-profile-inline-link" href="/myrequests">Requests</Link>
          <Link className="moon-profile-inline-link" href="/following">Following</Link>
          {adminCapable ? <Link className="moon-profile-inline-link" href="/admin">Admin</Link> : null}
          {installAvailable ? (
            <button
              className="moon-profile-inline-link moon-profile-inline-link-button"
              type="button"
              disabled={installPending}
              onClick={async () => {
                setInstallPending(true);
                try {
                  await promptInstall();
                } finally {
                  setInstallPending(false);
                }
              }}
            >
              {installPending ? "Installing..." : "Install app"}
            </button>
          ) : null}
        </Flex>
      </section>
      <section className="moon-profile-card">
        <h3>Pick up where you left off</h3>
        <p className="moon-muted">Your active bookshelf is driven by Moon's read state, so finished titles quietly fall away until new chapters land.</p>
        <div className="moon-list">
          {normalizeArray(overview.bookshelfPreview).length
            ? normalizeArray(overview.bookshelfPreview).map((title) => renderTitlePreview(title, "Continue"))
            : <p className="moon-muted">Your bookshelf is clear right now. Start a title and it will land here automatically.</p>}
        </div>
      </section>
      <section className="moon-profile-card">
        <h3>Recent request activity</h3>
        <p className="moon-muted">Quick request state so you can jump back into moderation outcomes and queued work.</p>
        <div className="moon-list">
          {normalizeArray(overview.requestPreview).length
            ? normalizeArray(overview.requestPreview).map(renderRequestPreview)
            : <p className="moon-muted">You do not have any recent requests yet.</p>}
        </div>
      </section>
      <section className="moon-profile-card">
        <h3>Following</h3>
        <p className="moon-muted">Titles you are actively watching so new chapters do not disappear into the backlog.</p>
        <div className="moon-list">
          {normalizeArray(overview.followingPreview).length
            ? normalizeArray(overview.followingPreview).map((title) => renderTitlePreview(title, "Open follow"))
            : <p className="moon-muted">You are not following any titles yet.</p>}
        </div>
      </section>
    </div>
  );

  const statsContent = (
    <div className="moon-profile-tab-grid">
      <section className="moon-profile-card moon-profile-metric-card">
        <strong>{stats.bookshelfCount}</strong>
        <span>Bookshelf titles</span>
      </section>
      <section className="moon-profile-card moon-profile-metric-card">
        <strong>{stats.inProgressCount}</strong>
        <span>In progress</span>
      </section>
      <section className="moon-profile-card moon-profile-metric-card">
        <strong>{stats.completedCount}</strong>
        <span>Completed</span>
      </section>
      <section className="moon-profile-card moon-profile-metric-card">
        <strong>{stats.followingCount}</strong>
        <span>Following</span>
      </section>
      <section className="moon-profile-card moon-profile-metric-card">
        <strong>{stats.requestCounts?.active || 0}</strong>
        <span>Active requests</span>
      </section>
      <section className="moon-profile-card moon-profile-metric-card">
        <strong>{stats.likedTagCount}/{stats.dislikedTagCount}</strong>
        <span>Liked / disliked tags</span>
      </section>

      <section className="moon-profile-card">
        <h3>Recent activity</h3>
        <div className="moon-list">
          {normalizeArray(panels.recentActivity).length
            ? normalizeArray(panels.recentActivity).map(renderActivityEntry)
            : <p className="moon-muted">Moon will start filling this in as you read, follow, and request titles.</p>}
        </div>
      </section>
      <section className="moon-profile-card">
        <h3>In progress</h3>
        <div className="moon-list">
          {normalizeArray(panels.inProgressTitles).length
            ? normalizeArray(panels.inProgressTitles).map((title) => renderTitlePreview(title, "Continue"))
            : <p className="moon-muted">No in-progress titles right now.</p>}
        </div>
      </section>
      <section className="moon-profile-card">
        <h3>Completed</h3>
        <div className="moon-list">
          {normalizeArray(panels.completedTitles).length
            ? normalizeArray(panels.completedTitles).map((title) => renderTitlePreview(title, "Reopen"))
            : <p className="moon-muted">Completed titles will show up here once you finish a run.</p>}
        </div>
      </section>
      <section className="moon-profile-card">
        <h3>Taste signals</h3>
        <p className="moon-muted">These feed Moon's tag-driven shelves on the home page.</p>
        <div className="moon-pill-row">
          {normalizeArray(tagPreferences.likedTags).length
            ? normalizeArray(tagPreferences.likedTags).map((tag) => <span key={`like:${tag}`} className="moon-pill">Like: {tag}</span>)
            : <span className="moon-pill">No liked tags yet</span>}
          {normalizeArray(tagPreferences.dislikedTags).length
            ? normalizeArray(tagPreferences.dislikedTags).map((tag) => <span key={`dislike:${tag}`} className="moon-pill">Dislike: {tag}</span>)
            : <span className="moon-pill">No disliked tags yet</span>}
        </div>
      </section>
    </div>
  );

  const preferencesContent = (
    <div className="moon-profile-tab-grid">
      <section className="moon-profile-card">
        <h3>Style panel</h3>
        <p className="moon-muted">
          Adjust Once UI presentation preferences for this browser without affecting the rest of the server.
        </p>
        <StylePanel />
      </section>
      {installAvailable ? (
        <section className="moon-profile-card">
          <h3>Install app</h3>
          <p className="moon-muted">
            Install Moon as a desktop-style app so the reader feels closer to a dedicated library client.
          </p>
          <Button
            variant="secondary"
            size="m"
            disabled={installPending}
            onClick={async () => {
              setInstallPending(true);
              try {
                await promptInstall();
              } finally {
                setInstallPending(false);
              }
            }}
          >
            {installPending ? "Opening installer..." : "Install app"}
          </Button>
        </section>
      ) : null}
      <section className="moon-profile-card">
        <h3>Reading routes</h3>
        <p className="moon-muted">Jump back into the parts of Moon you use most often without digging through the header.</p>
        <Flex gap="10" wrap>
          <Link className="moon-profile-inline-link" href="/library">Library</Link>
          <Link className="moon-profile-inline-link" href="/myrequests">Requests</Link>
          <Link className="moon-profile-inline-link" href="/following">Following</Link>
        </Flex>
      </section>
      {adminCapable ? (
        <section className="moon-profile-card">
          <h3>Admin tools</h3>
          <p className="moon-muted">Open the Arr-style admin panel for moderation, queue operations, source repair, and system settings.</p>
          <Button href="/admin" variant="secondary" size="m">
            Open admin
          </Button>
        </section>
      ) : null}
    </div>
  );

  const apiKeysContent = (
    <div className="moon-profile-tab-grid">
      <section className="moon-profile-card">
        <h3>Create user API key</h3>
        <p className="moon-muted">Personal keys are linked to this account and can only sync your reader state, follows, bookmarks, and own requests.</p>
        {apiSecret ? (
          <div className="moon-secret-panel">
            <strong>{apiSecret}</strong>
            <button className="moon-profile-inline-link moon-profile-inline-link-button" type="button" onClick={() => void navigator.clipboard?.writeText(apiSecret)}>Copy</button>
          </div>
        ) : null}
        {apiFlash ? <p className="moon-muted">{apiFlash}</p> : null}
        <div className="moon-profile-key-form">
          <input
            value={apiKeyName}
            onChange={(event) => setApiKeyName(event.target.value)}
            placeholder="Reader app, tracker, or device name"
            disabled={!apiKeysState.data?.canManageApiKeys}
          />
          <button
            className="moon-profile-inline-link moon-profile-inline-link-button"
            type="button"
            disabled={!apiKeysState.data?.canManageApiKeys || apiBusy === "create"}
            onClick={() => void createApiKey()}
          >
            {apiBusy === "create" ? "Creating..." : "Create key"}
          </button>
        </div>
      </section>
      <section className="moon-profile-card">
        <h3>Your keys</h3>
        <div className="moon-list">
          {apiKeysState.loading ? <p className="moon-muted">Loading API keys.</p> : null}
          {normalizeArray(apiKeysState.data?.apiKeys).length ? normalizeArray(apiKeysState.data?.apiKeys).map((apiKey) => {
            const revoked = Boolean(apiKey.revokedAt);
            const enabled = apiKey.enabled !== false && !revoked;
            return (
              <article key={apiKey.id} className="moon-list-row moon-profile-preview-row">
                <div>
                  <strong>{normalizeString(apiKey.name, "Reader API key")}</strong>
                  <div className="moon-list-meta">
                    {revoked ? "revoked" : enabled ? "enabled" : "disabled"} - {apiKey.lastUsedAt ? `last used ${formatDateTime(apiKey.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                <Flex gap="8" wrap>
                  {!revoked ? (
                    <button
                      className="moon-profile-inline-link moon-profile-inline-link-button"
                      type="button"
                      disabled={apiBusy === apiKey.id}
                      onClick={() => void patchApiKey(apiKey, {enabled: !enabled})}
                    >
                      {enabled ? "Disable" : "Enable"}
                    </button>
                  ) : null}
                  <button
                    className="moon-profile-inline-link moon-profile-inline-link-button"
                    type="button"
                    disabled={apiBusy === apiKey.id || revoked}
                    onClick={() => void revokeApiKey(apiKey)}
                  >
                    Revoke
                  </button>
                </Flex>
              </article>
            );
          }) : <p className="moon-muted">No personal API keys yet.</p>}
        </div>
      </section>
    </div>
  );

  const activeContent = {
    overview: overviewContent,
    stats: statsContent,
    preferences: preferencesContent,
    api: apiKeysContent
  };

  return (
    <div className="moon-page-grid moon-profile-page">
      <section className="moon-panel moon-section moon-profile-summary">
        <div className="moon-kicker">Profile</div>
        <div className="moon-profile-account">
          <Avatar
            className="moon-profile-avatar"
            size="xl"
            {...buildAvatarProps(effectiveUser)}
          />
          <Column gap="8">
            <h1 className="moon-profile-heading">{effectiveUser.username || "Reader"}</h1>
            <p className="moon-support-copy">
              Moon keeps your reading state, request activity, follows, and local presentation settings together in one tabbed account hub.
            </p>
            <div className="moon-pill-row">
              <span className="moon-pill">{effectiveUser.role || "reader"}</span>
              <span className="moon-pill">{stats.requestCounts?.total || 0} requests</span>
              <span className="moon-pill">{stats.followingCount} follows</span>
              <span className="moon-pill">{stats.completedCount} completed</span>
            </div>
          </Column>
        </div>
      </section>

      <section className="moon-panel moon-section">
        <div className="moon-section-head moon-profile-tabs-head">
          <div>
            <div className="moon-kicker">Account hub</div>
            <h2>{PROFILE_TABS.find((entry) => entry.id === tab)?.label || "Overview"}</h2>
          </div>
          <div className="moon-profile-tab-row" role="tablist" aria-label="Profile sections">
            {PROFILE_TABS.map((entry) => (
              <button
                key={entry.id}
                className={`moon-profile-tab ${tab === entry.id ? "is-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => setActiveTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        {activeContent[tab]}
      </section>
    </div>
  );
};

export default ProfilePageClient;
