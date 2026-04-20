import {Chalk} from "chalk";

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

const SECRET_KEY_PATTERN = /(token|password|secret|api[-_]?key|authorization|cookie)/i;

const SERVICE_THEMES = Object.freeze({
  WARDEN: {color: "cyanBright"},
  VAULT: {color: "greenBright"},
  SAGE: {color: "magentaBright"},
  MOON: {color: "blueBright"},
  PORTAL: {color: "yellowBright"},
  ORACLE: {color: "whiteBright"}
});

const normalizeString = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();

const resolveTagRoot = (tag) => normalizeString(tag).split(/[^A-Za-z0-9]+/)[0].toUpperCase() || "SCRIPTARR";

const resolveTheme = (tag) => SERVICE_THEMES[resolveTagRoot(tag)] || {color: "whiteBright"};

const resolveLevelName = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : "info";
};

const colorsEnabled = (env = process.env) => {
  if (env.NO_COLOR != null && normalizeString(env.NO_COLOR) !== "") {
    return false;
  }

  const configured = normalizeString(env.SCRIPTARR_LOG_COLOR);
  if (configured) {
    return !["0", "false", "no", "off"].includes(configured.toLowerCase());
  }

  const forceColor = normalizeString(env.FORCE_COLOR);
  if (forceColor) {
    return !["0", "false"].includes(forceColor.toLowerCase());
  }

  return true;
};

const createChalkInstance = (env) => new Chalk({level: colorsEnabled(env) ? 3 : 0});

const sanitizeLogLeafValue = (value) => {
  if (value == null) {
    return value;
  }

  if (value instanceof Error) {
    return normalizeString(value.stack || value.message || String(value));
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return normalizeString(value);
  }

  if (typeof value === "symbol") {
    return normalizeString(value.description || value.toString());
  }

  return normalizeString(JSON.stringify(value));
};

const sanitizeRuntimeLeafValue = (value) => {
  if (value == null) {
    return value;
  }

  if (value instanceof Error) {
    return normalizeString(value.message || String(value));
  }

  if (typeof value === "string") {
    return normalizeString(value);
  }

  if (typeof value === "symbol") {
    return normalizeString(value.description || value.toString());
  }

  return value;
};

const shouldPreserveConfiguredFlag = (key, value) => /configured$/i.test(normalizeString(key)) && typeof value === "boolean";

/**
 * Redact sensitive keys from a structured value while preserving the overall
 * shape for operator-facing responses and logs.
 *
 * @param {unknown} value
 * @param {string} [key]
 * @returns {unknown}
 */
export const sanitizeStructuredData = (value, key = "") => {
  if (SECRET_KEY_PATTERN.test(normalizeString(key))) {
    if (shouldPreserveConfiguredFlag(key, value)) {
      return value;
    }

    const normalized = sanitizeRuntimeLeafValue(value);
    return normalized ? "[redacted]" : normalized;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredData(entry, key));
  }

  if (value instanceof Error) {
    return sanitizeRuntimeLeafValue(value);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeStructuredData(entryValue, entryKey)
    ]));
  }

  return sanitizeRuntimeLeafValue(value);
};

const formatDetailValue = (key, value) => {
  const sanitized = sanitizeStructuredData(value, key);
  if (sanitized == null) {
    return "";
  }

  if (typeof sanitized === "string") {
    return sanitized;
  }

  return sanitizeLogLeafValue(sanitized);
};

const renderLine = ({timestamp, levelName, tag, message, details = {}}) => {
  const fragments = Object.entries(details)
    .map(([key, value]) => [key, formatDetailValue(key, value)])
    .filter(([, value]) => value !== "");

  return [
    timestamp,
    levelName.toUpperCase(),
    `[${normalizeString(tag) || "SCRIPTARR"}]`,
    normalizeString(message),
    ...fragments.map(([key, value]) => `${key}=${value}`)
  ].join(" ");
};

/**
 * Create a Scriptarr structured logger with stable service colors and shared
 * redaction rules.
 *
 * @param {string} tag
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   sink?: Console,
 *   color?: string,
 *   levelEnvVars?: string[]
 * }} [options]
 * @returns {{
 *   debug: (message: string, details?: Record<string, unknown>) => void,
 *   info: (message: string, details?: Record<string, unknown>) => void,
 *   warn: (message: string, details?: Record<string, unknown>) => void,
 *   error: (message: string, details?: Record<string, unknown>) => void
 * }}
 */
export const createLogger = (tag, {
  env = process.env,
  sink = console,
  color,
  levelEnvVars = []
} = {}) => {
  const theme = resolveTheme(tag);
  const resolvedLevelEnvVars = levelEnvVars.length > 0
    ? levelEnvVars
    : [`SCRIPTARR_${resolveTagRoot(tag)}_LOG_LEVEL`, "SCRIPTARR_LOG_LEVEL"];
  const configuredLevel = levelEnvVars
    .length > 0
    ? levelEnvVars.map((key) => env[key]).find((value) => normalizeString(value))
    : resolvedLevelEnvVars.map((key) => env[key]).find((value) => normalizeString(value));
  const minimumLevel = LEVELS[resolveLevelName(configuredLevel || "info")];
  const chalk = createChalkInstance(env);

  const write = (levelName, message, details = {}) => {
    if (LEVELS[levelName] < minimumLevel) {
      return;
    }

    const line = renderLine({
      timestamp: new Date().toISOString(),
      levelName,
      tag,
      message,
      details
    });

    const palette = color || theme.color;
    const levelFormatter = {
      debug: chalk.gray,
      info: chalk.greenBright,
      warn: chalk.yellowBright,
      error: chalk.redBright
    }[levelName] || ((value) => value);
    const tagFormatter = typeof chalk[palette] === "function" ? chalk[palette] : chalk.whiteBright;
    const coloredLine = line
      .replace(levelName.toUpperCase(), levelFormatter(levelName.toUpperCase()))
      .replace(`[${normalizeString(tag) || "SCRIPTARR"}]`, tagFormatter(`[${normalizeString(tag) || "SCRIPTARR"}]`));

    if (levelName === "error") {
      sink.error(coloredLine);
      return;
    }

    if (levelName === "warn") {
      sink.warn(coloredLine);
      return;
    }

    sink.log(coloredLine);
  };

  return {
    debug: (message, details) => {
      write("debug", message, details);
    },
    info: (message, details) => {
      write("info", message, details);
    },
    warn: (message, details) => {
      write("warn", message, details);
    },
    error: (message, details) => {
      write("error", message, details);
    }
  };
};

export default {
  createLogger,
  sanitizeStructuredData
};
