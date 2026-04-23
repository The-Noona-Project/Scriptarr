"use client";

/**
 * @file My Requests page for Moon's Once UI Next user app.
 */

import Link from "next/link";
import {useState} from "react";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {formatDate} from "../../lib/date.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const tabs = [
  {id: "active", label: "Active"},
  {id: "completed", label: "Completed"},
  {id: "closed", label: "Closed"}
];

const buildRequestStatusCopy = (request) => {
  if (request.status === "pending" && !request.details?.selectedDownload?.titleUrl) {
    return request.details?.sourceFoundOptions?.length
      ? "Scriptarr found download candidates and moved this request back into admin review."
      : "Waiting for an admin to review the metadata match and choose a download source.";
  }
  if (request.status === "unavailable") {
    return "No enabled download provider has a source for this metadata match yet. Sage will keep checking every 4 hours.";
  }
  if (request.status === "queued") {
    return "Approved and queued for Raven.";
  }
  if (request.status === "downloading") {
    return "Raven is downloading this title now.";
  }
  if (request.status === "failed") {
    return "The download failed. Staff can retry or choose a different source.";
  }
  if (request.status === "completed") {
    return "Completed and available in Moon.";
  }
  if (request.status === "denied") {
    return "Closed by staff.";
  }
  if (request.status === "expired") {
    return "Removed after waiting too long without a source.";
  }
  if (request.status === "cancelled") {
    return "Cancelled by the requester.";
  }
  return "Request updated.";
};

const RequestWizardNotice = ({notice}) => {
  if (!notice?.message) {
    return null;
  }

  return (
    <div className={`moon-request-notice is-${notice.tone || "info"}`}>
      <p>{notice.message}</p>
      {notice.linkUrl ? (
        <Link href={notice.linkUrl}>
          {notice.linkLabel || "Open it in Moon"}
        </Link>
      ) : null}
    </div>
  );
};

