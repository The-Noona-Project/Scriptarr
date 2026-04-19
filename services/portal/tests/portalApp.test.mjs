import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {createPortalApp} = await import("../lib/createPortalApp.mjs");

test("portal exposes the new Discord command catalog", async () => {
  const {app} = await createPortalApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const payload = await fetch(`${baseUrl}/api/commands`).then((response) => response.json());
  assert.ok(payload.commands.some((command) => command.name === "chat"));
  assert.ok(payload.commands.some((command) => command.name === "request"));

  server.close();
});
