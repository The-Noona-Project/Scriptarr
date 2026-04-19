/**
 * @file Scriptarr Warden module: services/warden/server.mjs.
 */
import {createWardenApp} from "./api/createWardenApp.mjs";

const {app, config, logger, runtime} = createWardenApp();

if (process.env.NODE_ENV !== "test") {
  await runtime.initialize();
  app.listen(config.port, config.host, () => {
    logger.info("Warden listening.", {
      port: config.port,
      host: config.host || "0.0.0.0",
      stackMode: config.stackMode
    });
  });
}

export default app;

