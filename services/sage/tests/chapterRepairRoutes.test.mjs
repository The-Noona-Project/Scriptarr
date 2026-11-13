import test from "node:test";
import assert from "node:assert/strict";
import {registerChapterRepairRoutes} from "../lib/registerChapterRepairRoutes.mjs";

const fixture = () => {
  const routes = {}, calls = [], events = [];
  const guard = level => fn => async (req, res) => req.level === level || req.level === "root" ? fn(req, res) : res.status(403).json({error: "Denied"});
  registerChapterRepairRoutes({get: (path, fn) => {routes.get = fn;}, post: (path, fn) => {routes.post = fn;}}, {
    read: guard("read"), root: guard("root"), loadTitle: async () => ({id: "title"}),
    vaultClient: {listRavenDownloadTasks: async () => [{taskId: "task", titleId: "title", status: "failed", details: {chapterRepair: {titleId: "title", chapters: [{chapter_number: "197"}]}, completionProblems: [{chapterNumber: "197", code: "source_unavailable", message: "Chapter 197: unavailable."}]}}]},
    ravenBaseUrl: "internal", serviceJson: async (...args) => {calls.push(args); return {ok: true, payload: {taskId: "task", replayed: calls.length > 1}};},
    recordQueued: async (...args) => {events.push(args);}
  });
  const invoke = async (method, body, level = "root") => {
    let code = 200, payload;
    await routes[method]({body, params: {titleId: "title"}, user: {discordUserId: "owner"}, level}, {status: value => {code = value; return {json: value => {payload = value;}};}, json: value => {payload = value;}});
    return {code, payload};
  };
  return {calls, events, invoke};
};
test("repair requires root and injects the authenticated actor", async () => {
  const f = fixture(), body = {chapterIds: ["chapter"], requestId: "repair:1", requestedBy: "attacker", chapterRepair: {titleId: "other"}};
  assert.equal((await f.invoke("post", body, "read")).code, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.invoke("post", body)).code, 202);
  assert.deepEqual(f.calls[0][2].body, {chapterIds: ["chapter"], requestId: "repair:1", requestedBy: "owner"});
  await f.invoke("post", body); assert.equal(f.events.length, 1);
});
test("repair GET is observational and excludes private details", async () => {
  const f = fixture();
  const one = await f.invoke("get", {}, "read"), two = await f.invoke("get", {}, "read");
  assert.deepEqual(one, two); assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
  assert.equal(one.payload.tasks[0].problems[0].chapterNumber, "197");
  assert.equal(one.payload.tasks[0].details, undefined);
});
test("repair rejects missing or oversized scope before calling the downloader", async () => {
  const f = fixture();
  for (const body of [{}, {chapterIds: [], requestId: "x"}, {chapterIds: ["../outside"], requestId: "x"}, {chapterIds: Array(51).fill("x"), requestId: "x"}]) assert.equal((await f.invoke("post", body)).code, 400);
  assert.equal(f.calls.length, 0);
});
