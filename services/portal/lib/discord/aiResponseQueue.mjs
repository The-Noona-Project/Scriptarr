/**
 * Small FIFO queue for Discord AI responses.
 */

export const createAiResponseQueue = () => {
  let active = false;
  let pending = 0;
  let tail = Promise.resolve();
  let nextId = 0;

  const run = async (task, hooks = {}) => {
    const requestId = ++nextId;
    const ahead = (active ? 1 : 0) + pending;
    pending += 1;
    const previous = tail.catch(() => {});
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    tail = previous.then(() => current);

    let started = false;
    try {
      await hooks.onQueued?.({ahead, requestId});
      await previous;
      pending = Math.max(0, pending - 1);
      active = true;
      started = true;
      await hooks.onStart?.({ahead, requestId});
      return await task({ahead, requestId});
    } finally {
      if (started) {
        active = false;
      } else {
        pending = Math.max(0, pending - 1);
      }
      release?.();
    }
  };

  return {
    run,
    getState() {
      return {
        active,
        pending,
        queued: pending + (active ? 1 : 0)
      };
    }
  };
};

export default createAiResponseQueue;
