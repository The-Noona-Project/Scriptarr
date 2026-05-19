"use client";

/**
 * @file Reader page image with a visible retry state for failed page loads.
 */

import {useEffect, useRef, useState} from "react";
import {readerTelemetryNow, recordReaderTelemetry} from "../lib/readerTelemetry.js";

/**
 * Render one reader page image and expose a retry if the browser fails it.
 *
 * @param {{page: {index: number, label?: string, src?: string, missing?: boolean}, chapterId: string, titleId?: string, layoutMode?: string, showPageNumbers?: boolean, eager?: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderPageImage = ({page, chapterId, titleId = "", layoutMode = "", showPageNumbers = true, eager = false}) => {
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const imageStartedAtRef = useRef(readerTelemetryNow());

  useEffect(() => {
    imageStartedAtRef.current = readerTelemetryNow();
  }, [page?.src, retryKey]);

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
              setRetryKey((value) => value + 1);
            }}
          >
            Retry page
          </button>
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
            recordReaderTelemetry({
              type: "image-stream-fetch",
              titleId,
              chapterId,
              layoutMode,
              pageIndex: page.index,
              ok: false,
              durationMs: readerTelemetryNow() - imageStartedAtRef.current,
              reason: "image_error"
            });
            setFailed(true);
          }}
        />
      )}
      {showPageNumbers ? <figcaption>{page.index + 1}</figcaption> : null}
    </figure>
  );
};

export default ReaderPageImage;
