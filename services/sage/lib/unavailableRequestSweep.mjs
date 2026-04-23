/**
 * Background reconciliation for unavailable Scriptarr requests.
 */

import {
  normalizeArray,
  normalizeObject,
  normalizeString,
  selectAutoApproveDownload
} from "./requestFlow.mjs";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const serializeSourceOptions = (value) => JSON.stringify(
  normalizeArray(value).map((entry) => ({
    providerId: normalizeString(entry?.providerId),
    providerName: normalizeString(entry?.providerName),
    titleName: normalizeString(entry?.titleName),
    titleUrl: normalizeString(entry?.titleUrl),
    requestType: normalizeString(entry?.requestType),
    libraryTypeLabel: normalizeString(entry?.libraryTypeLabel),
    libraryTypeSlug: normalizeString(entry?.libraryTypeSlug)
  }))
);

const isOlderThan = (value, ageMs) => {
  const parsed = Date.parse(normalizeString(value));
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return parsed <= Date.now() - ageMs;
};

/**
 * Re-check unavailable requests, promoting source-found state or expiring stale
 * requests after 90 days.
 *
 * @param {{
 *   config: Record<string, string>,
 *   vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>,
 *   serviceJson: (baseUrl: string, path: string, options?: {method?: string, body?: unknown, headers?: Record<string, string>}) => Promise<{ok: boolean, status: number, payload: any}>,
 *   logger?: {warn?: Function, error?: Function},
 *   readRequestWorkflowSettings: () => Promise<Record<string, unknown>>
 * }} options
 * @returns {Promise<{expiredCount: number, sourceFoundCount: number, clearedCount: number}>}
 */
export const runUnavailableRequestSweep = async ({
  config,
  vaultClient,
  serviceJson,
  logger,
  readRequestWorkflowSettings
}) => {
  const requests = normalizeArray(await vaultClient.listRequests())
    .filter((request) => normalizeString(request?.status).toLowerCase() === "unavailable");
  let expiredCount = 0;
  let sourceFoundCount = 0;
  let clearedCount = 0;

  for (const request of requests) {
    const requestId = normalizeString(request?.id);
    const details = normalizeObject(request?.details, {}) || {};
    const selectedMetadata = normalizeObject(details.selectedMetadata);
    if (!requestId || !selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      continue;
    }

    if (isOlderThan(request?.createdAt, NINETY_DAYS_MS)) {
      await vaultClient.updateRequest(requestId, {
        status: "expired",
        eventType: "expired",
        eventMessage: "Scriptarr expired this unavailable request after 90 days without a stable download source.",
        actor: "scriptarr-sage",
        detailsMerge: {
          sourceFoundAt: "",
          sourceFoundOptions: []
        }
      });
      expiredCount += 1;
      continue;
    }

    const result = await serviceJson(config.ravenBaseUrl, "/v1/intake/download-options", {
      method: "POST",
      body: {
        query: normalizeString(details.query, normalizeString(selectedMetadata.title, normalizeString(request?.title))),
        selectedMetadata
      }
    }).catch((error) => ({
      ok: false,
      status: 503,
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    }));

    if (!result.ok) {
      logger?.warn?.("Unavailable request sweep could not load download options.", {
        requestId,
        status: result.status,
        error: result.payload?.error
      });
      continue;
    }

    const nextOptions = normalizeArray(result.payload?.results);
    const currentOptions = normalizeArray(details.sourceFoundOptions);
    if (nextOptions.length) {
      const workflowSettings = await readRequestWorkflowSettings();
      const autoSelectedDownload = workflowSettings?.autoApproveAndDownload
        ? selectAutoApproveDownload(nextOptions)
        : null;
      const optionsChanged = serializeSourceOptions(nextOptions) !== serializeSourceOptions(currentOptions);
      const shouldEmitSourceFound = !normalizeString(details.sourceFoundAt);
      if (autoSelectedDownload?.titleUrl) {
        await vaultClient.updateRequest(requestId, {
          title: normalizeString(selectedMetadata.title, request.title),
          requestType: normalizeString(autoSelectedDownload.requestType, request.requestType),
          status: "pending",
          actor: "scriptarr-sage",
          appendStatusEvent: false,
          detailsMerge: {
            selectedMetadata,
            selectedDownload: autoSelectedDownload,
            availability: "available",
            sourceFoundAt: normalizeString(details.sourceFoundAt, new Date().toISOString()),
            sourceFoundOptions: nextOptions
          }
        });

        const queued = await serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
          method: "POST",
          body: {
            titleName: normalizeString(autoSelectedDownload.titleName, normalizeString(selectedMetadata.title, request.title)),
            titleUrl: normalizeString(autoSelectedDownload.titleUrl),
            requestType: normalizeString(autoSelectedDownload.requestType, request.requestType || "manga"),
            providerId: normalizeString(autoSelectedDownload.providerId),
            requestId: String(requestId),
            requestedBy: normalizeString(request.requestedBy),
            selectedMetadata,
            selectedDownload: autoSelectedDownload
          }
        }).catch((error) => ({
          ok: false,
          status: 503,
          payload: {
            error: error instanceof Error ? error.message : String(error)
          }
        }));

        if (queued.ok) {
          await vaultClient.updateRequest(requestId, {
            status: "queued",
            eventType: "approved",
            eventMessage: "Scriptarr auto-approved and queued this request after a high-confidence source appeared.",
            actor: "scriptarr-sage",
            appendStatusEvent: false,
            detailsMerge: {
              selectedMetadata,
              selectedDownload: autoSelectedDownload,
              availability: "available",
              sourceFoundAt: "",
              sourceFoundOptions: [],
              jobId: normalizeString(queued.payload?.jobId),
              taskId: normalizeString(queued.payload?.taskId)
            }
          });
        } else {
          logger?.warn?.("Unavailable request sweep auto-approve queue failed.", {
            requestId,
            status: queued.status,
            error: queued.payload?.error
          });
        }
        sourceFoundCount += 1;
        continue;
      }

      if (optionsChanged || shouldEmitSourceFound) {
        await vaultClient.updateRequest(requestId, {
          status: "pending",
          actor: "scriptarr-sage",
          eventType: shouldEmitSourceFound ? "source-found" : "",
          eventMessage: shouldEmitSourceFound
            ? "Scriptarr found at least one concrete download source for this request and returned it to admin review."
            : "",
          detailsMerge: {
            selectedDownload: null,
            availability: "available",
            sourceFoundAt: normalizeString(details.sourceFoundAt, new Date().toISOString()),
            sourceFoundOptions: nextOptions
          },
          appendStatusEvent: false
        });
        sourceFoundCount += 1;
      }
      continue;
    }

    if (currentOptions.length || normalizeString(details.sourceFoundAt)) {
      await vaultClient.updateRequest(requestId, {
        actor: "scriptarr-sage",
        appendStatusEvent: false,
        detailsMerge: {
          sourceFoundAt: "",
          sourceFoundOptions: []
        }
      });
      clearedCount += 1;
    }
  }

  return {
    expiredCount,
    sourceFoundCount,
    clearedCount
  };
};

/**
 * Expose the 4-hour sweep cadence for runtime setup and tests.
 *
 * @returns {number}
 */
export const getUnavailableRequestSweepIntervalMs = () => FOUR_HOURS_MS;

export default {
  getUnavailableRequestSweepIntervalMs,
  runUnavailableRequestSweep
};
