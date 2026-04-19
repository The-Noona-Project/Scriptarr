const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

const SECRET_KEY_PATTERN = /(token|password|secret|api[-_]?key|authorization)/i;

const normalizeString = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();

const redactValue = (key, value) => {
  if (!SECRET_KEY_PATTERN.test(key)) {
    return normalizeString(value);
  }

  const normalized = normalizeString(value);
  return normalized ? "[redacted]" : "";
};

const resolveLevelName = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : "info";
};

/**
 * Create a small structured logger for Warden and its helper modules.
 *
 * @param {string} tag
 * @param {{env?: NodeJS.ProcessEnv, sink?: Console}} [options]
 * @returns {{
 *   debug: (message: string, details?: Record<string, unknown>) => void,
 *   info: (message: string, details?: Record<string, unknown>) => void,
 *   warn: (message: string, details?: Record<string, unknown>) => void,
 *   error: (message: string, details?: Record<string, unknown>) => void
 * }}
 */
export const createLogger = (tag, {env = process.env, sink = console} = {}) => {
  const minimumLevel = LEVELS[resolveLevelName(env.SCRIPTARR_WARDEN_LOG_LEVEL || "info")];

  const write = (levelName, message, details = {}) => {
    if (LEVELS[levelName] < minimumLevel) {
      return;
    }

    const fragments = Object.entries(details)
      .filter(([, value]) => value != null && normalizeString(value) !== "")
      .map(([key, value]) => `${key}=${redactValue(key, value)}`);
    const line = [
      new Date().toISOString(),
      levelName.toUpperCase(),
      `[${normalizeString(tag) || "WARDEN"}]`,
      normalizeString(message),
      ...fragments
    ].join(" ");

    if (levelName === "error") {
      sink.error(line);
      return;
    }

    if (levelName === "warn") {
      sink.warn(line);
      return;
    }

    sink.log(line);
  };

  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details)
  };
};
