import test from "node:test";
import assert from "node:assert/strict";

const {
  parseDownloadAllCommand,
  formatBulkQueueSummary,
  createDirectMessageHandler
} = await import("../lib/discord/directMessageRouter.mjs");

test("parseDownloadAllCommand preserves the legacy syntax and validation", () => {
  assert.deepEqual(parseDownloadAllCommand("hello"), {
    matched: false,
    valid: false,
    errors: []
  });

  const parsed = parseDownloadAllCommand("downloadall type:manga nsfw:false titlegroup:a");
  assert.equal(parsed.matched, true);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.filters, {
    type: "Manga",
    nsfw: false,
    titlePrefix: "a",
    batchesPerApproval: 1
  });

  const mega = parseDownloadAllCommand("downloadall type:all nsfw:false titlegroup:all groupsize:5");
  assert.equal(mega.valid, true);
  assert.deepEqual(mega.filters, {
    type: "all",
    nsfw: false,
    titlePrefix: "all",
    batchesPerApproval: 5
  });

  const invalid = parseDownloadAllCommand("downloadall type:bad nsfw:maybe titlegroup:aa");
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /type must be one of/i);
  assert.match(invalid.errors.join(" "), /nsfw must be true or false/i);
  assert.match(invalid.errors.join(" "), /titlegroup must be one letter/i);

  const bangPrefixed = parseDownloadAllCommand("!downloadall type:managa nsfw:no titlegroup:\"b\"");
  assert.equal(bangPrefixed.valid, true);
  assert.deepEqual(bangPrefixed.filters, {
    type: "Manga",
    nsfw: false,
    titlePrefix: "b",
    batchesPerApproval: 1
  });
});

test("direct message handler replies with the schema for downloadall help", async () => {
  const replies = [];
  const handler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "111"}),
    sage: {
      bulkQueueDownload: async () => {
        throw new Error("should not run for help");
      }
    }
  });

  const handled = await handler({
    content: "/downloadall help",
    author: {id: "111", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  });

  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /Use `\/downloadall run type:manga nsfw:false titlegroup:a`/);
  assert.match(replies[0].content, /continue runid/i);
  assert.match(replies[0].content, /Legacy fallback/i);
});

test("formatBulkQueueSummary includes counts and title sections", () => {
  const text = formatBulkQueueSummary({
    status: "queued",
    message: "Queued titles.",
    filters: {type: "Manga", nsfw: false, titlePrefix: "a"},
    pagesScanned: 4,
    matchedCount: 3,
    queuedCount: 2,
    skippedActiveCount: 1,
    skippedAdultContentCount: 1,
    skippedNoMetadataCount: 1,
    skippedAmbiguousMetadataCount: 1,
    failedCount: 0,
    queuedTitles: ["Alya Sometimes Hides Her Feelings in Russian"],
    skippedAdultContentTitles: ["Adult Academy"],
    skippedNoMetadataTitles: ["Ambiguous Academy"],
    skippedAmbiguousMetadataTitles: ["Another World"]
  });

  assert.match(text, /Queued: 2/);
  assert.match(text, /Skipped adult content: 1/);
  assert.match(text, /Skipped no metadata: 1/);
  assert.match(text, /Skipped ambiguous metadata: 1/);
  assert.match(text, /Queued titles/);
  assert.match(text, /Alya Sometimes Hides/);
  assert.match(text, /Adult Academy/);
  assert.match(text, /Ambiguous Academy/);
  assert.match(text, /Another World/);
});

test("direct message handler starts async mega runs for all filters", async () => {
  const replies = [];
  const forwardedPayloads = [];
  const handler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "253987219969146890"}),
    sage: {
      createBulkRun: async (payload) => {
        forwardedPayloads.push(payload);
        return {
          ok: true,
          payload: {
            runId: "bulk-run-1",
            status: "paused",
            message: "Queued the first batch and paused for owner continuation.",
            filters: payload,
            counts: {
              completedBatches: 1,
              remainingBatches: 103,
              queued: 10,
              skipped: 2,
              failed: 0
            }
          }
        };
      }
    }
  });

  await handler({
    content: "downloadall type:all nsfw:false titlegroup:all",
    author: {id: "253987219969146890", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  });

  assert.match(replies[0].content, /async downloadall run/i);
  assert.match(replies[1].content, /Run ID: bulk-run-1/);
  assert.match(replies[1].content, /continue runid:bulk-run-1/);
  assert.deepEqual(forwardedPayloads[0], {
    providerId: "weebcentral",
    type: "all",
    nsfw: false,
    titlePrefix: "all",
    batchesPerApproval: 1,
    groupsize: 1,
    requestedBy: "253987219969146890"
  });
});