const MetadataLink = ({href, label = "Open metadata source"}) => {
  const normalizedHref = normalizeString(href);
  if (!normalizedHref) {
    return null;
  }

  return (
    <a href={normalizedHref} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
};

const MetadataChoiceCard = ({entry, isSelected, onSelect}) => (
  <article className={`moon-request-choice ${isSelected ? "is-selected" : ""}`}>
    <div className="moon-request-choice-head">
      <div className="moon-request-choice-copy">
        <strong>{entry.title}</strong>
        <div>{entry.providerName || entry.provider} · {entry.type}</div>
      </div>
      <button type="button" onClick={() => onSelect(entry)}>
        {isSelected ? "Selected" : "Pick this metadata"}
      </button>
    </div>
    {entry.summary ? <p>{entry.summary}</p> : null}
    {entry.aliases?.length ? (
      <div className="moon-request-choice-detail">
        <span>Aliases</span>
        <p>{entry.aliases.join(", ")}</p>
      </div>
    ) : null}
    {entry.tags?.length ? (
      <div className="moon-request-choice-detail">
        <span>Tags</span>
        <p>{entry.tags.join(", ")}</p>
      </div>
    ) : null}
    <div className="moon-request-choice-links">
      {entry.releaseLabel ? <span>{entry.releaseLabel}</span> : null}
      {entry.status ? <span>{entry.status}</span> : null}
      <MetadataLink href={entry.url} />
    </div>
  </article>
);

const RequestRow = ({request, onEditNotes, onCancel}) => {
  const metadata = request.details?.selectedMetadata || {};
  const download = request.details?.selectedDownload || {};

  return (
    <article className="moon-request-row">
      <div className="moon-request-row-head">
        <div>
          <strong>{request.title}</strong>
          <span className={`moon-request-status is-${request.status}`}>{request.status}</span>
        </div>
        <span className="moon-muted">{formatDate(request.updatedAt, {includeTime: true})}</span>
      </div>
      <div className="moon-request-row-meta">
        <span>{request.requestType}</span>
        <span>{metadata.providerName || metadata.provider || "metadata pending"}</span>
        <span>{download.providerName || download.providerId || request.availability}</span>
      </div>
      {request.notes || request.details?.query ? (
        <p className="moon-request-row-notes">{request.notes || request.details?.query}</p>
      ) : null}
      <p className="moon-request-row-hint">{buildRequestStatusCopy(request)}</p>
      {metadata.url ? (
        <div className="moon-request-row-links">
          <MetadataLink href={metadata.url} label="Review metadata" />
        </div>
      ) : null}
      {(request.canEditNotes || request.canCancel) ? (
        <div className="moon-request-row-actions">
          {request.canEditNotes ? (
            <button type="button" onClick={() => onEditNotes(request)}>
              Edit notes
            </button>
          ) : null}
          {request.canCancel ? (
            <button type="button" className="is-danger" onClick={() => onCancel(request)}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
};

/**
 * Render the requests page.
 *
 * @returns {import("react").ReactNode}
 */
export const RequestsPageClient = () => {
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data, refresh} = useMoonJson("/api/moon-v3/user/requests", {
    fallback: {
      requests: [],
      tabs: {
        active: 0,
        completed: 0,
        closed: 0
      }
    }
  });
  const [activeTab, setActiveTab] = useState("active");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState("");
  const [metadataResults, setMetadataResults] = useState([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [selectedMetadata, setSelectedMetadata] = useState(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [notice, setNotice] = useState(null);

  const requests = normalizeArray(data?.requests);
  const visibleRequests = requests.filter((entry) => entry.tab === activeTab);

  const resetWizard = () => {
    setMetadataResults([]);
    setSelectedMetadata(null);
    setSubmitPending(false);
  };

  const handleMetadataSearch = async (event) => {
    event.preventDefault();
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
      setNotice({tone: "bad", message: "Enter a title before you search Scriptarr metadata."});
      return;
    }

    setMetadataLoading(true);
    setNotice(null);
    setSelectedMetadata(null);
    const result = await requestJson(`/api/moon-v3/user/requests/metadata-search?query=${encodeURIComponent(normalizedQuery)}`);
    setMetadataLoading(false);

    if (!result.ok) {
      setMetadataResults([]);
      setNotice({tone: "bad", message: result.payload?.error || "Moon could not search metadata right now."});
      return;
    }

    const nextResults = normalizeArray(result.payload?.results);
    setMetadataResults(nextResults);
    if (!nextResults.length) {
      setNotice({tone: "info", message: `No metadata matches were found for "${normalizedQuery}".`});
      return;
    }

    setNotice({
      tone: "good",
      message: `Found ${nextResults.length} metadata match${nextResults.length === 1 ? "" : "es"}. Pick the exact title you want staff to review.`
    });
  };

  const handleSubmit = async () => {
    if (!selectedMetadata) {
      setNotice({tone: "bad", message: "Pick an exact metadata result first."});
      return;
    }

    setSubmitPending(true);
    const result = await requestJson("/api/moon-v3/user/requests", {
      method: "POST",
      json: {
        query,
        notes,
        title: selectedMetadata.title,
        requestType: selectedMetadata.type || "manga",
        selectedMetadata
      }
    });
    setSubmitPending(false);

    if (result.ok) {
      const nextRequest = result.payload;
      setNotice({
        tone: "good",
        message: nextRequest?.status === "unavailable"
          ? `Saved "${nextRequest.title}" as unavailable. Sage will keep checking for a source every 4 hours and staff will review it once one appears.`
          : `Saved "${nextRequest?.title || selectedMetadata.title}" for review. Staff will pick the download source during approval.`
      });
      setQuery("");
      setNotes("");
      resetWizard();
      await refresh();
      return;
    }

    if (result.payload?.code === "REQUEST_ALREADY_IN_LIBRARY") {
      setNotice({
        tone: "info",
        message: `${result.payload?.libraryTitle?.title || selectedMetadata.title} is already in the Scriptarr library.`,
        linkUrl: result.payload?.libraryTitle?.linkUrl,
        linkLabel: "Open the title page"
      });
      return;
    }

    if (result.payload?.code === "REQUEST_ALREADY_QUEUED") {
      setNotice({
        tone: "info",
        message: `Scriptarr is already tracking ${result.payload?.title || selectedMetadata.title}. You were added to the waitlist and will get a Discord DM when it is ready.`,
        linkUrl: result.payload?.linkUrl,
        linkLabel: "Open My Requests"
      });
      await refresh();
      return;
    }

    setNotice({
      tone: "bad",
      message: result.payload?.error || "Moon could not save that request."
    });
  };

  const handleEditNotes = async (request) => {
    const nextNotes = window.prompt("Update your request notes:", request.notes || "");
    if (nextNotes == null) {
      return;
    }
    const result = await requestJson(`/api/moon-v3/user/requests/${encodeURIComponent(request.id)}/notes`, {
      method: "PATCH",
      json: {
        notes: nextNotes
      }
    });
    setNotice({
      tone: result.ok ? "good" : "bad",
      message: result.ok
        ? "Request notes updated."
        : result.payload?.error || "Moon could not update those notes."
    });
    if (result.ok) {
      await refresh();
    }
  };

  const handleCancel = async (request) => {
    if (!window.confirm(`Cancel "${request.title}"?`)) {
      return;
    }
    const result = await requestJson(`/api/moon-v3/user/requests/${encodeURIComponent(request.id)}/cancel`, {
      method: "POST"
    });
    setNotice({
      tone: result.ok ? "good" : "bad",
      message: result.ok
        ? "Request canceled."
        : result.payload?.error || "Moon could not cancel that request."
    });
    if (result.ok) {
      await refresh();
    }
  };

  if (loading) {
    return <LoadingView label="Moon is loading your request wizard, request tabs, and Discord-backed moderation history." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to request content"
        detail="Connect Discord to search metadata, pick the exact title, and track moderated requests in one place."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  return (
    <div className="moon-requests-layout">
      <section className="moon-panel moon-section moon-request-wizard">
        <div className="moon-section-head">
          <div>
            <span className="moon-kicker">Requests</span>
            <h2>Ask Moon to track a full title</h2>
            <p>Search metadata first, inspect the provider details, and submit the exact title you want staff to review.</p>
          </div>
        </div>

        <form className="moon-request-search" onSubmit={handleMetadataSearch}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search a title"
          />
          <button type="submit" disabled={metadataLoading}>
            {metadataLoading ? "Searching..." : "Search metadata"}
          </button>
        </form>

        <label className="moon-request-notes-field">
          <span>Optional notes</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Anything staff should know about this request?"
          />
        </label>

        <RequestWizardNotice notice={notice} />

        {metadataResults.length ? (
          <div className="moon-request-step">
            <div className="moon-request-step-head">
              <span className="moon-kicker">Step 1</span>
              <h3>Pick the exact metadata result</h3>
              <p>Use the metadata link if you want to confirm the title before you submit it for staff review.</p>
            </div>
            <div className="moon-request-choice-list">
              {metadataResults.map((entry) => (
                <MetadataChoiceCard
                  key={`${entry.provider}:${entry.providerSeriesId}`}
                  entry={entry}
                  isSelected={
                    selectedMetadata?.provider === entry.provider
                    && selectedMetadata?.providerSeriesId === entry.providerSeriesId
                  }
                  onSelect={setSelectedMetadata}
                />
              ))}
            </div>
          </div>
        ) : null}

        {selectedMetadata ? (
          <div className="moon-request-summary">
            <div className="moon-request-summary-head">
              <div>
                <span className="moon-kicker">Selected metadata</span>
                <strong>{selectedMetadata.title}</strong>
                <p>{selectedMetadata.providerName || selectedMetadata.provider} · {selectedMetadata.type}</p>
              </div>
              <MetadataLink href={selectedMetadata.url} />
            </div>
            {selectedMetadata.tags?.length ? (
              <p className="moon-request-summary-tags">{selectedMetadata.tags.join(", ")}</p>
            ) : null}
          </div>
        ) : null}

        {selectedMetadata ? (
          <div className="moon-request-submit">
            <button type="button" disabled={submitPending} onClick={handleSubmit}>
              {submitPending ? "Submitting..." : "Submit request"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="moon-panel moon-section">
        <div className="moon-section-head">
          <div>
            <span className="moon-kicker">History</span>
            <h2>Everything you have asked Moon to track</h2>
          </div>
        </div>
        <div className="moon-request-tabs" role="tablist" aria-label="Request status tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "is-active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              <span>{data?.tabs?.[tab.id] || 0}</span>
            </button>
          ))}
        </div>
        {visibleRequests.length ? (
          <div className="moon-request-list">
            {visibleRequests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                onEditNotes={handleEditNotes}
                onCancel={handleCancel}
              />
            ))}
          </div>
        ) : (
          <EmptyView
            title={`No ${activeTab} requests yet`}
            detail={activeTab === "active"
              ? "Search a title above and submit the exact metadata result you want Scriptarr staff to review."
              : "Your request history for this tab will show up here once you start using Moon requests."}
          />
        )}
      </section>
    </div>
  );
};

export default RequestsPageClient;
