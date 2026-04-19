import {createPortalApp} from "./lib/createPortalApp.mjs";

const {app, config} = await createPortalApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    console.log(`scriptarr-portal listening on ${config.port}`);
  });
}

export default app;
