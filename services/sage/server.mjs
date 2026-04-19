import {createSageApp} from "./lib/createSageApp.mjs";

const {app, config} = await createSageApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    console.log(`scriptarr-sage listening on ${config.port}`);
  });
}

export default app;
