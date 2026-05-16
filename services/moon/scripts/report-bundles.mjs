#!/usr/bin/env node

/**
 * @file Print compact Moon user/reader/admin route and chunk bundle summaries.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const moonRoot = path.resolve(import.meta.dirname, "..");
const selected = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("-")));
const apps = [
  {id: "user", dir: "user-next"},
  {id: "reader", dir: "reader-next"},
  {id: "admin", dir: "admin-next"}
].filter((app) => selected.size === 0 || selected.has(app.id));

const readStats = (app) => {
  const appRoot = path.join(moonRoot, "apps", app.dir);
  const statsFile = path.join(appRoot, ".next/diagnostics/route-bundle-stats.json");
  if (!fs.existsSync(statsFile)) {
    return {appRoot, statsFile, rows: [], chunks: [], missing: true};
  }
  const stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
  const entries = Array.isArray(stats) ? stats.map((entry) => [entry?.route || "unknown", entry]) : Object.entries(stats);
  const chunkSizes = new Map();
  const rows = entries.map(([route, value]) => {
    const chunkPaths = Array.isArray(value?.firstLoadChunkPaths) ? value.firstLoadChunkPaths : [];
    let gzipSize = 0;
    for (const chunkPath of chunkPaths) {
      const resolved = path.join(appRoot, chunkPath);
      if (fs.existsSync(resolved)) {
        const chunk = fs.readFileSync(resolved);
        chunkSizes.set(chunkPath, chunk.length);
        gzipSize += zlib.gzipSync(chunk).length;
      }
    }
    return {
      route,
      size: Number(value?.firstLoadUncompressedJsBytes || value?.size || value?.total || value?.totalSize || value?.client || 0),
      gzipSize,
      files: chunkPaths.length
    };
  }).sort((left, right) => right.size - left.size);
  const chunks = Array.from(chunkSizes.entries())
    .map(([chunkPath, size]) => ({chunkPath, size}))
    .sort((left, right) => right.size - left.size);
  return {appRoot, statsFile, rows, chunks, missing: false};
};

let failed = false;
for (const app of apps) {
  const report = readStats(app);
  if (report.missing) {
    console.error(`Moon ${app.id} bundle diagnostics were not found. Run \`npm --workspace services/moon run build:${app.id}\` first.`);
    failed = true;
    continue;
  }

  console.log(`Moon ${app.id} route bundle report: ${path.relative(moonRoot, report.statsFile)}`);
  if (!report.rows.length) {
    console.log("  No route bundle entries were present in the diagnostics file.");
  } else {
    for (const row of report.rows.slice(0, 12)) {
      const rawLabel = row.size ? `${(row.size / 1024).toFixed(1)} KiB raw` : "raw size unavailable";
      const gzipLabel = row.gzipSize ? `${(row.gzipSize / 1024).toFixed(1)} KiB gzip` : "gzip size unavailable";
      const fileLabel = row.files ? `, ${row.files} chunks` : "";
      console.log(`  ${row.route}: ${rawLabel}, ${gzipLabel}${fileLabel}`);
    }
  }

  console.log(`Moon ${app.id} top first-load chunks:`);
  if (!report.chunks.length) {
    console.log("  Chunk sizes unavailable.");
  } else {
    for (const chunk of report.chunks.slice(0, 8)) {
      console.log(`  ${chunk.chunkPath}: ${(chunk.size / 1024).toFixed(1)} KiB`);
    }
  }
}

if (failed) {
  process.exitCode = 1;
}