test("direct message handler gates by superuser and forwards legacy downloadall filters to durable Sage runs", async () => {
  const replies = [];
  const forwardedPayloads = [];
  const handler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "253987219969146890"}),
    sage: {
      createBulkRun: async (payload) => {
        forwardedPayloads.push(payload);
        return {
          ok: true,
          payload: {
            runId: "bulk-run-2",
            status: "paused",
            message: "First batch queued.",
            filters: payload,
            counts: {
              completedBatches: 1,
              remainingBatches: 0,
              queued: 1,
              skipped: 0,
              failed: 0
            }
          }
        };
      }
    }
  });

  const deniedMessage = {
    content: "downloadall type:manga nsfw:false titlegroup:a",
    author: {id: "111", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  };
  assert.equal(await handler(deniedMessage), true);
  assert.match(replies[0].content, /configured Scriptarr owner/i);

  replies.length = 0;
  const allowedMessage = {
    content: "downloadall type:manga nsfw:false titlegroup:a",
    author: {id: "253987219969146890", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  };
  assert.equal(await handler(allowedMessage), true);
  assert.match(replies[0].content, /Starting Scriptarr async downloadall run/);
  assert.match(replies[1].content, /Run ID: bulk-run-2/);
  assert.deepEqual(forwardedPayloads[0], {
    providerId: "weebcentral",
    type: "Manga",
    nsfw: false,
    titlePrefix: "a",
    batchesPerApproval: 1,
    groupsize: 1,
    requestedBy: "253987219969146890"
  });
});

test("direct message handler respects the enabled toggle and surfaces Sage failures", async () => {
  const replies = [];
  const disabledHandler = createDirectMessageHandler({
    getSettings: () => ({
      superuserId: "253987219969146890",
      commands: {
        downloadall: {enabled: false}
      }
    }),
    sage: {
      createBulkRun: async () => {
        throw new Error("should not run");
      }
    }
  });

  await disabledHandler({
    content: "/downloadall type:manga nsfw:false titlegroup:a",
    author: {id: "253987219969146890", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  });

  assert.match(replies[0].content, /currently disabled/i);

  replies.length = 0;
  const failingHandler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "253987219969146890"}),
    sage: {
      createBulkRun: async () => ({
        ok: false,
        status: 503,
        payload: {
          error: "Raven downloadall run is unavailable."
        }
      })
    }
  });

  await failingHandler({
    content: "/downloadall type:manga nsfw:false titlegroup:a",
    author: {id: "253987219969146890", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  });

  assert.match(replies[0].content, /Starting Scriptarr async downloadall run/i);
  assert.match(replies[1].content, /downloadall run failed/i);
  assert.match(replies[1].content, /Raven downloadall run is unavailable/i);
});

test("direct message handler splits large durable run summaries into multiple replies", async () => {
  const replies = [];
  const oversizedTitles = Array.from(
    {length: 80},
    (_, index) => `A very long queued title number ${index + 1} with a deliberately oversized label for chunking coverage`
  );
  const handler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "253987219969146890"}),
    sage: {
      createBulkRun: async (payload) => ({
        ok: true,
        payload: {
          runId: "bulk-run-long",
          status: "paused",
          message: oversizedTitles.join(" "),
          filters: payload,
          counts: {
            completedBatches: 1,
            remainingBatches: 0,
            queued: oversizedTitles.length,
            skipped: 0,
            failed: 0
          }
        }
      })
    }
  });

  await handler({
    content: "downloadall type:manhwa nsfw:false titlegroup:a",
    author: {id: "253987219969146890", bot: false},
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  });

  assert.ok(replies.length >= 3);
  assert.match(replies[0].content, /Starting Scriptarr async downloadall run/i);
  assert.ok(replies.slice(1).every((payload) => payload.content.length <= 1800));
  assert.match(replies.slice(1).map((payload) => payload.content).join("\n"), /Run ID: bulk-run-long/i);
});
