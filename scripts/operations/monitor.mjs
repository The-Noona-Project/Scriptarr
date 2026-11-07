/** @file Independent, read-only service and backup freshness monitoring. */
import http from "node:http";
import https from "node:https";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

/** Probe headers only, with a strict deadline and normal certificate validation. */
export function probe(endpoint, {timeoutMs = 7000} = {}) {
  return new Promise(resolve => {
    const url = new URL(endpoint.url);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Monitoring endpoints must be credential-free HTTP(S) URLs.");
    let settled = false;
    let deadline;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({name: endpoint.name, ...result});
    };
    const errorCode = error => ["health_body_too_large", "deadline"].includes(error?.message) ? error.message : "unreachable_or_tls_error";
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "GET", servername: endpoint.servername,
      headers: endpoint.servername ? {Host: endpoint.servername} : {}
    }, response => {
      const status = response.statusCode;
      if (!(endpoint.expectedStatus || [200]).includes(status)) {
        finish({state: "failed", status});
        response.destroy();
        return;
      }
      const fields = Object.entries(endpoint.expectedFields || {});
      if (!fields.length) {
        finish({state: "healthy", status});
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { finish({state: "failed", status, error: "health_body_too_large"}); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("error", error => finish({state: "failed", status, error: errorCode(error)}));
      response.on("aborted", () => finish({state: "failed", status, error: "incomplete_health_body"}));
      response.on("end", () => {
        if (settled) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { finish({state: "failed", status, error: "invalid_health_json"}); return; }
        const failedFields = fields.filter(([key, expected]) => {
          let value = body;
          for (const part of key.split(".")) {
            if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return true;
            value = value[part];
          }
          return !Object.is(value, expected);
        }).map(([key]) => key);
        finish(failedFields.length ? {state: "failed", status, error: "unexpected_health_state", failedFields} : {state: "healthy", status});
      });
    });
    deadline = setTimeout(() => request.destroy(new Error("deadline")), Math.min(7000, Math.max(1, timeoutMs)));
    request.on("error", error => finish({state: "failed", error: errorCode(error)}));
    request.end();
  });
}

/** Combine endpoint availability with independently stored backup freshness. */
export async function monitor(config) {
  const checks = await Promise.all((config.endpoints || []).map(endpoint => probe(endpoint)));
  for (const store of config.backupStores || [{name: "core", path: config.storeRoot}]) {
    try {
      const latest = JSON.parse(await readFile(path.join(store.path, "status/latest.json"), "utf8"));
      const ageHours = (Date.now() - Date.parse(latest.createdAt)) / 3600000;
      checks.push({name: `${store.name}-backup-freshness`, state: latest.state === "complete" && ageHours >= -1 && ageHours < (config.maxBackupAgeHours || 30) ? "healthy" : "failed", ageHours: Number(ageHours.toFixed(2)), snapshot: latest.id});
    } catch { checks.push({name: `${store.name}-backup-freshness`, state: "failed", error: "no_valid_backup_status"}); }
  }
  const result = {state: checks.every(check => check.state === "healthy") ? "healthy" : "failed", checkedAt: new Date().toISOString(), checks};
  await mkdir(path.dirname(config.statusFile), {recursive: true, mode: 0o700});
  const temporary = `${config.statusFile}.partial-${process.pid}`;
  await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", {mode: 0o600});
  await rename(temporary, config.statusFile);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readFile(process.argv[2], "utf8").then(text => monitor(JSON.parse(text))).then(result => {
    console.log(JSON.stringify(result));
    process.exitCode = result.state === "healthy" ? 0 : 1;
  }).catch(() => { console.error("Independent monitoring failed."); process.exitCode = 1; });
}
