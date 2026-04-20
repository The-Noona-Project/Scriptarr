import {createLogger} from "@scriptarr/logging";
import {createPortalApp} from "./lib/createPortalApp.mjs";

const logger = createLogger("PORTAL");
let app;
let runtime;

try {
  const built = await createPortalApp({logger});
  app = built.app;
  runtime = built.runtime;

  if (process.env.NODE_ENV !== "test") {
    const server = app.listen(built.config.port, () => {
      logger.info("Portal listening.", {
        port: built.config.port
      });
    });
    server.on("error", (error) => {
      logger.error("Portal listener failed.", {error});
    });
    void runtime.start();
    const stop = async () => {
      await runtime?.stop?.();
      server.close();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  }
} catch (error) {
  logger.error("Portal failed to start.", {error});
  throw error;
}

export default app;
