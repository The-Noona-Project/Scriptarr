import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDownloadAllDirectMessagePayload,
  buildReleaseChannelPayload,
  createFollowNotifier
} from "../lib/followNotifier.mjs";

const waitFor = async (predicate, timeoutMs = 500) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("release channel payload includes title, chapter, and read link", () => {
  const payload = buildReleaseChannelPayload({
    titleName: "Dandadan",
    chapterLabel: "Chapter 42",
    readerUrl: "https://pax-kun.com/reader/manga/title/chapter"
  });

  assert.match(payload.content, /Dandadan/);
  assert.match(payload.content, /Chapter 42/);
  assert.match(payload.content, /https:\/\/pax-kun.com\/reader/);
});

test("release digest payload uses compact branded copy", () => {
  const payload = buildReleaseChannelPayload({
    digest: true,
    totalCount: 12,
    hiddenCount: 2,
    items: [{
      titleName: "Burn the Witch",
      chapterLabel: "Chapter 1",
      linkUrl: "https://pax-kun.com/reader/manga/chapter-1",
      coverUrl: "https://pax-kun.com/cover.jpg"
    }, {
      titleName: "Dandadan",
      chapterLabel: "Raven download completed.",
      linkUrl: "https://pax-kun.com/reader/manga/chapter-2"
    }]
  }, "https://pax-kun.com", "Scriptarr");

  assert.match(payload.content, /12 new Scriptarr releases/);
  assert.match(payload.content, /\+2 more/);
  assert.match(payload.embeds[0].description, /Burn the Witch/);
  assert.match(payload.embeds[0].description, /Dandadan/);
  assert.doesNotMatch(payload.content, /Raven/);
  assert.doesNotMatch(payload.embeds[0].description, /Raven/);
  assert.equal(Boolean(payload.embeds[0].image), false);
  assert.equal(payload.embeds[0].thumbnail.url, "https://pax-kun.com/cover.jpg");
});

test("downloadall payload uses compact content and grouped embed fields", () => {
  const payload = buildDownloadAllDirectMessagePayload({
    status: "paused",
    runId: "bulkrun_cae17f4559204bb1bdc449632596bda0",
    batchesPerApproval: 5,
    linkUrl: "https://pax-kun.com/admin/activity/queue",
    summary: {
      completedBatches: 5,
      remainingBatches: 99,
      completedTitles: 149,
      queued: 622,
      appended: 38,
      skippedCompleted: 515,
      skippedCurrent: 330,
      failedTitles: 473,
      staleTitles: 0,
      currentBatchLabel: "B Manga"
    }
  }, "https://pax-kun.com");

  assert.match(payload.content, /Downloadall paused after 5 batch/);
  assert.match(payload.content, /React ✅/);
  assert.doesNotMatch(payload.content, /queued 622, appended 38, skipped 515/);
  assert.equal(payload.embeds[0].title, "Scriptarr downloadall Paused");
  assert.equal(payload.embeds[0].url, "https://pax-kun.com/admin/activity/queue");
  assert.equal(payload.embeds[0].fields.some((field) => field.name === "Progress" && /99/.test(field.value)), true);
  assert.equal(payload.embeds[0].fields.some((field) => field.name === "Needs attention" && /473/.test(field.value)), true);
  assert.equal(payload.embeds[0].fields.some((field) => field.name === "Next action" && /next \*\*5\*\*/i.test(field.value)), true);
});

test("portal release notifier sends channel messages and acks after delivery", async () => {
  const sent = [];
  const acked = [];
  const notifier = createFollowNotifier({
    sage: {
      async listFollowNotifications() {
        return {ok: true, payload: {notifications: []}};
      },
      async acknowledgeFollowNotification() {},
      async listRequestNotifications() {
        return {ok: true, payload: {notifications: []}};
      },
      async acknowledgeRequestNotification() {},
      async listSystemNotifications() {
        return {ok: true, payload: {notifications: []}};
      },
      async acknowledgeSystemNotification() {},
      async listReleaseNotifications() {
        return {
          ok: true,
          payload: {
            notifications: [{
              id: "release:digest:task-1:2",
              channelId: "channel-1",
              digest: true,
              totalCount: 2,
              hiddenCount: 0,
              newestCompletedAt: "2026-05-16T00:02:00.000Z",
              silenceThrough: "2026-05-16T00:02:00.000Z",
              ackItemIds: ["release:task-1", "release:task-2"],
              items: [{
                id: "release:task-1",
                titleName: "Dandadan",
                chapterLabel: "Chapter 42",
                readerUrl: "https://pax-kun.com/reader/manga/title/chapter"
              }, {
                id: "release:task-2",
                titleName: "Sakamoto Days",
                chapterLabel: "Chapter 43"
              }]
            }]
          }
        };
      },
      async acknowledgeReleaseNotification(id, payload) {
        acked.push({id, payload});
      }
    },
    discord: {
      async sendDirectMessage() {},
      async sendChannelMessage(channelId, payload) {
        sent.push({channelId, payload});
      }
    },
    logger: {error() {}},
    publicBaseUrl: "https://pax-kun.com",
    pollMs: 1000
  });

  notifier.start();
  await waitFor(() => acked.length > 0);
  notifier.stop();

  assert.equal(sent[0].channelId, "channel-1");
  assert.equal(acked[0].id, "release:digest:task-1:2");
  assert.deepEqual(acked[0].payload.ackItemIds, ["release:task-1", "release:task-2"]);
  assert.equal(acked[0].payload.silenceThrough, "2026-05-16T00:02:00.000Z");
});

test("portal release notifier does not ack when Discord send fails", async () => {
  const acked = [];
  const notifier = createFollowNotifier({
    sage: {
      async listFollowNotifications() {
        return {ok: true, payload: {notifications: []}};
      },
      async acknowledgeFollowNotification() {},
      async listRequestNotifications() {
        return {ok: true, payload: {notifications: []}};
      },
      async acknowledgeRequestNotification() {},
      async listSystemNotifications() {
        return {ok: true, payload: {notifications: []}};
      },
      async acknowledgeSystemNotification() {},
      async listReleaseNotifications() {
        return {
          ok: true,
          payload: {
            notifications: [{
              id: "release:digest:task-1:1",
              channelId: "channel-1",
              digest: true,
              totalCount: 1,
              ackItemIds: ["release:task-1"],
              silenceThrough: "2026-05-16T00:02:00.000Z",
              items: [{
                id: "release:task-1",
                titleName: "Dandadan",
                chapterLabel: "Chapter 42"
              }]
            }]
          }
        };
      },
      async acknowledgeReleaseNotification(id, payload) {
        acked.push({id, payload});
      }
    },
    discord: {
      async sendDirectMessage() {},
      async sendChannelMessage() {
        throw new Error("Discord rejected message.");
      }
    },
    logger: {error() {}},
    publicBaseUrl: "https://pax-kun.com",
    pollMs: 1000
  });

  notifier.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  notifier.stop();

  assert.deepEqual(acked, []);
});
