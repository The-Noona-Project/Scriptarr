import {createVaultApp} from "./lib/createVaultApp.mjs";

const {app, config} = await createVaultApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    console.log(`scriptarr-vault listening on ${config.port}`);
  });
}

export default app;
