import {createLogger} from "@scriptarr/logging";
import {createOracleApp} from "./lib/createOracleApp.mjs";

const logger = createLogger("ORACLE");
let app;

try {
  const built = await createOracleApp({logger});
  app = built.app;

  if (process.env.NODE_ENV !== "test") {
    const server = app.listen(built.config.port, () => {
      logger.info("Oracle listening.", {
        port: built.config.port
      });
    });
    server.on("error", (error) => {
      logger.error("Oracle listener failed.", {error});
    });
  }
} catch (error) {
  logger.error("Oracle failed to start.", {error});
  throw error;
}

export default app;
