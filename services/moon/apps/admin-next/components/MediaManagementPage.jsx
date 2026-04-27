"use client";

/**
 * @file Raven naming profile controls for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDisplayValue} from "../lib/format.js";
import {AdminActionBanner, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const profileTypes = Object.freeze([
  {id: "fallback", label: "Fallback"},
  {id: "manga", label: "Manga"},
  {id: "manhwa", label: "Manhwa"},
  {id: "manhua", label: "Manhua"},
  {id: "webtoon", label: "Webtoon"},
  {id: "comic", label: "Comic"},
  {id: "oel", label: "OEL"}
]);

const defaultProfile = Object.freeze({
  chapterTemplate: "{title} c{chapter_padded} (v{volume_padded}) [Scriptarr].cbz",
  pageTemplate: "{page_padded}{ext}",
  chapterPad: 3,
  pagePad: 3,
  volumePad: 2
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeNumber = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeProfile = (value = {}, fallback = defaultProfile) => ({
  chapterTemplate: normalizeString(value.chapterTemplate, fallback.chapterTemplate),
  pageTemplate: normalizeString(value.pageTemplate, fallback.pageTemplate),
  chapterPad: normalizeNumber(value.chapterPad, fallback.chapterPad),
  pagePad: normalizeNumber(value.pagePad, fallback.pagePad),
  volumePad: normalizeNumber(value.volumePad, fallback.volumePad)
});

const normalizeNaming = (value = {}) => {
  const fallback = normalizeProfile(value, defaultProfile);
  const profiles = {};
  for (const type of profileTypes.filter((entry) => entry.id !== "fallback")) {
    profiles[type.id] = normalizeProfile(value.profiles?.[type.id], fallback);
  }
  return {
    key: "raven.naming",
    ...fallback,
    profiles
  };
};

const pad = (value, size) => String(value).padStart(Number(size) || 1, "0");

const renderPreview = (profile) => ({
  chapter: profile.chapterTemplate
    .replaceAll("{title}", "Dandadan")
    .replaceAll("{chapter}", "12")
    .replaceAll("{chapter_padded}", pad(12, profile.chapterPad))
    .replaceAll("{volume}", "2")
    .replaceAll("{volume_padded}", pad(2, profile.volumePad)),
  page: profile.pageTemplate
    .replaceAll("{page}", "7")
    .replaceAll("{page_padded}", pad(7, profile.pagePad))
    .replaceAll("{ext}", ".jpg")
});

/**
 * Render the dedicated media management page.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const MediaManagementPage = ({user}) => {
  const canSave = hasAdminGrant(user, "mediamanagement", "write");
  const [selectedType, setSelectedType] = useState("fallback");
  const [draft, setDraft] = useState(null);
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const [busy, setBusy] = useState(false);
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/mediamanagement", {
    fallback: {naming: normalizeNaming({})}
  });
  useAdminEventStaleness({
    domains: ["mediamanagement"],
    enabled: true,
    locked: refreshing,
    onStale: () => {},
    onRefresh: refresh
  });

  useEffect(() => {
    if (!draft && data?.naming) {
      setDraft(normalizeNaming(data.naming));
    }
  }, [data?.naming, draft]);

  const currentProfile = selectedType === "fallback"
    ? normalizeProfile(draft || {})
    : normalizeProfile(draft?.profiles?.[selectedType], normalizeProfile(draft || {}));
  const preview = useMemo(() => renderPreview(currentProfile), [currentProfile]);

  const patchCurrentProfile = (patch) => {
    setDraft((current) => {
      const normalized = normalizeNaming(current || {});
      if (selectedType === "fallback") {
        return normalizeNaming({
          ...normalized,
          ...patch
        });
      }
      return normalizeNaming({
        ...normalized,
        profiles: {
          ...normalized.profiles,
          [selectedType]: {
            ...normalized.profiles[selectedType],
            ...patch
          }
        }
      });
    });
  };

  const copyFallback = () => {
    const fallback = normalizeProfile(draft || {});
    patchCurrentProfile(fallback);
  };

  const resetCurrent = () => {
    patchCurrentProfile(selectedType === "fallback" ? defaultProfile : normalizeProfile(draft || {}));
  };

  const save = async () => {
    setBusy(true);
    setFlash("");
    const result = await requestJson("/api/moon/admin/settings/raven/naming", {
      method: "PUT",
      json: draft
    });
    setBusy(false);
    if (!result.ok) {
      setFlash(formatDisplayValue(result.payload?.error, "Moon could not save naming profiles."));
      setFlashTone("bad");
      notify({message: formatDisplayValue(result.payload?.error, "Moon could not save naming profiles."), tone: "bad", category: "action"});
      return;
    }
    const nextNaming = normalizeNaming(result.payload || draft);
    setData({naming: nextNaming});
    setDraft(nextNaming);
    setFlash("Raven naming profiles saved.");
    setFlashTone("good");
    notify({message: "Raven naming profiles saved.", tone: "good", category: "action"});
  };

  if (loading || !draft) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading Media Management</h2>
        <p>Moon is loading Raven naming profiles through Sage.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flashTone}>{flash}</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Raven</div>
            <h2>Media Management</h2>
            <p className="admin-muted">Edit fallback and per-type archive naming profiles used for new downloads and rescans.</p>
          </div>
          <AdminStatusBadge tone={refreshing ? "warning" : "good"}>{refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-tab-row">
          {profileTypes.map((type) => (
            <button
              key={type.id}
              className={`admin-tab ${selectedType === type.id ? "is-active" : ""}`}
              type="button"
              onClick={() => setSelectedType(type.id)}
            >
              {type.label}
            </button>
          ))}
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Naming profile</div>
            <h2>{profileTypes.find((type) => type.id === selectedType)?.label || "Profile"}</h2>
          </div>
          <div className="admin-action-row">
            {selectedType !== "fallback" ? <button className="admin-button ghost" type="button" disabled={!canSave} onClick={copyFallback}>Copy fallback</button> : null}
            <button className="admin-button ghost" type="button" disabled={!canSave} onClick={resetCurrent}>Reset</button>
            <button className="admin-button solid" type="button" disabled={!canSave || busy} onClick={() => void save()}>{busy ? "Saving..." : "Save"}</button>
          </div>
        </div>
        <div className="admin-task-form">
          <label className="admin-filter-grow">
            <span>Chapter archive template</span>
            <input disabled={!canSave} value={currentProfile.chapterTemplate} onChange={(event) => patchCurrentProfile({chapterTemplate: event.target.value})} />
          </label>
          <label className="admin-filter-grow">
            <span>Page template</span>
            <input disabled={!canSave} value={currentProfile.pageTemplate} onChange={(event) => patchCurrentProfile({pageTemplate: event.target.value})} />
          </label>
          <label>
            <span>Chapter pad</span>
            <input disabled={!canSave} type="number" min="1" max="8" value={currentProfile.chapterPad} onChange={(event) => patchCurrentProfile({chapterPad: event.target.value})} />
          </label>
          <label>
            <span>Page pad</span>
            <input disabled={!canSave} type="number" min="1" max="8" value={currentProfile.pagePad} onChange={(event) => patchCurrentProfile({pagePad: event.target.value})} />
          </label>
          <label>
            <span>Volume pad</span>
            <input disabled={!canSave} type="number" min="1" max="8" value={currentProfile.volumePad} onChange={(event) => patchCurrentProfile({volumePad: event.target.value})} />
          </label>
        </div>
        <div className="admin-detail-grid">
          <span><strong>Chapter preview</strong>{preview.chapter}</span>
          <span><strong>Page preview</strong>{preview.page}</span>
        </div>
      </section>
    </>
  );
};

export default MediaManagementPage;
