/** @file Readiness aborts oversized upstream bodies before a never-ending response can accumulate. */
import test from "node:test";
import assert from "node:assert/strict";
import {proxyRequest} from "../lib/proxy.mjs";

test("bounded proxy aborts and cancels an oversized unclosed response", async () => {
  const original = globalThis.fetch; let signal, cancelled = false;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(65537));}, cancel() {cancelled = true;}}));
  };
  try {
    await assert.rejects(proxyRequest({baseUrl: "http://localhost", path: "/health", maxResponseBytes: 65536}), /byte limit/);
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

test("bounded proxy preserves successful small responses", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":true}', {headers: {"Content-Type": "application/json"}});
  try {
    const result = await proxyRequest({baseUrl: "http://localhost", path: "/health", maxResponseBytes: 65536});
    assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body.toString()), {ok: true});
  } finally { globalThis.fetch = original; }
});
