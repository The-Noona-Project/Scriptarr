import test from "node:test";
import assert from "node:assert/strict";
import {
  getNextCronRuns,
  normalizeCronSchedule,
  parseCronExpression,
  validateCronExpression
} from "../lib/systemCron.mjs";

test("system cron parser validates five-field expressions", () => {
  const parsed = parseCronExpression("*/15 1-5 * * 1,3");
  assert.equal(parsed.expression, "*/15 1-5 * * 1,3");
  assert.equal(parsed.fields[0].values.has(30), true);
  assert.equal(parsed.fields[1].values.has(6), false);
  assert.equal(validateCronExpression("bad cron").valid, false);
});

test("system cron preview returns stable future runs", () => {
  const runs = getNextCronRuns("0 * * * *", {
    timezone: "UTC",
    from: "2026-04-25T10:15:00.000Z",
    count: 3
  });
  assert.deepEqual(runs, [
    "2026-04-25T11:00:00.000Z",
    "2026-04-25T12:00:00.000Z",
    "2026-04-25T13:00:00.000Z"
  ]);
});

test("system cron schedule normalization reports invalid cron without throwing", () => {
  const schedule = normalizeCronSchedule({
    enabled: true,
    cronExpression: "70 * * * *",
    timezone: "UTC"
  }, {});
  assert.equal(schedule.valid, false);
  assert.match(schedule.error, /minute/);
  assert.deepEqual(schedule.nextRuns, []);
});
