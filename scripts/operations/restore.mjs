/** @file Restore authenticated snapshot contents without starting a database or services. */
import {spawn} from "node:child_process";
import {mkdir, readFile, rm, stat} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {decryptFile, sha256File} from "./backup-crypto.mjs";
import {validateManifest} from "./backup-receiver.mjs";

function tar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, {stdio: ["ignore", "pipe", "pipe"]});
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 32 * 1024 ** 2) child.kill(); });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error("Archive inspection or extraction failed.")));
  });
}

/** Authenticate and extract one snapshot into a newly created private recovery directory. */
export async function restoreSnapshot(snapshotDirectory, privateKeyFile, outputDirectory) {
  const manifest = JSON.parse(await readFile(path.join(snapshotDirectory, "manifest.json"), "utf8"));
  validateManifest(manifest, manifest.id);
  if (await sha256File(path.join(snapshotDirectory, "snapshot.aesgcm")) !== manifest.archive.sha256) throw new Error("Snapshot ciphertext checksum failed.");
  await mkdir(outputDirectory, {mode: 0o700});
  const archive = path.join(outputDirectory, ".authenticated-snapshot.tar.gz");
  try {
    await decryptFile(path.join(snapshotDirectory, "snapshot.aesgcm"), archive, await readFile(privateKeyFile));
    const entries = (await tar(["-tzf", archive])).split(/\r?\n/).filter(Boolean);
    if (entries.some(name => name.startsWith("/") || name.split("/").includes("..") || name.includes("\\"))) throw new Error("Unsafe archive member name.");
    await tar(["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", outputDirectory]);
    const recovered = JSON.parse(await readFile(path.join(outputDirectory, "recovery.json"), "utf8"));
    return {state: "restored", id: manifest.id, databaseKind: recovered.databaseKind, libraryFiles: recovered.libraryFiles, entries: entries.length};
  } finally { await rm(archive, {force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [snapshotDirectory, privateKeyFile, outputDirectory] = process.argv.slice(2);
  restoreSnapshot(snapshotDirectory, privateKeyFile, outputDirectory).then(result => console.log(JSON.stringify(result))).catch(() => { console.error("Recovery did not pass authentication or extraction; services remain stopped."); process.exitCode = 1; });
}
