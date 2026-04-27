import assert from "node:assert/strict";
import test from "node:test";

import {buildReleaseChannelPayload, createFollowNotifier} from "../lib/followNotifier.mjs";

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
              id: "release:task-1",
              channelId: "channel-1",
              titleName: "Dandadan",
              chapterLabel: "Chapter 42",
              readerUrl: "https://pax-kun.com/reader/manga/title/chapter"
            }]
          }
        };
      },
      async acknowledgeReleaseNotification(id) {
        acked.push(id);
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
  assert.equal(acked[0], "release:task-1");
});
