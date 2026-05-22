import test from "node:test";
import assert from "node:assert/strict";

import {createAiResponseQueue} from "../lib/discord/aiResponseQueue.mjs";

test("AI response queue reserves FIFO order before slow placeholders finish", async () => {
  const queue = createAiResponseQueue();
  const order = [];
  let releaseQueued;

  const first = queue.run(
    async () => {
      order.push("first");
      return "first";
    },
    {
      onQueued: () => new Promise((resolve) => {
        releaseQueued = resolve;
      })
    }
  );
  const second = queue.run(async () => {
    order.push("second");
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);

  releaseQueued();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first", "second"]);
});

test("AI response queue releases the lane when onStart fails", async () => {
  const queue = createAiResponseQueue();
  const started = [];

  await assert.rejects(
    () => queue.run(
      async () => {
        throw new Error("task should not run");
      },
      {
        onStart: () => {
          throw new Error("placeholder edit failed");
        }
      }
    ),
    /placeholder edit failed/
  );

  const result = await queue.run(async () => {
    started.push("next");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(started, ["next"]);
  assert.deepEqual(queue.getState(), {active: false, pending: 0, queued: 0});
});

test("AI response queue bounds queued work and cancels stopped work", async () => {
  const queue = createAiResponseQueue({maxQueued: 2});
  let releaseActive;

  const first = queue.run(() => new Promise((resolve) => {
    releaseActive = () => resolve("first");
  }));
  const second = queue.run(async () => "second");

  await assert.rejects(
    () => queue.run(async () => "third"),
    /queue is full/i
  );

  queue.cancelAll("Portal runtime stopped.");
  releaseActive();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.match(results[0].reason.message, /Portal runtime stopped/i);
  assert.match(results[1].reason.message, /Portal runtime stopped/i);
  assert.deepEqual(queue.getState(), {active: false, pending: 0, queued: 0});
});
