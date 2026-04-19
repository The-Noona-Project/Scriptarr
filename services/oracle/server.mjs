import {createOracleApp} from "./lib/createOracleApp.mjs";

const {app, config} = await createOracleApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    console.log(`scriptarr-oracle listening on ${config.port}`);
  });
}

export default app;
