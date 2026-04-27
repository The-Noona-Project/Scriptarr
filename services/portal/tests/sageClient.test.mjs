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

    assert.deepEqual(seen.map((entry) => [entry.method, entry.url]), [
      ["POST", "/api/internal/portal/downloads/bulk-runs"],
      ["GET", "/api/internal/portal/downloads/bulk-runs/bulk-run-1"],
      ["POST", "/api/internal/portal/downloads/bulk-runs/bulk-run-1/continue"],
      ["POST", "/api/internal/portal/downloads/bulk-runs/bulk-run-1/cancel"]
    ]);
    assert.equal(seen[0].body.providerId, "weebcentral");
    assert.deepEqual(seen[2].body, {requestedBy: "owner-1"});
    assert.deepEqual(seen[3].body, {requestedBy: "owner-1"});
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
