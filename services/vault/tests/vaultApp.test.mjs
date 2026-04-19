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

test("vault persists generic jobs and job tasks through the service API", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const job = await fetch(`${baseUrl}/api/service/jobs/job-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      kind: "service-update",
      ownerService: "scriptarr-warden",
      status: "running",
      label: "Managed service update",
      payload: {
        requestedServices: ["scriptarr-moon"]
      }
    })
  }).then((response) => response.json());

  assert.equal(job.jobId, "job-1");
  assert.equal(job.kind, "service-update");

  const task = await fetch(`${baseUrl}/api/service/jobs/job-1/tasks/task-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      taskKey: "pull-images",
      label: "Pull candidate images",
      status: "completed",
      percent: 100
    })
  }).then((response) => response.json());

  assert.equal(task.taskId, "task-1");
  assert.equal(task.jobId, "job-1");

  const listedJobs = await fetch(`${baseUrl}/api/service/jobs?ownerService=scriptarr-warden&kind=service-update`, {
    headers
  }).then((response) => response.json());
  assert.equal(listedJobs.length, 1);
  assert.equal(listedJobs[0].jobId, "job-1");

  const listedTasks = await fetch(`${baseUrl}/api/service/jobs/job-1/tasks`, {
    headers
  }).then((response) => response.json());
  assert.equal(listedTasks.length, 1);
  assert.equal(listedTasks[0].taskKey, "pull-images");

  server.close();
});

test("vault returns conflicts for duplicate owner claims and stale request revisions", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const firstOwner = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "owner-1",
      username: "Owner One",
      claimOwner: true
    })
  });
  assert.equal(firstOwner.status, 200);

  const duplicateOwner = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "owner-2",
      username: "Owner Two",
      claimOwner: true
    })
  });
  assert.equal(duplicateOwner.status, 409);
  assert.equal((await duplicateOwner.json()).code, "OWNER_ALREADY_CLAIMED");

  const request = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "Blame!",
      requestType: "manga",
      notes: "",
      requestedBy: "owner-1"
    })
  }).then((response) => response.json());

  const approved = await fetch(`${baseUrl}/api/service/requests/${request.id}/review`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      status: "approved",
      comment: "Approved once.",
      actor: "owner-1",
      revision: request.revision
    })
  });
  assert.equal(approved.status, 200);

  const stale = await fetch(`${baseUrl}/api/service/requests/${request.id}/review`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      status: "denied",
      comment: "This should conflict.",
      actor: "owner-1",
      revision: request.revision
    })
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "REQUEST_REVISION_CONFLICT");

  server.close();
});
