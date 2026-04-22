import path from "node:path";

/**
 * Create the embedded Next.js runtime Moon uses for the user app in real
 * runtime environments.
 *
 * @param {{logger?: {info: Function, warn: Function}}} [options]
 * @returns {Promise<null | {
 *   handle: (request: import("http").IncomingMessage, response: import("http").ServerResponse) => Promise<void>
 * }>}
 */
export const createUserNextRuntime = async ({logger} = {}) => {
  if (process.env.NODE_ENV === "test") {
    return null;
  }

  const userAppDir = path.join(process.cwd(), "apps", "user-next");
  const nextFactory = (await import("next")).default;

  const runtime = nextFactory({
    dev: false,
    dir: userAppDir,
    customServer: true
  });

  await runtime.prepare();
  logger?.info?.("Moon Next user runtime prepared.", {dir: userAppDir});

  const handler = runtime.getRequestHandler();

  return {
    handle: async (request, response) => {
      await handler(request, response);
    }
  };
};

export default createUserNextRuntime;
