/** @file Public boolean-only readiness summary brokered through Sage. */

/**
 * Summarize dependency health without exposing addresses, settings, paths or operational job records.
 * @param {object} health Sage health response.
 * @returns {object} Non-secret download readiness fields.
 */
export function downloadReadiness(health = {}) {
  const {vault = {}, warden = {}, raven = {}} = health.dependencies || {};
  const catalogReady = vault.ok === true && vault.ready === true;
  const storageReady = warden.storage?.ready === true && raven.storage?.ready === true;
  const workerReady = warden.ingestDegraded === false && warden.dependenciesReady === true;
  const vpnReady = raven.vpn?.enabled === false || (raven.vpn?.enabled === true && raven.vpn?.protected === true);
  return {ready: health.ok === true && catalogReady && storageReady && workerReady && vpnReady,
    catalogReady, storageReady, workerReady, vpnReady};
}
