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
    titlePrefix: "a"
  });

  const invalid = parseDownloadAllCommand("downloadall type:bad nsfw:maybe");
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /type must be one of/i);
  assert.match(invalid.errors.join(" "), /nsfw must be true or false/i);

  const bangPrefixed = parseDownloadAllCommand("!downloadall type:managa nsfw:no titlegroup:\"ab\"");
  assert.equal(bangPrefixed.valid, true);
  assert.deepEqual(bangPrefixed.filters, {
    type: "Manga",
    nsfw: false,
    titlePrefix: "ab"
  });
});

test("direct message handler replies with the schema for downloadall help", async () => {
  const replies = [];
  const handler = createDirectMessageHandler({
    getSettings: () => ({}),
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
  assert.match(replies[0].content, /Use `downloadall type:manga nsfw:false titlegroup:a`/);
  assert.match(replies[0].content, /Supported `type` values/i);
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
    skippedNoMetadataCount: 1,
    skippedAmbiguousMetadataCount: 1,
    failedCount: 0,
    queuedTitles: ["Alya Sometimes Hides Her Feelings in Russian"],
    skippedNoMetadataTitles: ["Ambiguous Academy"],
    skippedAmbiguousMetadataTitles: ["Another World"]
  });

  assert.match(text, /Queued: 2/);
  assert.match(text, /Skipped no metadata: 1/);
  assert.match(text, /Skipped ambiguous metadata: 1/);
  assert.match(text, /Queued titles/);
  assert.match(text, /Alya Sometimes Hides/);
  assert.match(text, /Ambiguous Academy/);
  assert.match(text, /Another World/);
});

test("direct message handler gates by superuser and forwards legacy downloadall filters to Sage", async () => {
  const replies = [];
  const forwardedPayloads = [];
  const handler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "253987219969146890"}),
    sage: {
      bulkQueueDownload: async (payload) => {
        forwardedPayloads.push(payload);
        return {
        ok: true,
        payload: {
          status: "queued",
          message: "Bulk queue submitted.",
          filters: payload,
          queuedCount: 1,
          matchedCount: 1,
          pagesScanned: 1,
          skippedActiveCount: 0,
          failedCount: 0,
          queuedTitles: ["Dandadan"]
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
  assert.match(replies[0].content, /configured .* superuser/i);

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
  assert.match(replies[0].content, /Queueing Scriptarr bulk download/);
  assert.match(replies[1].content, /Bulk queue submitted/);
  assert.deepEqual(forwardedPayloads[0], {
    providerId: "weebcentral",
    type: "Manga",
    nsfw: false,
    titlePrefix: "a",
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
      bulkQueueDownload: async () => {
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
      bulkQueueDownload: async () => ({
        ok: false,
        status: 503,
        payload: {
          error: "Raven bulk queue is unavailable."
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

  assert.match(replies[0].content, /Queueing Scriptarr bulk download/i);
  assert.match(replies[1].content, /bulk queue failed/i);
  assert.match(replies[1].content, /Raven bulk queue is unavailable/i);
});
