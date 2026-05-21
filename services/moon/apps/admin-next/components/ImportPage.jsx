"use client";

/**
 * @file Manual CBZ import page for Moon admin.
 */

import {useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminJson} from "../lib/api.js";
import {normalizeString} from "../lib/format.js";
import {useAdminToast} from "./AdminToasts.jsx";
import {AdminActionBanner, AdminDenseTable} from "./AdminUi.jsx";

const DEFAULT_CHAPTER = {sourcePath: "", chapterNumber: "1", label: "Chapter 1"};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

/**
 * Render the manual CBZ import workflow.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const ImportPage = ({user}) => {
  const {loading, error, data, refresh} = useAdminJson("/api/moon/v3/admin/import", {
    fallback: {summary: {}, titles: []}
  });
  const [form, setForm] = useState({
    titleName: "",
    libraryType: "Manga",
    existingTitleId: "",
    chapters: [DEFAULT_CHAPTER]
  });
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState(null);
  const {notify} = useAdminToast();
  const canWrite = hasAdminGrant(user, "import", "write");

  const updateChapter = (index, patch) => {
    setForm((current) => ({
      ...current,
      chapters: current.chapters.map((chapter, chapterIndex) =>
        chapterIndex === index ? {...chapter, ...patch} : chapter
      )
    }));
  };

  const addChapter = () => {
    setForm((current) => ({
      ...current,
      chapters: [...current.chapters, {...DEFAULT_CHAPTER, chapterNumber: String(current.chapters.length + 1), label: `Chapter ${current.chapters.length + 1}`}]
    }));
  };

  const removeChapter = (index) => {
    setForm((current) => ({
      ...current,
      chapters: current.chapters.length <= 1 ? current.chapters : current.chapters.filter((_chapter, chapterIndex) => chapterIndex !== index)
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    const result = await requestJson("/api/moon/v3/admin/import", {method: "POST", json: form});
    const message = result.ok ? "Import accepted and ingest started." : result.payload?.error || "Moon could not import those CBZ files.";
    setFlash({tone: result.ok ? "good" : "bad", text: message});
    notify({message, tone: result.ok ? "good" : "bad", category: "job"});
    setSubmitting(false);
    if (result.ok) {
      setForm({titleName: "", libraryType: "Manga", existingTitleId: "", chapters: [DEFAULT_CHAPTER]});
      await refresh();
    }
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Import</div>
        <h2>Loading import</h2>
        <p>Moon is preparing the manual CBZ import surface.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Import</div>
        <h2>Import unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  const titles = normalizeArray(data?.titles);
  const summary = data?.summary || {};

  return (
    <div className="queue-page">
      {flash ? <div className={`admin-flash ${flash.tone}`}>{flash.text}</div> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Import</div>
            <h2>Manual CBZ import</h2>
          </div>
          <span className="admin-muted">{normalizeString(summary.stagingRoot, "/downloads/import-staging")}</span>
        </div>
        <form className="admin-form-grid" onSubmit={submit}>
          <label>
            Title
            <input
              value={form.titleName}
              onChange={(event) => setForm((current) => ({...current, titleName: event.target.value}))}
              placeholder="Title name"
            />
          </label>
          <label>
            Library type
            <select value={form.libraryType} onChange={(event) => setForm((current) => ({...current, libraryType: event.target.value}))}>
              <option value="Manga">Manga</option>
              <option value="Manhwa">Manhwa</option>
              <option value="Manhua">Manhua</option>
              <option value="Comic">Comic</option>
              <option value="Webtoon">Webtoon</option>
            </select>
          </label>
          <label>
            Existing title
            <select value={form.existingTitleId} onChange={(event) => setForm((current) => ({...current, existingTitleId: event.target.value}))}>
              <option value="">New title</option>
              {titles.map((title) => (
                <option key={title.id} value={title.id}>{title.title}</option>
              ))}
            </select>
          </label>
          <div className="admin-action-row">
            <button className="admin-button ghost small" type="button" onClick={addChapter}>Add chapter</button>
            <button className="admin-button solid small" type="submit" disabled={!canWrite || submitting}>
              {submitting ? "Importing" : "Import"}
            </button>
          </div>
        </form>
      </section>

      {!canWrite ? <AdminActionBanner tone="warning">Import write access is required.</AdminActionBanner> : null}

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">CBZ files</div>
            <h2>{form.chapters.length} chapter{form.chapters.length === 1 ? "" : "s"}</h2>
          </div>
        </div>
        <AdminDenseTable
          rows={form.chapters}
          getKey={(_row, index) => `chapter-${index}`}
          columns={[
            {key: "sourcePath", label: "Source path", render: (row, index) => (
              <input value={row.sourcePath} onChange={(event) => updateChapter(index, {sourcePath: event.target.value})} placeholder="/downloads/import-staging/title/chapter.cbz" />
            )},
            {key: "chapterNumber", label: "Number", render: (row, index) => (
              <input value={row.chapterNumber} onChange={(event) => updateChapter(index, {chapterNumber: event.target.value})} />
            )},
            {key: "label", label: "Label", render: (row, index) => (
              <input value={row.label} onChange={(event) => updateChapter(index, {label: event.target.value})} />
            )},
            {key: "actions", label: "", render: (_row, index) => (
              <button className="admin-button ghost danger small" type="button" onClick={() => removeChapter(index)}>Remove</button>
            )}
          ]}
        />
      </section>
    </div>
  );
};

export default ImportPage;
