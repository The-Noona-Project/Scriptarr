/**
 * @file Scriptarr Warden module: services/warden/core/logTailRuntime.mjs.
 */
import {DEFAULT_WARDEN_CONTAINER_NAME} from "../config/constants.mjs";
import {resolveServicePlan} from "../config/servicePlan.mjs";
import {readDockerContainerLogs} from "../docker/dockerCli.mjs";

const DEFAULT_LINE_COUNT = 250;
const MAX_LINE_COUNT = 1000;
const LOG_LEVELS = new Set(["all", "debug", "info", "warn", "error"]);

const normalizeString = (value, fallback = "") => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};

const clampLineCount = (value) => {
  const parsed = Number.parseInt(String(value || DEFAULT_LINE_COUNT), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LINE_COUNT;
  }
  return Math.min(MAX_LINE_COUNT, Math.max(1, parsed));
};

const stripAnsi = (value) => normalizeString(value).replace(/\u001b\[[0-9;]*m/g, "");

const redactLogLine = (value) => {
  let line = stripAnsi(value);
  line = line.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"'}]+/gi, "$1[redacted]");
  line = line.replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^,\r\n]+/gi, (_match, key) => `${key}: [redacted]`);
  line = line.replace(/(bearer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}/gi, "$1[redacted]");
  line = line.replace(/((?:token|password|secret|api[-_]?key|authorization|cookie)[A-Za-z0-9_. -]*\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^,\s}]+)/gi, "$1[redacted]");
  line = line.replace(/\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
  line = line.replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[redacted]");
  return line;
};

const inferLevel = (message) => {
  const normalized = normalizeString(message).toLowerCase();
  if (/\b(error|exception|failed|fatal)\b/.test(normalized)) {
    return "error";
  }
  if (/\b(warn|warning|degraded)\b/.test(normalized)) {
    return "warn";
  }
  if (/\b(debug|trace)\b/.test(normalized)) {
    return "debug";
  }
  return "info";
};

const parseLogLine = (line, index) => {
  const redacted = redactLogLine(line);
  const timestampMatch = redacted.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/);
  const message = timestampMatch ? timestampMatch[2] : redacted;
  return {
    id: `${timestampMatch?.[1] || "line"}-${index}`,
    timestamp: timestampMatch?.[1] || "",
    level: inferLevel(message),
    message
  };
};

const buildServiceOptions = ({env, resolvePlan}) => {
  const plan = resolvePlan({env});
  const options = [
    {
      name: "scriptarr-warden",
      label: "Warden",
      containerName: normalizeString(env.SCRIPTARR_WARDEN_CONTAINER_NAME, DEFAULT_WARDEN_CONTAINER_NAME)
    },
    ...plan.services.map((service) => ({
      name: service.name,
      label: service.name.replace(/^scriptarr-/, ""),
      containerName: service.containerName
    }))
  ];
  const seen = new Set();
  return options
    .filter((option) => {
      const key = normalizeString(option.name).toLowerCase();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

const resolveSelectedService = (services, requestedService) => {
  const requested = normalizeString(requestedService).toLowerCase();
  return services.find((service) =>
    service.name.toLowerCase() === requested
    || service.containerName.toLowerCase() === requested
  ) || services.find((service) => service.name === "scriptarr-warden") || services[0];
};

/**
 * Create Warden's safe Docker log-tail runtime.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   resolvePlan?: typeof resolveServicePlan,
 *   dockerOps?: {
 *     readDockerContainerLogs: typeof readDockerContainerLogs
 *   }
 * }} [options]
 * @returns {{tailLogs: (filters?: Record<string, unknown>) => Promise<Record<string, unknown>>}}
 */
export const createLogTailRuntime = ({
  env = process.env,
  resolvePlan = resolveServicePlan,
  dockerOps = {readDockerContainerLogs}
} = {}) => {
  const tailLogs = async (filters = {}) => {
    const services = buildServiceOptions({env, resolvePlan});
    const selected = resolveSelectedService(services, filters.service);
    const requestedLevel = normalizeString(filters.level, "all").toLowerCase();
    const level = LOG_LEVELS.has(requestedLevel) ? requestedLevel : "all";
    const lines = clampLineCount(filters.lines);
    const query = normalizeString(filters.q).toLowerCase();

    if (!selected) {
      return {
        services,
        selectedService: null,
        entries: [],
        generatedAt: new Date().toISOString(),
        redacted: true,
        lines
      };
    }

    const rawLogs = await dockerOps.readDockerContainerLogs(selected.containerName, {lines});
    const entries = rawLogs
      .split(/\r?\n/)
      .map((line, index) => parseLogLine(line, index))
      .filter((entry) => entry.message)
      .filter((entry) => level === "all" || entry.level === level)
      .filter((entry) => !query || entry.message.toLowerCase().includes(query));

    return {
      services,
      selectedService: selected.name,
      selectedContainer: selected.containerName,
      entries,
      generatedAt: new Date().toISOString(),
      redacted: true,
      lines,
      level,
      query
    };
  };

  return {tailLogs};
};

export default createLogTailRuntime;
