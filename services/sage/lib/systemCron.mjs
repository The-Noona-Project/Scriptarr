/**
 * @file Cron parsing and next-run helpers for Scriptarr's allowlisted system tasks.
 */

const FIELD_RANGES = Object.freeze([
  {name: "minute", min: 0, max: 59},
  {name: "hour", min: 0, max: 23},
  {name: "day of month", min: 1, max: 31},
  {name: "month", min: 1, max: 12},
  {name: "day of week", min: 0, max: 7}
]);

/**
 * Normalize a string value.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Return Sage's best default timezone label.
 *
 * @returns {string}
 */
export const defaultSystemTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const parseNumber = (value, field) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${field.name} value "${value}".`);
  }
  if (parsed < field.min || parsed > field.max) {
    throw new Error(`${field.name} value ${parsed} is outside ${field.min}-${field.max}.`);
  }
  return field.name === "day of week" && parsed === 7 ? 0 : parsed;
};

const parseCronField = (rawValue, field) => {
  const raw = normalizeString(rawValue);
  if (!raw) {
    throw new Error(`Missing ${field.name} field.`);
  }

  const values = new Set();
  const restricted = raw !== "*";
  for (const part of raw.split(",")) {
    const segment = normalizeString(part);
    if (!segment) {
      throw new Error(`Empty ${field.name} segment.`);
    }
    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart == null ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid ${field.name} step "${stepPart}".`);
    }

    let start = field.min;
    let end = field.max;
    if (rangePart !== "*") {
      const [startPart, endPart] = rangePart.split("-");
      start = parseNumber(startPart, field);
      end = endPart == null ? start : parseNumber(endPart, field);
      if (end < start && field.name !== "day of week") {
        throw new Error(`${field.name} range must ascend.`);
      }
    }

    if (field.name === "day of week" && end < start) {
      for (let value = start; value <= field.max; value += step) {
        values.add(value === 7 ? 0 : value);
      }
      for (let value = field.min; value <= end; value += step) {
        values.add(value === 7 ? 0 : value);
      }
      continue;
    }

    for (let value = start; value <= end; value += step) {
      values.add(field.name === "day of week" && value === 7 ? 0 : value);
    }
  }

  if (!values.size) {
    throw new Error(`No ${field.name} values matched.`);
  }
  return {
    values,
    restricted
  };
};

/**
 * Parse a standard five-field cron expression.
 *
 * @param {unknown} expression
 * @returns {{expression: string, fields: Array<{values: Set<number>, restricted: boolean}>}}
 */
export const parseCronExpression = (expression) => {
  const normalized = normalizeString(expression);
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error("Cron must use five fields: minute hour day month weekday.");
  }
  return {
    expression: normalized,
    fields: parts.map((part, index) => parseCronField(part, FIELD_RANGES[index]))
  };
};

/**
 * Validate a cron expression without throwing.
 *
 * @param {unknown} expression
 * @returns {{valid: boolean, error: string}}
 */
export const validateCronExpression = (expression) => {
  try {
    parseCronExpression(expression);
    return {valid: true, error: ""};
  } catch (error) {
    return {valid: false, error: error instanceof Error ? error.message : String(error)};
  }
};

const zonedParts = (date, timezone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour === "24" ? 0 : parts.hour);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  return {
    minute: Number(parts.minute),
    hour,
    day,
    month,
    dayOfWeek: localDate.getUTCDay()
  };
};

const matchesCron = (parsed, parts) => {
  const [minutes, hours, days, months, weekdays] = parsed.fields;
  if (!minutes.values.has(parts.minute) || !hours.values.has(parts.hour) || !months.values.has(parts.month)) {
    return false;
  }
  const dayMatches = days.values.has(parts.day);
  const weekdayMatches = weekdays.values.has(parts.dayOfWeek);
  if (days.restricted && weekdays.restricted) {
    return dayMatches || weekdayMatches;
  }
  return dayMatches && weekdayMatches;
};

/**
 * Compute upcoming run timestamps for a five-field cron expression.
 *
 * @param {unknown} expression
 * @param {{timezone?: string, from?: Date | string | number, count?: number}} [options]
 * @returns {string[]}
 */
export const getNextCronRuns = (expression, {timezone = defaultSystemTimezone(), from = new Date(), count = 5} = {}) => {
  const parsed = parseCronExpression(expression);
  const targetCount = Math.max(1, Math.min(20, Number.parseInt(String(count), 10) || 5));
  const start = new Date(from);
  const cursor = new Date(start.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const maxIterations = 366 * 24 * 60;
  const runs = [];

  for (let index = 0; index < maxIterations && runs.length < targetCount; index += 1) {
    if (matchesCron(parsed, zonedParts(cursor, timezone))) {
      runs.push(cursor.toISOString());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  if (runs.length === 0) {
    throw new Error("Cron expression produced no runs in the next year.");
  }
  return runs;
};

/**
 * Normalize a task schedule payload.
 *
 * @param {Record<string, unknown>} value
 * @param {Record<string, unknown>} fallback
 * @returns {{enabled: boolean, cronExpression: string, timezone: string, nextRuns: string[], valid: boolean, error: string}}
 */
export const normalizeCronSchedule = (value = {}, fallback = {}) => {
  const cronExpression = normalizeString(value.cronExpression, normalizeString(fallback.cronExpression, "0 * * * *"));
  const timezone = normalizeString(value.timezone, normalizeString(fallback.timezone, defaultSystemTimezone()));
  const enabled = typeof value.enabled === "boolean" ? value.enabled : Boolean(fallback.enabled);
  const validation = validateCronExpression(cronExpression);
  return {
    enabled,
    cronExpression,
    timezone,
    nextRuns: validation.valid ? getNextCronRuns(cronExpression, {timezone, count: 5}) : [],
    valid: validation.valid,
    error: validation.error
  };
};

export default {
  defaultSystemTimezone,
  getNextCronRuns,
  normalizeCronSchedule,
  parseCronExpression,
  validateCronExpression
};
