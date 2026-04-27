/**
 * @file Allowlisted Sage system task scheduler and execution runtime.
 */

import {appendDurableEvent, buildServiceActor} from "./adminEvents.mjs";
import {defaultSystemTimezone, getNextCronRuns, normalizeCronSchedule, normalizeString, validateCronExpression} from "./systemCron.mjs";
import {buildSystemStatusPayload} from "./systemStatusRegistry.mjs";
import {runUnavailableRequestSweep} from "./unavailableRequestSweep.mjs";

const SETTINGS_KEY = "sage.systemTasks";
const OWNER_SERVICE = "scriptarr-sage";
const JOB_KIND = "system-task";
const RUN_INTERVAL_MS = 60 * 1000;

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = {}) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

const DEFAULT_TASKS = Object.freeze([
  {
    taskId: "health-status-snapshot",
    label: "Health/status snapshot",
    description: "Probe safe read endpoints and write a durable system event summary.",
    cronExpression: "*/15 * * * *",
    enabled: true
  },
  {
    taskId: "update-check",
    label: "Update check",
    description: "Ask Warden to refresh managed image update availability.",
    cronExpression: "0 */6 * * *",
    enabled: true
  },
  {
    taskId: "event-retention-prune",
    label: "Event retention prune",
    description: "Prune durable events older than the configured Vault retention window.",
    cronExpression: "15 3 * * *",
    enabled: true
  },
  {
    taskId: "unavailable-request-sweep",
    label: "Unavailable request sweep",
    description: "Re-check metadata-only unavailable requests for newly available sources.",
    cronExpression: "0 */4 * * *",
    enabled: true
  },
  {
    taskId: "metadata-gap-scan",
    label: "Metadata-gap scan",
    description: "Scan imported titles for missing provider match, summary, cover, or tags.",
    cronExpression: "30 2 * * *",
    enabled: true
  },
  {
    taskId: "stale-queue-cleanup",
    label: "Stale queue cleanup",
    description: "Inspect Raven queue state for failed or stale title work needing recovery.",
    cronExpression: "*/30 * * * *",
    enabled: true
  }
]);

/**
 * Create the task runtime used by Sage and Moon admin.
 *
 * @param {{
 *   config: Record<string, unknown>,
 *   vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>,
 *   serviceJson: Function,
 *   logger?: {info?: Function, warn?: Function, error?: Function},
 *   readRequestWorkflowSettings: () => Promise<Record<string, unknown>>
 * }} options
 * @returns {Record<string, Function>}
 */
