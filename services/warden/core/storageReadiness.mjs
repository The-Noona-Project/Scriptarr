/** @file Capacity readiness for the actual mounted Warden state filesystem. */
import {statfs} from "node:fs/promises";

/**
 * Read the mounted state filesystem without writing or clearing operational pauses.
 * @param {string} root Mounted runtime directory.
 * @param {number} [reserveBytes] Free capacity reserve.
 * @param {Function} [read] Injectable statfs implementation.
 * @returns {Promise<object>} Non-secret capacity summary.
 */
export async function storageReadiness(root, reserveBytes = 100 * 2 ** 30, read = statfs) {
  try {
    const stats = await read(root), availableBytes = stats.bavail * stats.bsize;
    const inodesReady = stats.files === 0 || stats.ffree >= 10000;
    return {ready: availableBytes >= reserveBytes && inodesReady, availableBytes, reserveBytes, inodesReady};
  } catch { return {ready: false, reason: "storage_unavailable"}; }
}
