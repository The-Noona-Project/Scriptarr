import {setDefaultResultOrder} from "node:dns";
import {createLogger} from "@scriptarr/logging";
import {createMoonApp} from "./lib/createMoonApp.mjs";

setDefaultResultOrder("ipv4first");

const logger = createLogger("MOON");
let app;

try {
  const built = await createMoonApp({logger});
  app = built.app;

  if (process.env.NODE_ENV !== "test") {
    const server = app.listen(built.config.port, () => {
      logger.info("Moon listening.", {
        port: built.config.port
      });
    });
    built.attachLiveWebSocketServer?.(server);
    server.on("error", (error) => {
      logger.error("Moon listener failed.", {error});
    });
  }
} catch (error) {
  logger.error("Moon failed to start.", {error});
  throw error;
}

export default app;
