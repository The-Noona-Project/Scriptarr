import path from "node:path";

/**
 * Create the embedded Next.js runtime Moon uses for the admin app in real
 * runtime environments.
 *
 * @param {{logger?: {info: Function, warn: Function}}} [options]
 * @returns {Promise<null | {
 *   handle: (request: import("http").IncomingMessage, response: import("http").ServerResponse) => Promise<void>
 * }>}
 */
export const createAdminNextRuntime = async ({logger} = {}) => {
  if (process.env.NODE_ENV === "test") {
    return null;
  }

  const adminAppDir = path.join(process.cwd(), "apps", "admin-next");
  const nextFactory = (await import("next")).default;

  const runtime = nextFactory({
    dev: false,
    dir: adminAppDir,
    customServer: true
  });

  try {
    await runtime.prepare();
  } catch (error) {
    logger?.warn?.("Moon Next admin runtime could not prepare.", {
      dir: adminAppDir,
      error
    });
    return null;
  }

  logger?.info?.("Moon Next admin runtime prepared.", {dir: adminAppDir});

  const handler = runtime.getRequestHandler();

  return {
    handle: async (request, response) => {
      await handler(request, response);
    }
  };
};

export default createAdminNextRuntime;
