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
    failedCount: 0,
    queuedTitles: ["Alya Sometimes Hides Her Feelings in Russian"]
  });

  assert.match(text, /Queued: 2/);
  assert.match(text, /Queued titles/);
  assert.match(text, /Alya Sometimes Hides/);
});

test("direct message handler gates by superuser and forwards legacy downloadall filters to Sage", async () => {
  const replies = [];
  const handler = createDirectMessageHandler({
    getSettings: () => ({superuserId: "253987219969146890"}),
    sage: {
      bulkQueueDownload: async (payload) => ({
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
      })
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
});
