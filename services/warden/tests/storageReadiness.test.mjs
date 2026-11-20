/** @file Mounted storage health must detect capacity and inode exhaustion even when containers are running. */
import test from "node:test";
import assert from "node:assert/strict";
import {storageReadiness} from "../core/storageReadiness.mjs";

test("capacity reads detect exhausted storage and inodes without treating dynamic inode pools as exhausted", async () => {
  assert.equal((await storageReadiness("/state", 100, async () => ({bavail: 99, bsize: 1, files: 20000, ffree: 15000}))).ready, false);
  assert.equal((await storageReadiness("/state", 100, async () => ({bavail: 1000, bsize: 1, files: 20000, ffree: 98}))).ready, false);
  assert.equal((await storageReadiness("/state", 100, async () => ({bavail: 1000, bsize: 1, files: 0, ffree: 0}))).ready, true);
  assert.equal((await storageReadiness("/state", 100, async () => { throw new Error("unmounted"); })).ready, false);
});
