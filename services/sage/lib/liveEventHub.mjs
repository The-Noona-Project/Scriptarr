/**
 * @file Shared in-process durable event fanout for Sage live transports.
 */

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_LIMIT = 100;

const normalizeArray = (value) => Array.isArray(value) ? value : [];

/**
 * Read a durable event sequence as a positive integer.
 *
 * @param {Record<string, unknown>} event
 * @returns {number}
 */
export const eventSequence = (event) => Number.parseInt(String(event?.sequence || 0), 10) || 0;

/**
 * Create a shared event hub so live clients do not each poll Vault.
 *
 * @param {{
 *   vaultClient: {listEvents: Function},
 *   logger?: {warn?: Function},
 *   pollIntervalMs?: number
 * }} options
 * @returns {{
 *   getCursor: () => number,
 *   publish: (event: Record<string, unknown> | null | undefined) => void,
 *   subscribe: (listener: (event: Record<string, unknown>) => void) => () => void
 * }}
 */
export const createLiveEventHub = ({vaultClient, logger, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS}) => {
  const listeners = new Set();
  let cursor = 0;
  let poller = 0;
  let polling = false;

  const notify = (event) => {
    const sequence = eventSequence(event);
    if (sequence > cursor) {
      cursor = sequence;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger?.warn?.("Sage live event listener failed.", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const initializeCursor = async () => {
    if (cursor > 0) {
      return;
    }
    const latest = normalizeArray(await vaultClient.listEvents({
      limit: 1,
      newestFirst: true
    }));
    cursor = eventSequence(latest[0]);
  };

  const poll = async () => {
    if (polling || !listeners.size) {
      return;
    }
    polling = true;
    try {
      await initializeCursor();
      const events = normalizeArray(await vaultClient.listEvents({
        afterSequence: cursor,
        limit: DEFAULT_POLL_LIMIT,
        newestFirst: false
      }));
      for (const event of events) {
        notify(event);
      }
    } catch (error) {
      logger?.warn?.("Sage live event hub poll failed.", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      polling = false;
    }
  };

  const start = () => {
    if (poller) {
      return;
    }
    void poll();
    poller = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    poller.unref?.();
  };

  const stop = () => {
    if (!poller || listeners.size) {
      return;
    }
    clearInterval(poller);
    poller = 0;
  };

  return {
    getCursor: () => cursor,
    publish: (event) => {
      if (event && typeof event === "object") {
        notify(event);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        stop();
      };
    }
  };
};

export default createLiveEventHub;
