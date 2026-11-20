/** @file Container retirement rejects live or substituted identities and never deletes volumes. */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {retireContainer} from "./retire-container.mjs";

test("retirement requires the reviewed stopped identity", async () => {
  const id = "a".repeat(64), approval = {id, name: "old-copy", archiveRoot: tmpdir()};
  for (const state of [{Name: "/different", State: {Status: "exited"}}, {Name: "/old-copy", State: {Status: "running", Running: true}}]) {
    const calls = []; await assert.rejects(retireContainer(approval, async args => { calls.push(args); return JSON.stringify([state]); }));
    assert.equal(calls.length, 1);
  }
});

test("retirement archives the exact stopped container and uses rm without volume or force flags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retire-proof-")), id = "b".repeat(64), calls = [];
  try {
    const docker = async args => {
      calls.push(args);
      if (args[0] === "inspect") return JSON.stringify([{Id: id, Name: "/old-copy", State: {Status: "exited", Running: false}, Image: "immutable", Mounts: [{Source: "/existing/data"}]}]);
      if (args[0] === "export") await writeFile(args[2], Buffer.alloc(2048));
      return "";
    };
    const receipt = await retireContainer({id, name: "old-copy", archiveRoot: root}, docker);
    assert.equal(receipt.removed, true); assert.deepEqual(calls.find(args => args[0] === "rm"), ["rm", id]);
    assert.ok(calls.findIndex(args => args[0] === "export") < calls.findIndex(args => args[0] === "rm"));
    const replay = await retireContainer({id, name: "old-copy", archiveRoot: root}, async args => {
      if (args[0] === "inspect") throw new Error("Container absent after lost response");
      assert.equal(args[0], "ps"); return "";
    });
    assert.deepEqual(replay, receipt);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("mount ordering changes during export do not invalidate an unchanged container", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retire-order-")), id = "c".repeat(64);
  let inspections = 0, removed = false;
  try {
    const mounts = [{Source: "/data/a", Destination: "/a"}, {Source: "/data/b", Destination: "/b"}];
    const docker = async args => {
      if (args[0] === "inspect") return JSON.stringify([{Id: id, Name: "/old-copy", State: {Status: "exited", Running: false}, Image: "immutable",
        Mounts: ++inspections === 1 ? mounts : [...mounts].reverse()}]);
      if (args[0] === "export") await writeFile(args[2], Buffer.alloc(2048));
      if (args[0] === "rm") removed = true;
      return "";
    };
    assert.equal((await retireContainer({id, name: "old-copy", archiveRoot: root}, docker)).removed, true);
    assert.equal(removed, true);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("failed export preserves the container and its mounts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retire-failure-")), id = "d".repeat(64), calls = [];
  try {
    await assert.rejects(retireContainer({id, name: "old-copy", archiveRoot: root}, async args => {
      calls.push(args);
      if (args[0] === "inspect") return JSON.stringify([{Id: id, Name: "/old-copy", State: {Status: "exited", Running: false}, Image: "immutable", Mounts: []}]);
      throw new Error("export failed");
    }), /export failed/);
    assert.equal(calls.some(args => args[0] === "rm"), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
