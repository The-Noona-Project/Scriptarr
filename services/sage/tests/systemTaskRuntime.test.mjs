import test from "node:test";
import assert from "node:assert/strict";
import {createSystemTaskRuntime} from "../lib/systemTaskRuntime.mjs";

const createFakeVault = () => {
  const settings = new Map();
  const jobs = new Map();
  const tasks = new Map();
  return {
    async getSetting(key) {
      return {key, value: settings.get(key) || null};
    },
    async setSetting(key, value) {
      settings.set(key, value);
      return {key, value};
    },
    async listJobs(filters = {}) {
      return Array.from(jobs.values()).filter((job) =>
        (!filters.ownerService || job.ownerService === filters.ownerService)
        && (!filters.kind || job.kind === filters.kind)
        && (!filters.status || job.status === filters.status)
      );
    },
    async upsertJob(jobId, payload) {
      const next = {
        ...(jobs.get(jobId) || {}),
        ...payload,
        jobId,
        createdAt: payload.createdAt || jobs.get(jobId)?.createdAt || new Date().toISOString(),
        updatedAt: payload.updatedAt || new Date().toISOString()
      };
      jobs.set(jobId, next);
      return next;
    },
    async listJobTasks(jobId) {
      return Array.from(tasks.values()).filter((task) => task.jobId === jobId);
    },
    async upsertJobTask(jobId, taskId, payload) {
      const key = `${jobId}:${taskId}`;
      const next = {
        ...(tasks.get(key) || {}),
        ...payload,
        jobId,
        taskId,
        updatedAt: payload.updatedAt || new Date().toISOString()
      };
      tasks.set(key, next);
      return next;
    },
    async pruneEvents() {
      return {deletedCount: 0};
    },
    async appendEvent(payload) {
      return payload;
    }
  };
};

test("system task runtime previews, persists schedules, and blocks overlapping runs", async () => {
  const vaultClient = createFakeVault();
  let releaseUpdateCheck;
  const updateCheckGate = new Promise((resolve) => {
    releaseUpdateCheck = resolve;
  });
  const runtime = createSystemTaskRuntime({
    config: {
      wardenBaseUrl: "http://warden.test",
      ravenBaseUrl: "http://raven.test"
    },
    vaultClient,
    serviceJson: async (_baseUrl, path) => {
      if (path === "/api/updates/check") {
        await updateCheckGate;
        return {ok: true, status: 200, payload: {checkedAt: "now"}};
      }
      return {ok: true, status: 200, payload: {tasks: [], titles: []}};
    },
    logger: {},
    readRequestWorkflowSettings: async () => ({autoApproveAndDownload: false})
  });

  const preview = await runtime.previewTaskSchedule("update-check", {
    cronExpression: "0 * * * *",
    timezone: "UTC"
  });
  assert.equal(preview.valid, true);
  assert.equal(preview.nextRuns.length > 0, true);

  const saved = await runtime.persistTaskSchedule("update-check", {
    enabled: false,
    cronExpression: "0 * * * *",
    timezone: "UTC"
  });
  assert.equal(saved.enabled, false);

  const running = runtime.runTask("update-check", {manual: true});
  await assert.rejects(
    () => runtime.runTask("update-check", {manual: true}),
    /already running/
  );
  releaseUpdateCheck();
  const job = await running;
  assert.equal(job.status, "completed");
});
