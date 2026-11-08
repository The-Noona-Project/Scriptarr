/**
 * @file Scriptarr Warden module: services/warden/server.mjs.
 */
import {createWardenApp} from "./api/createWardenApp.mjs";
import {createWardenClusterServer} from "./api/controlSecurity.mjs";

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
    const clusterServer = createWardenClusterServer(app);
    if (clusterServer) {
      const agentPort = Number(process.env.SCRIPTARR_WARDEN_AGENT_PORT) || 4401;
      clusterServer.listen(agentPort, process.env.SCRIPTARR_WARDEN_AGENT_HOST || "0.0.0.0", () => {
        logger.info("Warden mutually authenticated agent listener ready.", {port: agentPort});
      });
      clusterServer.on("error", (error) => {
        logger.error("Warden agent listener failed.", {error});
      });
    }
    void runtime.initialize().catch((error) => {
      logger.error("Warden initialization failed.", {error});
    });
  } catch (error) {
    logger.error("Warden failed to start.", {error});
    throw error;
  }
}

export default app;

