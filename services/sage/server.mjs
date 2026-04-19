/**
 * @file Scriptarr Sage module: services/sage/server.mjs.
 */
import {createLogger} from "@scriptarr/logging";
import {createSageApp} from "./lib/createSageApp.mjs";

const logger = createLogger("SAGE");
let app;

try {
  const built = await createSageApp({logger});
  app = built.app;

  if (process.env.NODE_ENV !== "test") {
    const server = app.listen(built.config.port, () => {
      logger.info("Sage listening.", {
        port: built.config.port
      });
    });
    server.on("error", (error) => {
      logger.error("Sage listener failed.", {error});
    });
  }
} catch (error) {
  logger.error("Sage failed to start.", {error});
  throw error;
}

export default app;