export const createSystemTaskRuntime = ({
  config,
  vaultClient,
  serviceJson,
  logger,
  readRequestWorkflowSettings
}) => {
  const runningTaskIds = new Set();
  let timer = null;

  const taskById = new Map(DEFAULT_TASKS.map((task) => [task.taskId, task]));

  const readStoredSettings = async () => {
    const record = await vaultClient.getSetting(SETTINGS_KEY);
    return normalizeObject(record?.value, {});
  };

  const writeStoredSettings = async (next) => vaultClient.setSetting(SETTINGS_KEY, {
    key: SETTINGS_KEY,
    ...next
  });

  const readSchedules = async () => {
    const stored = await readStoredSettings();
    const tasks = normalizeObject(stored.tasks, {});
    const timezone = normalizeString(stored.timezone, defaultSystemTimezone());
    return {
      timezone,
      tasks: Object.fromEntries(DEFAULT_TASKS.map((definition) => {
        const configured = normalizeObject(tasks[definition.taskId], {});
        return [definition.taskId, {
          ...definition,
          ...configured,
          timezone: normalizeString(configured.timezone, timezone)
        }];
      }))
    };
  };

  const listTaskRuns = async (taskId) => {
    const jobs = normalizeArray(await vaultClient.listJobs({
      ownerService: OWNER_SERVICE,
      kind: JOB_KIND
    }));
    return jobs
      .filter((job) => normalizeString(job.payload?.taskId) === taskId)
      .sort((left, right) => Date.parse(right.createdAt || right.updatedAt || "") - Date.parse(left.createdAt || left.updatedAt || ""))
      .slice(0, 8);
  };

  const decorateTask = async (definition) => {
    const schedule = normalizeCronSchedule(definition, definition);
    const runs = await listTaskRuns(definition.taskId);
    const lastRun = runs[0] || null;
    return {
      taskId: definition.taskId,
      label: definition.label,
      description: definition.description,
      enabled: schedule.enabled,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      valid: schedule.valid,
      error: schedule.error,
      nextRuns: schedule.nextRuns,
      running: runningTaskIds.has(definition.taskId),
      lastRun,
      recentRuns: runs
    };
  };

  const getTaskPayload = async () => {
    const schedules = await readSchedules();
    const tasks = await Promise.all(Object.values(schedules.tasks).map(decorateTask));
    return {
      generatedAt: new Date().toISOString(),
      timezone: schedules.timezone,
      tasks
    };
  };

  const persistTaskSchedule = async (taskId, patch) => {
    const definition = taskById.get(taskId);
    if (!definition) {
      const error = new Error("Unknown system task.");
      error.status = 404;
      throw error;
    }
    const schedules = await readSchedules();
    const current = normalizeObject(schedules.tasks[taskId], definition);
    const next = {
      ...current,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      cronExpression: normalizeString(patch.cronExpression, current.cronExpression),
      timezone: normalizeString(patch.timezone, current.timezone)
    };
    const validation = validateCronExpression(next.cronExpression);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = 400;
      throw error;
    }
    await writeStoredSettings({
      timezone: schedules.timezone,
      tasks: {
        ...schedules.tasks,
        [taskId]: next
      }
    });
    return decorateTask(next);
  };

  const previewTaskSchedule = async (taskId, patch = {}) => {
    const definition = taskById.get(taskId);
    if (!definition) {
      const error = new Error("Unknown system task.");
      error.status = 404;
      throw error;
    }
    const schedules = await readSchedules();
    const current = normalizeObject(schedules.tasks[taskId], definition);
    const cronExpression = normalizeString(patch.cronExpression, current.cronExpression);
    const timezone = normalizeString(patch.timezone, current.timezone);
    const validation = validateCronExpression(cronExpression);
    return {
      taskId,
      valid: validation.valid,
      error: validation.error,
      timezone,
      cronExpression,
      nextRuns: validation.valid ? getNextCronRuns(cronExpression, {timezone, count: 8}) : []
    };
  };

  const executeTaskWork = async (taskId) => {
    switch (taskId) {
      case "health-status-snapshot": {
        const status = await buildSystemStatusPayload({config, serviceJson, includeChecks: true});
        return {summary: status.summary};
      }
      case "update-check": {
        const result = await serviceJson(config.wardenBaseUrl, "/api/updates/check", {method: "POST", body: {services: []}});
        if (!result.ok) {
          throw new Error(result.payload?.error || "Warden update check failed.");
        }
        return result.payload;
      }
      case "event-retention-prune":
        return vaultClient.pruneEvents(180);
      case "unavailable-request-sweep":
        return runUnavailableRequestSweep({
          config,
          vaultClient,
          serviceJson,
          logger,
          readRequestWorkflowSettings
        });
      case "metadata-gap-scan": {
        const result = await serviceJson(config.ravenBaseUrl, "/v1/library");
        if (!result.ok) {
          throw new Error(result.payload?.error || "Raven library scan failed.");
        }
        const titles = normalizeArray(result.payload?.titles);
        const missing = titles.filter((title) =>
          !normalizeString(title.metadataProvider)
          || !normalizeString(title.metadataMatchedAt)
          || !normalizeString(title.summary)
          || !normalizeString(title.coverUrl)
          || !normalizeArray(title.tags).length
        );
        return {titleCount: titles.length, gapCount: missing.length};
      }
      case "stale-queue-cleanup": {
        const result = await serviceJson(config.ravenBaseUrl, "/v1/downloads/tasks");
        if (!result.ok) {
          throw new Error(result.payload?.error || "Raven task scan failed.");
        }
        const tasks = normalizeArray(result.payload?.tasks);
        const staleAfterMs = 2 * 60 * 60 * 1000;
        const stale = tasks.filter((task) => {
          const status = normalizeString(task.status).toLowerCase();
          const updated = Date.parse(normalizeString(task.updatedAt));
          return status === "failed" || (["running", "queued"].includes(status) && Number.isFinite(updated) && updated < Date.now() - staleAfterMs);
        });
        return {taskCount: tasks.length, recoveryCount: stale.length};
      }
      default:
        throw new Error("Unknown system task.");
    }
  };

  const runTask = async (taskId, {manual = false, actor = null} = {}) => {
    const definition = taskById.get(taskId);
    if (!definition) {
      const error = new Error("Unknown system task.");
      error.status = 404;
      throw error;
    }
    if (runningTaskIds.has(taskId)) {
      const error = new Error("This task is already running.");
      error.status = 409;
      throw error;
    }

    const jobId = `${JOB_KIND}-${taskId}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    runningTaskIds.add(taskId);
    await vaultClient.upsertJob(jobId, {
      ownerService: OWNER_SERVICE,
      kind: JOB_KIND,
      label: definition.label,
      status: "running",
      percent: 5,
      message: manual ? "Manual task run started." : "Scheduled task run started.",
      requestedBy: actor?.actorId || "scriptarr-sage",
      payload: {
        taskId,
        manual
      },
      createdAt: startedAt,
      updatedAt: startedAt
    });
    await vaultClient.upsertJobTask(jobId, taskId, {
      label: definition.label,
      status: "running",
      percent: 5,
      message: "Running task action.",
      sortOrder: 0
    });

    try {
      const result = await executeTaskWork(taskId);
      const completedAt = new Date().toISOString();
      await vaultClient.upsertJobTask(jobId, taskId, {
        label: definition.label,
        status: "completed",
        percent: 100,
        message: "Task completed.",
        result,
        sortOrder: 0,
        updatedAt: completedAt
      });
      const job = await vaultClient.upsertJob(jobId, {
        ownerService: OWNER_SERVICE,
        kind: JOB_KIND,
        label: definition.label,
        status: "completed",
        percent: 100,
        message: "Task completed.",
        requestedBy: actor?.actorId || "scriptarr-sage",
        payload: {
          taskId,
          manual
        },
        result,
        updatedAt: completedAt
      });
      await appendDurableEvent(vaultClient, {
        ...(actor || buildServiceActor(OWNER_SERVICE, "Scriptarr Sage")),
        domain: "system",
        eventType: "system-task-completed",
        severity: "info",
        targetType: "task",
        targetId: taskId,
        message: `${definition.label} completed.`,
        metadata: {
          jobId,
          manual,
          result
        }
      }, logger);
      return job;
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      await vaultClient.upsertJobTask(jobId, taskId, {
        label: definition.label,
        status: "failed",
        percent: 100,
        message,
        sortOrder: 0,
        updatedAt: failedAt
      });
      const job = await vaultClient.upsertJob(jobId, {
        ownerService: OWNER_SERVICE,
        kind: JOB_KIND,
        label: definition.label,
        status: "failed",
        percent: 100,
        message,
        requestedBy: actor?.actorId || "scriptarr-sage",
        payload: {
          taskId,
          manual
        },
        updatedAt: failedAt
      });
      await appendDurableEvent(vaultClient, {
        ...(actor || buildServiceActor(OWNER_SERVICE, "Scriptarr Sage")),
        domain: "system",
        eventType: "system-task-failed",
        severity: "warning",
        targetType: "task",
        targetId: taskId,
        message: `${definition.label} failed: ${message}`,
        metadata: {
          jobId,
          manual
        }
      }, logger);
      return job;
    } finally {
      runningTaskIds.delete(taskId);
    }
  };

  const markScheduled = async (taskId, scheduledAt) => {
    const schedules = await readSchedules();
    const current = normalizeObject(schedules.tasks[taskId], taskById.get(taskId));
    await writeStoredSettings({
      timezone: schedules.timezone,
      tasks: {
        ...schedules.tasks,
        [taskId]: {
          ...current,
          lastScheduledAt: scheduledAt
        }
      }
    });
  };

  const runDueTasks = async () => {
    const schedules = await readSchedules();
    const now = new Date();
    for (const task of Object.values(schedules.tasks)) {
      if (!task.enabled || runningTaskIds.has(task.taskId)) {
        continue;
      }
      const validation = validateCronExpression(task.cronExpression);
      if (!validation.valid) {
        continue;
      }
      const dueRuns = getNextCronRuns(task.cronExpression, {
        timezone: task.timezone,
        from: new Date(now.getTime() - 2 * 60 * 1000),
        count: 3
      }).filter((runAt) => Date.parse(runAt) <= now.getTime());
      const latestDue = dueRuns[dueRuns.length - 1];
      if (!latestDue || latestDue === task.lastScheduledAt) {
        continue;
      }
      await markScheduled(task.taskId, latestDue);
      void runTask(task.taskId, {manual: false}).catch((error) => {
        logger?.warn?.("Scheduled system task failed before job persistence.", {
          taskId: task.taskId,
          error
        });
      });
    }
  };

  const start = () => {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      void runDueTasks().catch((error) => {
        logger?.warn?.("System task scheduler tick failed.", {error});
      });
    }, RUN_INTERVAL_MS);
    timer.unref?.();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    getTaskPayload,
    persistTaskSchedule,
    previewTaskSchedule,
    runDueTasks,
    runTask,
    start,
    stop
  };
};

export default {
  createSystemTaskRuntime
};
