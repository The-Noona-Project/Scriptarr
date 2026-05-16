import path from "node:path";

/**
 * Create the embedded Next.js runtime Moon uses for the dedicated reader app.
 *
 * @param {{logger?: {info: Function, warn: Function}}} [options]
 * @returns {Promise<null | {
 *   handle: (request: import("http").IncomingMessage, response: import("http").ServerResponse) => Promise<void>
 * }>}
 */
export const createReaderNextRuntime = async ({logger} = {}) => {
  if (process.env.NODE_ENV === "test") {
    return null;
  }

  const readerAppDir = path.join(process.cwd(), "apps", "reader-next");
  const nextFactory = (await import("next")).default;

  const runtime = nextFactory({
    dev: false,
    dir: readerAppDir,
    customServer: true
  });

  try {
    await runtime.prepare();
  } catch (error) {
    logger?.warn?.("Moon Next reader runtime could not prepare.", {
      dir: readerAppDir,
      error
    });
    return null;
  }

  logger?.info?.("Moon Next reader runtime prepared.", {dir: readerAppDir});

  const handler = runtime.getRequestHandler();

  return {
    handle: async (request, response) => {
      await handler(request, response);
    }
  };
};

export default createReaderNextRuntime;
