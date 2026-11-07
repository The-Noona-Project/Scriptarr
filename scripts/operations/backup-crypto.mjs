/** @file Authenticated, streaming backup encryption with offline recovery keys. */
import {createCipheriv, createDecipheriv, createHash, publicEncrypt, privateDecrypt, randomBytes} from "node:crypto";
import {createReadStream, createWriteStream} from "node:fs";
import {appendFile, readFile, open, rename, rm, stat} from "node:fs/promises";
import {pipeline} from "node:stream/promises";
import {PassThrough, Readable, Transform} from "node:stream";
import {pathToFileURL} from "node:url";

const MAGIC = Buffer.from("SCRARRB1");
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

/** Compute a ciphertext checksum without buffering a backup in memory. */
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireNewPath(path) {
  try { await stat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Refusing to replace an existing recovery artifact.");
}

/** Encrypt an input stream with AES-256-GCM and an RSA-OAEP-wrapped random key. */
export async function encryptStream(input, outputPath, publicKey, {signal} = {}) {
  // Attach synchronously: child_process drains stdout on exit, even before an async file open completes.
  const buffered = new PassThrough({highWaterMark: 65536});
  const forwardError = error => buffered.destroy(error);
  buffered.on("error", () => {});
  input.on("error", forwardError);
  input.pipe(buffered);
  let key;
  let plaintextBytes = 0;
  const counter = new Transform({transform(chunk, encoding, callback) { plaintextBytes += chunk.length; callback(null, chunk); }});
  const partial = `${outputPath}.partial-${process.pid}`;
  try {
    await requireNewPath(outputPath);
    key = randomBytes(32);
    const wrapped = publicEncrypt({key: publicKey, oaepHash: "sha256"}, key);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(wrapped.length);
    const nonce = randomBytes(NONCE_BYTES);
    const header = Buffer.concat([MAGIC, size, wrapped, nonce]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(header);
    const handle = await open(partial, "wx", 0o600);
    await handle.writeFile(header);
    await handle.close();
    await pipeline(buffered, counter, cipher, createWriteStream(partial, {flags: "a", mode: 0o600}), {signal});
    await appendFile(partial, cipher.getAuthTag());
    await rename(partial, outputPath);
    return {bytes: (await stat(outputPath)).size, plaintextBytes, sha256: await sha256File(outputPath)};
  } catch (error) {
    input.destroy();
    await rm(partial, {force: true});
    throw error;
  } finally {
    key?.fill(0);
    input.unpipe(buffered);
    input.removeListener("error", forwardError);
    buffered.destroy();
  }
}

/** Decrypt only to a new temporary file; publish it after authentication succeeds. */
export async function decryptFile(inputPath, outputPath, privateKey, {signal} = {}) {
  await requireNewPath(outputPath);
  const handle = await open(inputPath, "r");
  let key;
  const partial = `${outputPath}.recovering-${process.pid}`;
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(MAGIC.length + 2);
    if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Unsupported or truncated backup envelope.");
    }
    const wrappedSize = prefix.readUInt16BE(MAGIC.length);
    if (wrappedSize < 256 || wrappedSize > 1024) throw new Error("Invalid backup key envelope.");
    const headerSize = prefix.length + wrappedSize + NONCE_BYTES;
    if (size < headerSize + TAG_BYTES) throw new Error("Truncated backup envelope.");
    const header = Buffer.alloc(headerSize);
    if ((await handle.read(header, 0, headerSize, 0)).bytesRead !== headerSize) throw new Error("Truncated backup header.");
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    key = privateDecrypt({key: privateKey, oaepHash: "sha256"}, header.subarray(prefix.length, prefix.length + wrappedSize));
    if (key.length !== 32) throw new Error("Invalid recovered content key.");
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(headerSize - NONCE_BYTES));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      size === headerSize + TAG_BYTES ? Readable.from([]) : createReadStream(inputPath, {start: headerSize, end: size - TAG_BYTES - 1}),
      decipher,
      createWriteStream(partial, {flags: "wx", mode: 0o600}),
      {signal}
    );
    await rename(partial, outputPath);
    return {bytes: (await stat(outputPath)).size, sha256: await sha256File(outputPath)};
  } catch (error) {
    await rm(partial, {force: true});
    throw new Error("Backup recovery failed authentication or was interrupted.", {cause: error});
  } finally {
    key?.fill(0);
    await handle.close();
  }
}

async function main() {
  const [mode, keyPath, inputPath, outputPath] = process.argv.slice(2);
  if (!["encrypt", "decrypt"].includes(mode) || !keyPath || !inputPath || !outputPath) throw new Error("Usage: backup-crypto.mjs encrypt|decrypt KEY INPUT|- OUTPUT");
  const key = await readFile(keyPath);
  const result = mode === "encrypt"
    ? await encryptStream(inputPath === "-" ? process.stdin : createReadStream(inputPath), outputPath, key)
    : await decryptFile(inputPath, outputPath, key);
  console.log(JSON.stringify({state: "complete", ...result}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Backup cryptographic operation failed; no output was published."); process.exitCode = 1; });
}
