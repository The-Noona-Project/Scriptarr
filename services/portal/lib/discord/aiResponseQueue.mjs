/**
 * Small FIFO queue for Discord AI responses.
 */

const createQueueCancelError = (reason = "AI response queue was cancelled.") => {
  const error = new Error(reason);
  error.name = "AbortError";
  error.code = "AI_RESPONSE_QUEUE_CANCELLED";
  return error;
};

export const isAiResponseQueueCancelError = (error) =>
  error?.code === "AI_RESPONSE_QUEUE_CANCELLED" || error?.name === "AbortError";

const resolveCancelError = (signal, fallback) =>
  signal?.reason instanceof Error ? signal.reason : createQueueCancelError(fallback);

export const createAiResponseQueue = ({maxQueued = 25} = {}) => {
  let active = false;
  let pending = 0;
  let tail = Promise.resolve();
  let nextId = 0;
  const controllers = new Map();

  const run = async (task, hooks = {}) => {
    if (pending + (active ? 1 : 0) >= maxQueued) {
      throw new Error(`AI response queue is full (${maxQueued} queued request(s)).`);
    }
    const requestId = ++nextId;
    const ahead = (active ? 1 : 0) + pending;
    const controller = new AbortController();
    controllers.set(requestId, controller);
    pending += 1;
    const previous = tail.catch(() => {});
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    tail = previous.then(() => current);

    let started = false;
    try {
      if (controller.signal.aborted) {
        throw resolveCancelError(controller.signal);
      }
      await hooks.onQueued?.({ahead, requestId});
      await previous;
      if (controller.signal.aborted) {
        throw resolveCancelError(controller.signal);
      }
      pending = Math.max(0, pending - 1);
      active = true;
      started = true;
      await hooks.onStart?.({ahead, requestId});
      if (controller.signal.aborted) {
        throw resolveCancelError(controller.signal);
      }
      const result = await task({ahead, requestId, signal: controller.signal});
      if (controller.signal.aborted) {
        throw resolveCancelError(controller.signal);
      }
      return result;
    } finally {
      if (started) {
        active = false;
      } else {
        pending = Math.max(0, pending - 1);
      }
      controllers.delete(requestId);
      release?.();
    }
  };

  const cancelAll = (reason = "AI response queue was cancelled.") => {
    for (const controller of controllers.values()) {
      controller.abort(createQueueCancelError(reason));
    }
  };

  return {
    run,
    cancelAll,
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
