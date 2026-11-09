"use client";

/** @file Source evidence scoped to one mounted title selection. */
import {useAdminJson} from "../lib/api.js";
import {formatDate} from "../lib/format.js";

/**
 * Keep evidence and request lifetime bound to the selected title.
 * @param {{titleId: string}} props Exact selected canonical identity.
 * @returns {import("react").ReactNode} Source/provider comparison.
 */
export const MetadataEvidence = ({titleId}) => {
  const {data: evidence, error} = useAdminJson(`/api/moon/v3/admin/wanted/metadata/${encodeURIComponent(titleId)}/evidence`, {fallback: null});
  return <section className="admin-subsection">
    <h3>Source and edition evidence</h3>
    {error ? <p className="admin-muted">Metadata evidence is unavailable.</p> : null}
    <div className="admin-detail-grid">
      <span><strong>Binding</strong>{evidence?.decision || "unverified"}</span>
      <span><strong>Source edition</strong>{evidence?.source?.title || "Not verified"} · {evidence?.source?.year || "Year unknown"}</span>
      <span><strong>Provider edition</strong>{evidence?.provider?.title || "Not matched"} · {evidence?.provider?.year || "Year unknown"}</span>
      <span><strong>Source status</strong>{evidence?.source?.status || "Unknown"}</span>
      <span><strong>Provider status</strong>{evidence?.provider?.status || "Unknown"}</span>
      <span><strong>Source creators</strong>{evidence?.source?.authors?.join(", ") || "Unknown"}</span>
      <span><strong>Provider creators</strong>{[evidence?.provider?.author, ...(evidence?.provider?.artists || [])].filter(Boolean).join(", ") || "Unknown"}</span>
      <span><strong>Verified</strong>{formatDate(evidence?.verifiedAt)}</span>
    </div>
    {(evidence?.conflicts || []).map(warning => <p key={warning} className="admin-muted">{warning}</p>)}
    <details><summary>Tag provenance</summary>{(evidence?.tagOrigins || []).map((row, index) => <span className="admin-chip" key={`${row.tag}:${row.provider}:${index}`}>{row.tag} · {row.provider}</span>)}</details>
  </section>;
};
