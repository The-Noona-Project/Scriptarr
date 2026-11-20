/** @file Explicit-ID container retirement with a recoverable root-filesystem and private configuration archive. */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir, writeFile, rename, stat, open, readFile, realpath, lstat} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {pathToFileURL} from "node:url";
const execute = promisify(execFile);
const mountsKey = mounts => JSON.stringify((mounts || []).map(mount => JSON.stringify(Object.fromEntries(Object.entries(mount).sort(([a], [b]) => a.localeCompare(b))))).sort());
const archiveHash = async archive => {
  if ((await stat(archive)).size < 1024) throw new Error("Container export is incomplete.");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return hash.digest("hex");
};

/**
 * Flush recovery content and published directory entries before Docker may remove the source container.
 * @param {string[]} files Exact protected recovery files.
 * @param {string[]} directories Containing directories through the archive root's parent.
 * @returns {Promise<void>} Resolves only after all durability barriers succeed.
 */
export async function synchronizeRecovery(files, directories) {
  for (const filename of [...files, ...directories]) {
    const handle = await open(filename, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

/**
 * Archive and retire an exact, stopped container without deleting its mounts or image.
 * @param {{id:string,name:string,archiveRoot:string,readOnlyBtrfs?:boolean}} approval Frozen reviewed identity and protected archive directory.
 * @param {Function} [docker] Injectable Docker command transport.
 * @param {Function} [synchronize] Injectable durability barrier; production requires file and directory synchronization.
 * @returns {Promise<object>} Non-secret retirement receipt.
 */
export async function retireContainer(approval, docker = async args => (await execute("docker", args, {timeout: 300000, maxBuffer: 8 * 1024 * 1024})).stdout, synchronize = synchronizeRecovery) {
  if (!/^[a-f0-9]{64}$/.test(approval.id) || !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(approval.name)
    || !path.isAbsolute(approval.archiveRoot)) throw new Error("An exact reviewed container identity and absolute archive root are required.");
  const inspect = async () => JSON.parse(await docker(["inspect", approval.id]))[0];
  const directory = path.join(approval.archiveRoot, approval.id);
  let before;
  try { before = await inspect(); }
  catch (error) {
    const remaining = (await docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}"])).trim().split(/\s+/);
    if (remaining.includes(approval.id)) throw error;
    const saved = JSON.parse(await readFile(path.join(directory, "inspect.private.json"), "utf8"));
    const receipt = JSON.parse(await readFile(path.join(directory, "receipt.json"), "utf8"));
    if (saved.Id !== approval.id || saved.Name !== `/${approval.name}` || receipt.id !== approval.id || receipt.name !== approval.name
      || receipt.sha256 !== await archiveHash(path.join(directory, "rootfs.tar"))) throw new Error("Retirement proof does not match the absent reviewed container.");
    return {...receipt, removed: true};
  }
  if (before.Id !== approval.id || before.Name !== `/${approval.name}` || !["exited", "created", "dead"].includes(before.State.Status) || before.State.Running) throw new Error("The reviewed container identity/state changed; refusing retirement.");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const snapshot = path.join(directory, "inspect.private.json");
  try { await writeFile(snapshot, JSON.stringify(before, null, 2) + "\n", {mode: 0o600, flag: "wx"}); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const saved = JSON.parse(await readFile(snapshot, "utf8"));
    if (saved.Id !== before.Id || saved.Name !== before.Name || saved.Image !== before.Image || mountsKey(saved.Mounts) !== mountsKey(before.Mounts)
      || saved.State.StartedAt !== before.State.StartedAt || saved.State.FinishedAt !== before.State.FinishedAt) throw new Error("Prior archive belongs to another configuration.");
  }
  const partial = path.join(directory, `rootfs-${Date.now()}.tar.partial`), archive = path.join(directory, "rootfs.tar");
  let archived = false;
  try { archived = (await stat(archive)).size >= 1024; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!archived) {
    const fd = await open(partial, "wx", 0o600); await fd.close();
    if (approval.readOnlyBtrfs) {
    if (before.GraphDriver?.Name !== "btrfs") throw new Error("The inspected storage driver is not btrfs.");
    const layer = (await readFile(`/var/lib/docker/image/btrfs/layerdb/mounts/${approval.id}/mount-id`, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(layer)) throw new Error("Invalid inspected btrfs layer identity.");
    const source = `/var/lib/docker/btrfs/subvolumes/${layer}`;
    if ((await lstat(source)).isSymbolicLink() || await realpath(source) !== source) throw new Error("Unexpected btrfs archive source.");
    // Read the stopped snapshot only. Container and layer deletion still belongs exclusively to Docker.
    await execute("tar", ["--xattrs", "--acls", "--sparse", "-cf", partial, "-C", source, "."], {timeout: 300000, maxBuffer: 1024 * 1024});
    } else await docker(["export", "--output", partial, approval.id]);
    if ((await stat(partial)).size < 1024) throw new Error("Container export is incomplete; nothing was removed.");
    await rename(partial, archive);
  }
  const sha256 = await archiveHash(archive);
  const current = await inspect();
  if (current.Name !== before.Name || current.State.Running || current.State.Status !== before.State.Status || current.Image !== before.Image
    || mountsKey(current.Mounts) !== mountsKey(before.Mounts) || current.State.StartedAt !== before.State.StartedAt
    || current.State.FinishedAt !== before.State.FinishedAt) throw new Error("Container changed during archival; nothing was removed.");
  let receipt = {id: approval.id, name: approval.name, archivedAt: new Date().toISOString(), sha256, volumesPreserved: true, imagePreserved: true};
  try { await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt) + "\n", {mode: 0o600, flag: "wx"}); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const saved = JSON.parse(await readFile(path.join(directory, "receipt.json"), "utf8"));
    if (saved.id !== approval.id || saved.name !== approval.name || saved.sha256 !== sha256) throw new Error("Existing retirement receipt differs.");
    receipt = saved;
  }
  await synchronize([archive, snapshot, path.join(directory, "receipt.json")], [directory, approval.archiveRoot, path.dirname(approval.archiveRoot)]);
  await docker(["rm", approval.id]);
  const remaining = (await docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}"])).trim().split(/\s+/);
  if (remaining.includes(approval.id)) throw new Error("Container retirement could not be verified.");
  return {...receipt, removed: true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, name, archiveRoot, mode] = process.argv.slice(2);
  retireContainer({id, name, archiveRoot, readOnlyBtrfs: mode === "--read-only-btrfs"}).then(receipt => console.log(JSON.stringify(receipt))).catch(() => {
    console.error("Container retirement stopped; preserved archives require inspection before retry."); process.exitCode = 1;
  });
}
