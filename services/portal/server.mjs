import {createLogger} from "@scriptarr/logging";
import {createPortalApp} from "./lib/createPortalApp.mjs";

const logger = createLogger("PORTAL");
let app;

try {
  const built = await createPortalApp({logger});
  app = built.app;

  if (process.env.NODE_ENV !== "test") {
    const server = app.listen(built.config.port, () => {
      logger.info("Portal listening.", {
        port: built.config.port
      });
    });
    server.on("error", (error) => {
      logger.error("Portal listener failed.", {error});
    });
  }
} catch (error) {
  logger.error("Portal failed to start.", {error});
  throw error;
}

export default app;
