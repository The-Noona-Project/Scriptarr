/**
 * @file Scriptarr Warden module: services/warden/server.mjs.
 */
import {createWardenApp} from "./api/createWardenApp.mjs";

const {app, config, logger, runtime} = createWardenApp();

if (process.env.NODE_ENV !== "test") {
  try {
    const server = app.listen(config.port, config.host, () => {
      logger.info("Warden listening.", {
        port: config.port,
        host: config.host || "0.0.0.0",
        stackMode: config.stackMode
      });
    });
    server.on("error", (error) => {
      logger.error("Warden listener failed.", {error});
    });
    void runtime.initialize().catch((error) => {
      logger.error("Warden initialization failed.", {error});
    });
  } catch (error) {
    logger.error("Warden failed to start.", {error});
    throw error;
  }
}

export default app;

