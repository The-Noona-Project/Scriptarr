import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.SCRIPTARR_VAULT_DRIVER = "memory";
process.env.SCRIPTARR_SERVICE_TOKENS = JSON.stringify({"scriptarr-oracle": "oracle-dev-token"});
process.env.SCRIPTARR_SERVICE_TOKEN = "oracle-dev-token";

const {createVaultApp} = await import("../../vault/lib/createVaultApp.mjs");
const {createOracleApp} = await import("../lib/createOracleApp.mjs");

test("oracle starts disabled and reports the off-state cleanly", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;

  const {app: oracleApp} = await createOracleApp();
  const oracleServer = oracleApp.listen(0);
  const baseUrl = `http://127.0.0.1:${oracleServer.address().port}`;

  const payload = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({message: "Tell me something about the library"})
  }).then((response) => response.json());

  assert.equal(payload.ok, true);
  assert.equal(payload.disabled, true);

  oracleServer.close();
  vaultServer.close();
});
