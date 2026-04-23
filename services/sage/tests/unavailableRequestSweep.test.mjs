/**
 * @file Scriptarr Sage module: services/sage/tests/unavailableRequestSweep.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {getUnavailableRequestSweepIntervalMs, runUnavailableRequestSweep} = await import("../lib/unavailableRequestSweep.mjs");

test("unavailable request sweep keeps the 4 hour cadence", () => {
  assert.equal(getUnavailableRequestSweepIntervalMs(), 4 * 60 * 60 * 1000);
});

test("unavailable request sweep expires stale requests, marks source-found matches, and clears stale options", async () => {
  const now = Date.now();
  const updates = [];
  const warnings = [];
  const requests = [
    {
      id: "1",
      title: "Expired Title",
      status: "unavailable",
      createdAt: new Date(now - (91 * 24 * 60 * 60 * 1000)).toISOString(),
      details: {
        query: "expired title",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-expired",
          title: "Expired Title"
        }
      }
    },
    {
      id: "2",
      title: "Source Found",
      status: "unavailable",
      createdAt: new Date(now - (2 * 24 * 60 * 60 * 1000)).toISOString(),
      details: {
        query: "source found",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-source",
          title: "Source Found"
        }
      }
    },
    {
      id: "3",
      title: "Source Lost",
      status: "unavailable",
      createdAt: new Date(now - (2 * 24 * 60 * 60 * 1000)).toISOString(),
      details: {
        query: "source lost",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-clear",
          title: "Source Lost"
        },
        sourceFoundAt: "2026-04-20T00:00:00.000Z",
        sourceFoundOptions: [{
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/source-lost"
        }]
      }
    }
  ];

  const sweepResult = await runUnavailableRequestSweep({
    config: {
      ravenBaseUrl: "http://raven.invalid"
    },
    vaultClient: {
      async listRequests() {
        return requests;
      },
      async updateRequest(requestId, payload) {
        updates.push({requestId, payload});
        return {
          id: requestId,
          ...payload
        };
      }
    },
    serviceJson: async (_baseUrl, _path, options = {}) => {
      const metadataId = options.body?.selectedMetadata?.providerSeriesId;
      if (metadataId === "md-source") {
        return {
          ok: true,
          status: 200,
          payload: {
            results: [{
              providerId: "weebcentral",
              providerName: "WeebCentral",
              titleName: "Source Found",
              titleUrl: "https://weebcentral.com/series/source-found",
              requestType: "manga",
              libraryTypeLabel: "Manga",
              libraryTypeSlug: "manga"
            }]
          }
        };
      }
      return {
        ok: true,
        status: 200,
        payload: {
          results: []
        }
      };
    },
    logger: {
      warn(message, payload) {
        warnings.push({message, payload});
      }
    },
    async readRequestWorkflowSettings() {
      return {
        autoApproveAndDownload: false
      };
    }
  });

  assert.deepEqual(sweepResult, {
    expiredCount: 1,
    sourceFoundCount: 1,
    clearedCount: 1
  });
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    updates.map((entry) => entry.requestId),
    ["1", "2", "3"]
  );
  assert.equal(updates[0].payload.status, "expired");
  assert.equal(updates[1].payload.eventType, "source-found");
  assert.equal(updates[1].payload.detailsMerge.sourceFoundOptions[0].providerId, "weebcentral");
  assert.deepEqual(updates[2].payload.detailsMerge, {
    sourceFoundAt: "",
    sourceFoundOptions: []
  });
});
