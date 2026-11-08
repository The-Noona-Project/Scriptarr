import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {createSageClient} from "../lib/sageClient.mjs";

test("bulkQueueDownload retries one transient fetch failure before surfacing success", async () => {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    hits += 1;

    if (hits === 1) {
      req.socket.destroy();
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/internal/portal/downloads/bulk-queue");
    assert.equal(req.headers.authorization, "Bearer portal-service-token");
    assert.deepEqual(body, {
      providerId: "weebcentral",
      type: "Manhwa",
      nsfw: false,
      titlePrefix: "a",
      requestedBy: "253987219969146890"
    });

    res.writeHead(202, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      status: "partial",
      message: "Recovered after a retry."
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token"
  });

  try {
    const response = await sage.bulkQueueDownload({
      providerId: "weebcentral",
      type: "Manhwa",
      nsfw: false,
      titlePrefix: "a",
      requestedBy: "253987219969146890"
    });

    assert.equal(response.ok, true);
    assert.equal(response.status, 202);
    assert.deepEqual(response.payload, {
      status: "partial",
      message: "Recovered after a retry."
    });
    assert.equal(hits, 2);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("getDiscordSettings retries transient Sage settings fetch failures", async () => {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    hits += 1;

    if (hits === 1) {
      req.socket.destroy();
      return;
    }

    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/internal/portal/discord/settings");
    assert.equal(req.headers.authorization, "Bearer portal-service-token");

    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      guildId: "guild-1",
      appa: {enabled: true}
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token",
    discordSettingsTimeoutMs: 250,
    discordSettingsRetries: 2,
    discordSettingsRetryDelayMs: 1
  });

  try {
    const response = await sage.getDiscordSettings();

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.payload.guildId, "guild-1");
    assert.equal(response.payload.appa.enabled, true);
    assert.equal(hits, 2);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("bulkQueueDownload times out when Sage never answers", async () => {
  const server = http.createServer(() => {
    // Intentionally leave the request hanging to simulate a stalled broker call.
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token",
    bulkQueueTimeoutMs: 50
  });

  try {
    await assert.rejects(
      () => sage.bulkQueueDownload({
        providerId: "weebcentral",
        type: "Manga",
        nsfw: false,
        titlePrefix: "a",
        requestedBy: "253987219969146890"
      }),
      /timed out/i
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("bulk run helpers call the Sage async downloadall broker routes", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    seen.push({method: req.method, url: req.url, body});
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      runId: "bulk-run-1",
      status: req.url.endsWith("/cancel") ? "cancelled" : "paused"
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token"
  });

  try {
    await sage.createBulkRun({
      providerId: "weebcentral",
      type: "all",
      nsfw: false,
      titlePrefix: "all",
      requestedBy: "253987219969146890"
    });
    await sage.getBulkRunStatus("bulk-run-1");
    await sage.continueBulkRun("bulk-run-1", {requestedBy: "owner-1"});
    await sage.cancelBulkRun("bulk-run-1", {requestedBy: "owner-1"});
    await sage.recordDownloadAllDecisionPrompt("downloadall:bulk-run-1:batch-1:paused", {
      messageId: "dm-1",
      runId: "bulk-run-1",
      ownerDiscordUserId: "owner-1"
    });
    await sage.decideDownloadAllPrompt({
      messageId: "dm-1",
      userId: "owner-1",
      emoji: "✅"
    });

    assert.deepEqual(seen.map((entry) => [entry.method, entry.url]), [
      ["POST", "/api/internal/portal/downloads/bulk-runs"],
      ["GET", "/api/internal/portal/downloads/bulk-runs/bulk-run-1"],
      ["POST", "/api/internal/portal/downloads/bulk-runs/bulk-run-1/continue"],
      ["POST", "/api/internal/portal/downloads/bulk-runs/bulk-run-1/cancel"],
      ["POST", "/api/internal/portal/notifications/downloadall/downloadall%3Abulk-run-1%3Abatch-1%3Apaused/prompt"],
      ["POST", "/api/internal/portal/downloads/bulk-runs/decision"]
    ]);
    assert.equal(seen[0].body.providerId, "weebcentral");
    assert.deepEqual(seen[2].body, {requestedBy: "owner-1"});
    assert.deepEqual(seen[3].body, {requestedBy: "owner-1"});
    assert.equal(seen[4].body.messageId, "dm-1");
    assert.deepEqual(seen[5].body, {messageId: "dm-1", userId: "owner-1", emoji: "✅"});
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("downloadall delivery clients preserve receipts, expose HTTP errors, and bound stalled phases", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: req.headers.authorization});
    if (req.url.endsWith("/ack")) return;
    res.writeHead(req.url.endsWith("/prompt") ? 503 : 200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({ok: !req.url.endsWith("/prompt")}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sage = createSageClient({sageBaseUrl: `http://127.0.0.1:${server.address().port}`, serviceToken: "test-only", downloadAllNotificationTimeoutMs: 100});
  try {
    await sage.beginDownloadAllDelivery("downloadall:run:window:paused", {botIdentity: "noona"});
    await sage.recordDownloadAllDelivery("downloadall:run:window:paused", {messageId: "message", channelId: "channel"});
    assert.equal((await sage.recordDownloadAllDecisionPrompt("downloadall:run:window:paused", {messageId: "message"})).ok, false);
    await assert.rejects(sage.acknowledgeDownloadAllNotification("downloadall:run:window:paused"), /timed out/);
    assert.match(seen[0].path, /downloadall%3Arun%3Awindow%3Apaused\/begin$/);
    assert.deepEqual(seen[1].body, {messageId: "message", channelId: "channel"});
    assert.equal(seen.every((entry) => entry.authorization === "Bearer test-only"), true);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("ingest helpers call the Sage preview and run broker routes", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    seen.push({method: req.method, url: req.url, authorization: req.headers.authorization, body});
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      status: req.url.endsWith("/runs") ? "started" : "preview",
      runId: req.url.endsWith("/runs") ? "ingest-run-1" : undefined,
      previewId: req.url.endsWith("/preview") ? "preview-1" : undefined,
      notifications: req.url.endsWith("/ingest-runs") ? [] : undefined,
      ok: true
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token"
  });

  try {
    await sage.previewIngestRun({
      type: "webtoon",
      requestedBy: "admin-1",
      source: "discord-appa-slash"
    });
    await sage.runIngest({
      type: "webtoon",
      requestedBy: "admin-1",
      confirmedBy: "admin-1",
      previewId: "preview-1"
    });
    await sage.listIngestRunNotifications();
    await sage.acknowledgeIngestRunNotification("ingest:ingestrun_1:25");

    assert.deepEqual(seen.map((entry) => [entry.method, entry.url]), [
      ["POST", "/api/internal/portal/library/ingest/preview"],
      ["POST", "/api/internal/portal/library/ingest/runs"],
      ["GET", "/api/internal/portal/notifications/ingest-runs"],
      ["POST", "/api/internal/portal/notifications/ingest-runs/ingest%3Aingestrun_1%3A25/ack"]
    ]);
    assert.equal(seen[0].authorization, "Bearer portal-service-token");
    assert.deepEqual(seen[0].body, {
      type: "webtoon",
      requestedBy: "admin-1",
      source: "discord-appa-slash"
    });
    assert.deepEqual(seen[1].body, {
      type: "webtoon",
      requestedBy: "admin-1",
      confirmedBy: "admin-1",
      previewId: "preview-1"
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("noonaChat calls the Sage-brokered public mention route", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({method: req.method, url: req.url, authorization: req.headers.authorization, body});
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({reply: "LONG LIVE NOONA."}));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token"
  });

  try {
    const response = await sage.noonaChat({
      message: "are you alive?",
      guildId: "guild-1",
      channelId: "general",
      user: {discordUserId: "user-1"}
    });

    assert.equal(response.ok, true);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/internal/portal/noona-chat");
    assert.equal(seen[0].authorization, "Bearer portal-service-token");
    assert.equal(seen[0].body.message, "are you alive?");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("recordAppaDiscordDiagnostic calls the Sage Appa diagnostics audit route", async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({method: req.method, url: req.url, authorization: req.headers.authorization, body});
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({ok: true, action: body.action}));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sage = createSageClient({
    sageBaseUrl: baseUrl,
    serviceToken: "portal-service-token"
  });

  try {
    const response = await sage.recordAppaDiscordDiagnostic({
      action: "inspect",
      guildId: "guild-1",
      channelId: "admin-chat",
      snippets: [{messageId: "m1", snippet: "redacted only"}]
    });

    assert.equal(response.ok, true);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/internal/portal/appa-discord-diagnostic");
    assert.equal(seen[0].authorization, "Bearer portal-service-token");
    assert.equal(seen[0].body.action, "inspect");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
