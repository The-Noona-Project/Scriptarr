/**
 * @file Scriptarr Sage module: services/sage/server.mjs.
 */
import {setDefaultResultOrder} from "node:dns";
import {createLogger} from "@scriptarr/logging";
import {createSageApp} from "./lib/createSageApp.mjs";
import {createWorkerTlsServer} from "./lib/workerTlsServer.mjs";

setDefaultResultOrder("ipv4first");

const logger = createLogger("SAGE");
let app;

try {
  const built = await createSageApp({logger});
  app = built.app;

  if (process.env.NODE_ENV !== "test") {
    const workerServer = createWorkerTlsServer({app, config: built.config});
    const server = app.listen(built.config.port, () => {
      logger.info("Sage listening.", {
        port: built.config.port
      });
    });
    built.attachLiveWebSocketServer?.(server);
    server.on("error", (error) => {
      logger.error("Sage listener failed.", {error});
    });
    if (workerServer) {
      workerServer.listen(built.config.workerTlsPort, built.config.workerTlsHost, () => logger.info("Sage worker HTTPS listening.", {port: built.config.workerTlsPort}));
      workerServer.on("error", error => logger.error("Sage worker HTTPS listener failed.", {error}));
    }
  }
} catch (error) {
  logger.error("Sage failed to start.", {error});
  throw error;
}

export default app;

