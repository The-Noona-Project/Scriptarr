/** @file Replace the canonical Warden from a protected manifest; never retain renamed backup containers. */
import http from "node:http";
import {mkdir, writeFile, readFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

/**
 * Send one bounded request to the local Docker socket.
 * @param {string} method HTTP method.
 * @param {string} route Docker API route.
 * @param {object} [body] Request payload.
 * @returns {Promise<object|null>} Parsed response.
 */
export function dockerRequest(method, route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({socketPath: "/var/run/docker.sock", method, path: route,
      headers: {"Content-Type": "application/json"}, timeout: 45000}, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode >= 400) { reject(Object.assign(new Error("Docker operation rejected."), {status: response.statusCode})); return; }
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null); } catch { reject(new Error("Invalid Docker response.")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Docker operation deadline exceeded.")));
    request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}

/**
 * Restore a supported create specification without copying assigned network addresses.
 * @param {object} before Docker inspection.
 * @param {string} image Immutable replacement image.
 * @param {string[]} [environment] Complete replacement environment.
 * @returns {object} Docker create body.
 */
export function wardenSpecification(before, image, environment = before.Config.Env) {
  const endpoints = Object.fromEntries(Object.entries(before.NetworkSettings.Networks).map(([name, network]) => [name,
    {Aliases: (network.Aliases || []).filter(alias => alias !== before.Id.slice(0, 12)), ...(network.IPAMConfig ? {IPAMConfig: network.IPAMConfig} : {})}]));
  return {...before.Config, Image: image, Env: environment, HostConfig: before.HostConfig, NetworkingConfig: {EndpointsConfig: endpoints}};
}

/**
 * Replace one explicitly identified Warden, recreating its previous specification on failure.
 * @param {{expectedId:string,image:string,archiveRoot:string,environment?:string[]}} options Reviewed deployment.
 * @param {Function} [docker] Docker request transport.
 * @param {Function} [wait] Healthy-start verifier.
 * @returns {Promise<object>} Non-secret replacement receipt.
 */
export async function replaceWarden(options, docker = dockerRequest, wait = async id => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const current = await docker("GET", `/containers/${id}/json`);
    if (!current.State.Running || current.State.Health?.Status === "unhealthy") throw new Error("Replacement Warden did not become healthy.");
    if (current.State.Health?.Status === "healthy") return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Replacement Warden health deadline exceeded.");
}) {
  const before = await docker("GET", "/containers/scriptarr-warden/json");
  if (before.Id !== options.expectedId || before.Name !== "/scriptarr-warden" || !/@sha256:[a-f0-9]{64}$/.test(options.image)
    || !path.isAbsolute(options.archiveRoot)) throw new Error("Warden identity or immutable deployment reference changed.");
  await docker("GET", `/images/${encodeURIComponent(options.image)}/json`);
  await mkdir(options.archiveRoot, {recursive: true, mode: 0o700});
  await writeFile(path.join(options.archiveRoot, `${before.Id}.private.json`), JSON.stringify(before, null, 2) + "\n", {mode: 0o600, flag: "wx"});
  const operation = `replacement-${before.Id.slice(0, 12)}-${Date.now()}`;
  let replacement;
  try {
    await docker("POST", `/containers/${before.Id}/stop?t=30`);
    await docker("DELETE", `/containers/${before.Id}`);
    const specification = wardenSpecification(before, options.image, options.environment);
    specification.Labels = {...specification.Labels, "com.scriptarr.replacement": operation};
    replacement = await docker("POST", "/containers/create?name=scriptarr-warden", specification);
    await docker("POST", `/containers/${replacement.Id}/start`); await wait(replacement.Id);
    return {previousId: before.Id, containerId: replacement.Id, healthy: true, backupContainersCreated: 0};
  } catch (failure) {
    // Reconcile a lost create response before recreating the canonical name.
    let failed;
    try { failed = await docker("GET", "/containers/scriptarr-warden/json"); } catch (error) { if (error.status !== 404) throw error; }
    if (failed) {
      if (failed.Id === before.Id) {
        await docker("POST", `/containers/${before.Id}/start`); await wait(before.Id);
        throw new Error("Replacement failed; previous canonical Warden was restored.", {cause: failure});
      }
      if ((replacement && failed.Id !== replacement.Id) || failed.Config.Labels?.["com.scriptarr.replacement"] !== operation) throw new Error("Canonical Warden changed during rollback; manual reconciliation required.");
      await docker("POST", `/containers/${failed.Id}/stop?t=30`); await docker("DELETE", `/containers/${failed.Id}`);
    }
    const restored = await docker("POST", "/containers/create?name=scriptarr-warden", wardenSpecification(before, before.Image));
    await docker("POST", `/containers/${restored.Id}/start`); await wait(restored.Id);
    throw new Error("Replacement failed; previous canonical Warden was restored.", {cause: failure});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readFile(process.argv[2], "utf8").then(JSON.parse).then(options => replaceWarden(options)).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error("Warden replacement stopped; inspect the protected operation record before retrying."); process.exitCode = 1;
  });
}
