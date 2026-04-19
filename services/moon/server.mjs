import {createMoonApp} from "./lib/createMoonApp.mjs";

const {app, config} = await createMoonApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    console.log(`scriptarr-moon listening on ${config.port}`);
  });
}

export default app;
