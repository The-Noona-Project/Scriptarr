import {createLogger} from "@scriptarr/logging";
import {createVaultApp} from "./lib/createVaultApp.mjs";

const logger = createLogger("VAULT");
let app;

try {
  const built = await createVaultApp({logger});
  app = built.app;

  if (process.env.NODE_ENV !== "test") {
    const server = app.listen(built.config.port, () => {
      logger.info("Vault listening.", {
        port: built.config.port
      });
    });
    server.on("error", (error) => {
      logger.error("Vault listener failed.", {error});
    });
  }
} catch (error) {
  logger.error("Vault failed to start.", {error});
  throw error;
}

export default app;
