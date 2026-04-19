import test from "node:test";
import assert from "node:assert/strict";

process.env.SCRIPTARR_VAULT_DRIVER = "memory";
process.env.SCRIPTARR_SERVICE_TOKENS = JSON.stringify({"scriptarr-sage": "sage-dev-token"});

const {createVaultApp} = await import("../lib/createVaultApp.mjs");

test("vault exposes bootstrap status and request moderation flow", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const bootstrap = await fetch(`${baseUrl}/api/public/bootstrap-status`).then((response) => response.json());
  assert.equal(bootstrap.ownerClaimed, false);

  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const request = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "Dandadan",
      requestType: "manga",
      notes: "Please add volume extras",
      requestedBy: "123"
    })
  }).then((response) => response.json());

  assert.equal(request.status, "pending");

  const reviewed = await fetch(`${baseUrl}/api/service/requests/${request.id}/review`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      status: "approved",
      comment: "Queued for Raven after moderation.",
      actor: "owner"
    })
  }).then((response) => response.json());

  assert.equal(reviewed.status, "approved");
  assert.equal(reviewed.timeline.at(-1).actor, "owner");

  const setting = await fetch(`${baseUrl}/api/service/settings/oracle.settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      value: {
        enabled: false,
        provider: "openai"
      }
    })
  }).then((response) => response.json());

  assert.equal(setting.value.provider, "openai");

  const secret = await fetch(`${baseUrl}/api/service/secrets/oracle.openai.apiKey`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      value: "test-openai-key"
    })
  }).then((response) => response.json());

  assert.equal(secret.value, "test-openai-key");

  server.close();
});
