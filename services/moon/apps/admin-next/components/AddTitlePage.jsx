"use client";

/**
 * @file Metadata-first Admin Add Title flow for the Next Moon admin app.
 */

import {useState} from "react";
import {requestJson} from "../lib/api.js";
import {normalizeString} from "../lib/format.js";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const tagsFor = (entry) => normalizeArray(entry.tags).slice(0, 6);

const Cover = ({entry}) => {
  const title = normalizeString(entry.title, normalizeString(entry.titleName, "Title"));
  return (
    <div className="admin-result-cover">
      {normalizeString(entry.coverUrl) ? <img src={entry.coverUrl} alt="" /> : <span>{title.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
};

const TagRow = ({tags}) => tags?.length ? (
  <div className="admin-chip-row">
    {tags.map((tag) => <span className="admin-chip" key={tag}>{tag}</span>)}
  </div>
) : null;

/**
 * Render Admin Add Title as an explicit metadata -> source -> queue flow.
 *
 * @returns {import("react").ReactNode}
 */
export const AddTitlePage = () => {
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState("");
  const [metadataResults, setMetadataResults] = useState([]);
  const [selectedMetadata, setSelectedMetadata] = useState(null);
  const [downloadOptions, setDownloadOptions] = useState([]);
  const [selectedDownload, setSelectedDownload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState(null);
  const {notify} = useAdminToast();

  const searchMetadata = async () => {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
      setFlash({tone: "bad", text: "Search needs a title first."});
      notify({message: "Search needs a title first.", tone: "bad", category: "action"});
      return;
    }
    setLoading(true);
    const result = await requestJson(`/api/moon/v3/admin/add/metadata-search?query=${encodeURIComponent(normalizedQuery)}`);
    setLoading(false);
    if (!result.ok) {
      setFlash({tone: "bad", text: result.payload?.error || "Metadata search failed."});
      notify({message: result.payload?.error || "Metadata search failed.", tone: "bad", category: "action"});
      return;
    }
    setMetadataResults(normalizeArray(result.payload?.results));
    setSelectedMetadata(null);
    setDownloadOptions([]);
    setSelectedDownload(null);
    setFlash({tone: "good", text: `Found ${normalizeArray(result.payload?.results).length} metadata result${normalizeArray(result.payload?.results).length === 1 ? "" : "s"}.`});
  };

  const loadSources = async (metadata) => {
    setSelectedMetadata(metadata);
    setSelectedDownload(null);
    setLoading(true);
    const result = await requestJson("/api/moon/v3/admin/add/download-options", {
      method: "POST",
      json: {
        query,
        selectedMetadata: metadata
      }
    });
    setLoading(false);
    if (!result.ok) {
      setDownloadOptions([]);
      setFlash({tone: "bad", text: result.payload?.error || "Download-source lookup failed."});
      notify({message: result.payload?.error || "Download-source lookup failed.", tone: "bad", category: "action"});
      return;
    }
    const options = normalizeArray(result.payload?.results);
    setDownloadOptions(options);
    const message = options.length ? `Found ${options.length} source option${options.length === 1 ? "" : "s"}.` : "No enabled download source matched this metadata yet.";
    setFlash({tone: options.length ? "good" : "bad", text: message});
    notify({message, tone: options.length ? "good" : "bad", category: "action"});
  };

  const queueTitle = async (download = selectedDownload) => {
    if (!selectedMetadata) {
      setFlash({tone: "bad", text: "Pick a metadata result first."});
      notify({message: "Pick a metadata result first.", tone: "bad", category: "action"});
      return;
    }
    setLoading(true);
    const result = await requestJson("/api/moon/v3/admin/add/queue", {
      method: "POST",
      json: {
        query,
        notes,
        title: selectedMetadata.title,
        requestType: download?.requestType || selectedMetadata.type || "manga",
        selectedMetadata,
        selectedDownload: download || null
      }
    });
    setLoading(false);
    const message = result.ok
      ? result.payload?.queued ? "Queued the selected source in Raven." : "Saved as unavailable for later review."
      : result.payload?.error || result.payload?.message || "Moon could not queue that title.";
    setFlash({
      tone: result.ok ? "good" : "bad",
      text: message
    });
    notify({message, tone: result.ok ? "good" : "bad", category: result.ok && result.payload?.queued ? "job" : "action"});
  };

  return (
    <>
      {flash ? <div className={`admin-flash ${flash.tone}`}>{flash.text}</div> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Admin flow</div>
            <h2>Pick metadata, then source</h2>
          </div>
          {loading ? <span className="admin-badge warning">Working</span> : null}
        </div>
        <div className="admin-form-grid">
          <label>
            <span>Search title</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Naruto, Slime, One Piece..." />
          </label>
          <label>
            <span>Audit note</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional note for why this is being added" />
          </label>
          <button className="admin-button solid" type="button" onClick={searchMetadata}>Search metadata</button>
        </div>
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Step 1</div>
            <h2>Metadata results</h2>
          </div>
        </div>
        {metadataResults.length ? (
          <div className="admin-record-grid">
            {metadataResults.map((entry) => (
              <article className={`admin-record-card ${selectedMetadata === entry ? "is-selected" : ""}`} key={`${entry.provider}-${entry.providerSeriesId}`}>
                <Cover entry={entry} />
                <div className="admin-record-copy">
                  <div className="admin-record-head">
                    <strong>{normalizeString(entry.title, "Untitled")}</strong>
                    <span className="admin-badge">{normalizeString(entry.providerName, entry.provider)}</span>
                  </div>
                  <p>{normalizeString(entry.summary, "No summary from this metadata provider.")}</p>
                  <TagRow tags={tagsFor(entry)} />
                  <div className="admin-action-row">
                    <button className="admin-button solid small" type="button" onClick={() => loadSources(entry)}>Pick source</button>
                    {normalizeString(entry.url) ? <a className="admin-button ghost small" href={entry.url} target="_blank" rel="noreferrer">Open metadata</a> : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="admin-empty">Search metadata to start the admin add flow.</div>}
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Step 2</div>
            <h2>Download sources</h2>
          </div>
          {selectedMetadata ? <button className="admin-button ghost small" type="button" onClick={() => queueTitle(null)}>Save unavailable</button> : null}
        </div>
        {downloadOptions.length ? (
          <div className="admin-record-grid">
            {downloadOptions.map((entry) => (
              <article className={`admin-record-card ${selectedDownload === entry ? "is-selected" : ""}`} key={`${entry.providerId}-${entry.titleUrl}`}>
                <Cover entry={entry} />
                <div className="admin-record-copy">
                  <div className="admin-record-head">
                    <strong>{normalizeString(entry.titleName, "Untitled source")}</strong>
                    <span className="admin-badge">{normalizeString(entry.providerName, entry.providerId)}</span>
                  </div>
                  <p>{normalizeString(entry.summary, normalizeString(entry.titleUrl))}</p>
                  <TagRow tags={tagsFor(entry)} />
                  {normalizeArray(entry.warnings).length ? <p className="admin-warning-text">{normalizeArray(entry.warnings).join(", ")}</p> : null}
                  <div className="admin-action-row">
                    <button
                      className="admin-button solid small"
                      type="button"
                      onClick={() => {
                        setSelectedDownload(entry);
                        void queueTitle(entry);
                      }}
                    >
                      Queue this source
                    </button>
                    {normalizeString(entry.titleUrl) ? <a className="admin-button ghost small" href={entry.titleUrl} target="_blank" rel="noreferrer">Open source</a> : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="admin-empty">Pick a metadata result to resolve concrete download sources.</div>}
      </section>
    </>
  );
};

export default AddTitlePage;
