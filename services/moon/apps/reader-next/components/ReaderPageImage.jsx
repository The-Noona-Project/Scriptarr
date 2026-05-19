"use client";

/**
 * @file Reader page image with a visible retry state for failed page loads.
 */

import {useEffect, useRef, useState} from "react";
import {requestJson} from "../lib/api.js";
import {
  buildReaderPageStatusUrl,
  resolveReaderImageRetryDelay,
  shouldAutoRetryReaderImage
} from "../lib/imageRetry.js";
import {readerTelemetryNow, recordReaderTelemetry} from "../lib/readerTelemetry.js";

/**
 * Render one reader page image and expose a retry if the browser fails it.
 *
 * @param {{page: {index: number, label?: string, src?: string, missing?: boolean}, chapterId: string, titleId?: string, layoutMode?: string, showPageNumbers?: boolean, eager?: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderPageImage = ({page, chapterId, titleId = "", layoutMode = "", showPageNumbers = true, eager = false}) => {
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const [failureReason, setFailureReason] = useState("");
  const imageStartedAtRef = useRef(readerTelemetryNow());
  const retryTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const failureSeqRef = useRef(0);

  useEffect(() => {
    imageStartedAtRef.current = readerTelemetryNow();
  }, [page?.src, retryKey]);

  useEffect(() => {
    setFailed(false);
    setRetrying(false);
    setAutoRetryCount(0);
    setFailureReason("");
    failureSeqRef.current += 1;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [page?.src]);

  useEffect(() => () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const probePageStatus = async () => {
    const statusUrl = buildReaderPageStatusUrl(page?.src || "");
    if (!statusUrl) {
      return {ok: false, reason: "probe_unavailable", status: 0};
    }
    const startedAt = readerTelemetryNow();
    const result = await requestJson(statusUrl);
    const payload = result.payload || {};
    const reason = payload.failureCode || payload.reason || (result.ok ? "probe_unknown" : "probe_unavailable");
    const pageOk = result.ok && payload.ok === true;
    const cacheState = String(payload.cacheState || (payload.cacheHit === true ? "hit" : payload.cacheHit === false ? "miss" : "")).trim();
    recordReaderTelemetry({
      type: "page-probe",
      titleId,
      chapterId,
      layoutMode,
      pageIndex: page.index,
      ok: pageOk,
      status: Number.parseInt(String(payload.status || result.status || 0), 10) || 0,
      durationMs: readerTelemetryNow() - startedAt,
      reason,
      phase: payload.source || ""
    });
    if (cacheState === "hit" || cacheState === "miss") {
      recordReaderTelemetry({
        type: cacheState === "hit" ? "page-cache-hit" : "page-cache-miss",
        titleId,
        chapterId,
        layoutMode,
        pageIndex: page.index,
        ok: pageOk,
        durationMs: 0,
        reason: pageOk ? "" : reason
      });
    }
    return {
      ok: pageOk,
      reason,
      status: Number.parseInt(String(payload.status || result.status || 0), 10) || 0
    };
  };

  if (page?.missing || !page?.src) {
    return (
      <figure className="reader-page-frame reader-page-placeholder">
        <div className="reader-skeleton-page" />
      </figure>
    );
  }

  return (
    <figure
      className={`reader-page-frame ${failed ? "has-image-error" : ""}`.trim()}
      data-reader-page
      data-chapter-id={chapterId}
      data-page-index={page.index}
    >
      {failed ? (
        <div className="reader-page-retry">
          <strong>Page {page.index + 1} did not load.</strong>
          {failureReason ? <span>{failureReason.replace(/_/g, " ")}</span> : null}
          <button
            type="button"
            onClick={() => {
              recordReaderTelemetry({
                type: "image-retry",
                titleId,
                chapterId,
                layoutMode,
                pageIndex: page.index,
                retryCount: retryKey + 1,
                reason: "visible_retry"
              });
              setFailed(false);
              setRetrying(false);
              setAutoRetryCount(0);
              setFailureReason("");
              setRetryKey((value) => value + 1);
            }}
          >
            Retry page
          </button>
        </div>
      ) : retrying ? (
        <div className="reader-page-retry" role="status" aria-live="polite">
          <strong>Retrying page {page.index + 1}.</strong>
        </div>
      ) : (
        <img
          key={`${page.src}:${retryKey}`}
          src={page.src}
          alt={page.label || `Page ${page.index + 1}`}
          draggable="false"
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={eager ? "high" : "auto"}
          onLoad={(event) => {
            failureSeqRef.current += 1;
            setFailed(false);
            setRetrying(false);
            setAutoRetryCount(0);
            setFailureReason("");
            const imageLoadMs = readerTelemetryNow() - imageStartedAtRef.current;
            recordReaderTelemetry({
              type: "image-stream-fetch",
              titleId,
              chapterId,
              layoutMode,
              pageIndex: page.index,
              ok: true,
              durationMs: imageLoadMs
            });
            if (typeof event.currentTarget.decode !== "function") {
              return;
            }
            const decodeStartedAt = readerTelemetryNow();
            void event.currentTarget.decode().then(() => {
              recordReaderTelemetry({
                type: "image-decode",
                titleId,
                chapterId,
                layoutMode,
                pageIndex: page.index,
                ok: true,
                durationMs: readerTelemetryNow() - decodeStartedAt,
                imageLoadMs
              });
            }, () => {
              recordReaderTelemetry({
                type: "image-decode",
                titleId,
                chapterId,
                layoutMode,
                pageIndex: page.index,
                ok: false,
                durationMs: readerTelemetryNow() - decodeStartedAt,
                imageLoadMs,
                reason: "decode_failed"
              });
            });
          }}
          onError={() => {
            failureSeqRef.current += 1;
            const failureSeq = failureSeqRef.current;
            const nextAttempt = autoRetryCount + 1;
            const imageErrorDurationMs = readerTelemetryNow() - imageStartedAtRef.current;
            recordReaderTelemetry({
              type: "image-stream-fetch",
              titleId,
              chapterId,
              layoutMode,
              pageIndex: page.index,
              ok: false,
              durationMs: imageErrorDurationMs,
              reason: "image_error"
            });
            const probe = probePageStatus().catch(() => ({ok: false, reason: "probe_unavailable", status: 0}));
            if (shouldAutoRetryReaderImage(nextAttempt)) {
              setAutoRetryCount(nextAttempt);
              setRetrying(true);
              recordReaderTelemetry({
                type: "image-auto-retry",
                titleId,
                chapterId,
                layoutMode,
                pageIndex: page.index,
                ok: false,
                retryCount: nextAttempt,
                durationMs: imageErrorDurationMs,
                reason: "image_error"
              });
              retryTimerRef.current = setTimeout(() => {
                if (failureSeqRef.current !== failureSeq) {
                  return;
                }
                setRetrying(false);
                setRetryKey((value) => value + 1);
              }, resolveReaderImageRetryDelay(nextAttempt));
              return;
            }
            void probe.then((probeResult) => {
              if (failureSeqRef.current !== failureSeq) {
                return;
              }
              setFailureReason(probeResult.reason || "image_error");
              recordReaderTelemetry({
                type: "image-retry",
                titleId,
                chapterId,
                layoutMode,
                pageIndex: page.index,
                ok: false,
                retryCount: nextAttempt,
                durationMs: imageErrorDurationMs,
                reason: probeResult.reason || "image_error"
              });
              setRetrying(false);
              setFailed(true);
            });
          }}
        />
      )}
      {showPageNumbers ? <figcaption>{page.index + 1}</figcaption> : null}
    </figure>
  );
};

export default ReaderPageImage;
