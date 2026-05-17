/**
 * @file Endpoint registry and GET probe helpers for Moon admin system status.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const PROTECTED_STATUS_CODES = new Set([401, 403]);

const endpoint = (service, method, path, {
  auth = "service",
  description = "",
  probePath = path,
  probeBase = service,
  probeAuthService = ""
} = {}) => ({
  id: `${service}:${String(method).toUpperCase()}:${path}`,
  service,
  method: String(method).toUpperCase(),
  path,
  auth,
  safety: String(method).toUpperCase() === "GET" ? "read" : "mutation",
  safeToProbe: String(method).toUpperCase() === "GET",
  description,
  probePath,
  probeBase,
  probeAuthService
});

/**
 * Build the known endpoint registry for status inspection.
 *
 * @returns {Array<{id: string, label: string, endpoints: Array<Record<string, unknown>>}>}
 */
export const buildEndpointRegistry = () => [
  {
    id: "moon",
    label: "Moon",
    endpoints: [
      endpoint("moon", "GET", "/health", {auth: "public", description: "Moon Express health is checked by browser context and external uptime monitors."}),
      endpoint("moon", "GET", "/api/moon/auth/status", {auth: "browser-session", description: "Current browser session."}),
      endpoint("moon", "GET", "/api/moon/chrome/bootstrap", {auth: "browser-session", description: "Collapsed Moon chrome bootstrap payload."}),
      endpoint("moon", "GET", "/api/moon-v3/user/home", {auth: "user-session", description: "User home shelves."}),
      endpoint("moon", "GET", "/api/moon-v3/admin/settings/runtime", {auth: "admin settings.read", description: "Settings runtime side payload."}),
      endpoint("moon", "GET", "/api/moon-v3/admin/system/status", {auth: "admin system.read", description: "This status payload."}),
      endpoint("moon", "GET", "/api/moon-v3/admin/system/status/runtime", {auth: "admin system.read", description: "Warden runtime side payload."})
    ]
  },
  {
    id: "sage",
    label: "Sage",
    endpoints: [
      endpoint("sage", "GET", "/health", {auth: "public", description: "Sage self-health."}),
      endpoint("sage", "GET", "/api/moon-v3/admin/system/tasks", {auth: "admin system.read", description: "Scheduler definitions."}),
      endpoint("sage", "PATCH", "/api/moon-v3/admin/system/tasks/:taskId", {auth: "admin system.root", description: "Update an allowlisted task schedule."}),
      endpoint("sage", "POST", "/api/moon-v3/admin/system/tasks/:taskId/run", {auth: "admin system.root", description: "Run an allowlisted task."})
    ]
  },
  {
    id: "vault",
    label: "Vault",
    endpoints: [
      endpoint("vault", "GET", "/health", {auth: "service", description: "Vault service health."}),
      endpoint("vault", "GET", "/api/service/events", {auth: "service", description: "Durable event log."}),
      endpoint("vault", "GET", "/api/service/jobs", {auth: "service", description: "Broker job snapshots."}),
      endpoint("vault", "PUT", "/api/service/settings/:key", {auth: "service", description: "Persist broker settings."})
    ]
  },
  {
    id: "raven",
    label: "Raven",
    endpoints: [
      endpoint("raven", "GET", "/health", {auth: "public", description: "Downloader health."}),
      endpoint("raven", "GET", "/v1/library", {auth: "service", description: "Imported title catalog."}),
      endpoint("raven", "GET", "/v1/downloads/tasks", {auth: "service", description: "Live download queue."}),
      endpoint("raven", "POST", "/v1/downloads/queue", {auth: "service", description: "Queue a concrete download target."})
    ]
  },
  {
    id: "warden",
    label: "Warden",
    endpoints: [
      endpoint("warden", "GET", "/health", {auth: "public", description: "Docker steward health."}),
      endpoint("warden", "GET", "/api/bootstrap", {auth: "service", description: "Bootstrap/runtime plan."}),
      endpoint("warden", "GET", "/api/runtime", {auth: "service", description: "Runtime and container snapshot."}),
      endpoint("warden", "GET", "/api/updates", {auth: "service", description: "Image update state."}),
      endpoint("warden", "POST", "/api/updates/check", {auth: "service", description: "Check image updates."}),
      endpoint("warden", "POST", "/api/localai/actions/install", {auth: "service", description: "Start the async LocalAI image install job."}),
      endpoint("warden", "POST", "/api/localai/actions/start", {auth: "service", description: "Start LocalAI and wait for model readiness."}),
      endpoint("warden", "POST", "/api/localai/actions/remove", {auth: "service", description: "Remove the LocalAI container and selected image."})
    ]
  },
  {
    id: "portal",
    label: "Portal",
    endpoints: [
      endpoint("portal", "GET", "/health", {auth: "public", description: "Discord runtime health."}),
      endpoint("portal", "GET", "/api/commands", {auth: "service", description: "Discord command inventory."}),
      endpoint("portal", "GET", "/api/internal/portal/notifications/system", {
        auth: "service via Sage",
        description: "System DM notification queue, consumed by Portal through Sage.",
        probeBase: "sage",
        probeAuthService: "scriptarr-portal"
      })
    ]
  },
  {
    id: "oracle",
    label: "Oracle",
    endpoints: [
      endpoint("oracle", "GET", "/health", {auth: "public", description: "AI service health."}),
      endpoint("oracle", "GET", "/api/status", {auth: "service", description: "Oracle provider status."}),
      endpoint("oracle", "POST", "/api/chat", {auth: "service", description: "Admin test prompt and summaries."})
    ]
  },
  {
    id: "localai",
    label: "LocalAI",
    endpoints: [
      endpoint("localai", "GET", "/api/localai/status", {auth: "via Oracle", description: "Embedded LocalAI runtime and model state.", probePath: "/api/localai/status"}),
      endpoint("localai", "GET", "/api/localai/profile", {auth: "via Oracle", description: "Embedded LocalAI profile and model options.", probePath: "/api/localai/profile"}),
      endpoint("localai", "POST", "/api/localai/probe", {auth: "via Oracle", description: "Force a LocalAI generation readiness probe."})
    ]
  }
];

const baseUrlFor = (config, groupId) => {
  switch (groupId) {
    case "moon":
      return config.publicBaseUrl || "";
    case "sage":
      return `http://127.0.0.1:${config.port || 4400}`;
    case "vault":
      return config.vaultBaseUrl || "";
    case "raven":
      return config.ravenBaseUrl || "";
    case "warden":
      return config.wardenBaseUrl || "";
    case "localai":
      return config.oracleBaseUrl || "";
    case "portal":
      return config.portalBaseUrl || "";
    case "oracle":
      return config.oracleBaseUrl || "";
    default:
      return "";
  }
};

const serviceAuthHeaders = (config, serviceName) => {
  const normalized = normalizeString(serviceName);
  if (!normalized) {
    return {};
  }
  const token = config.serviceTokens?.[normalized]
    || (normalized === "scriptarr-sage" ? config.serviceToken : "");
  return token ? {"Authorization": `Bearer ${token}`} : {};
};

const probeAuthServiceFor = (groupId, entry) => {
  if (entry.probeAuthService) {
    return entry.probeAuthService;
  }
  if (groupId === "vault" && entry.auth === "service") {
    return "scriptarr-sage";
  }
  return "";
};

const serviceBackedProbeBases = new Set(["raven", "warden", "portal", "oracle", "localai", "vault"]);

const classifyProbeStatus = (result) => {
  if (result.ok) {
    return "online";
  }
  if (PROTECTED_STATUS_CODES.has(Number(result.status))) {
    return "protected";
  }
  return "degraded";
};

const probeErrorFor = (probeStatus, result) => {
  if (probeStatus === "online") {
    return "";
  }
  if (probeStatus === "protected") {
    return `Protected route (HTTP ${result.status || "auth"})`;
  }
  return normalizeString(result.payload?.error, `HTTP ${result.status || "error"}`);
};

const probeEndpoint = async ({config, groupId, endpoint: entry, serviceJson, timeoutMs = 1800}) => {
  if (!entry.safeToProbe) {
    return {
      probeStatus: "not_probed",
      statusCode: null,
      latencyMs: null,
      lastCheckedAt: null,
      error: "",
      payloadSummary: "Mutation route."
    };
  }

  const started = Date.now();
  try {
    const path = normalizeString(entry.probePath, entry.path);
    const probeBase = normalizeString(entry.probeBase, groupId);
    const headers = serviceAuthHeaders(config, probeAuthServiceFor(groupId, entry));
    let result;
    if (serviceBackedProbeBases.has(probeBase) || entry.probeAuthService) {
      result = await serviceJson(baseUrlFor(config, probeBase), path, {
        method: entry.method,
        timeoutMs,
        headers
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrlFor(config, probeBase)}${path}`, {
          method: entry.method,
          headers,
          signal: controller.signal
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        result = {ok: response.ok, status: response.status, payload};
      } finally {
        clearTimeout(timer);
      }
    }
    const latencyMs = Date.now() - started;
    const probeStatus = classifyProbeStatus(result);
    return {
      probeStatus,
      statusCode: result.status || null,
      latencyMs,
      lastCheckedAt: new Date().toISOString(),
      error: probeErrorFor(probeStatus, result),
      payloadSummary: summarizePayload(result.payload)
    };
  } catch (error) {
    return {
      probeStatus: "degraded",
      statusCode: null,
      latencyMs: Date.now() - started,
      lastCheckedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      payloadSummary: ""
    };
  }
};

const summarizePayload = (payload) => {
  const summarizeValue = (value) => {
    if (value == null) {
      return "";
    }
    if (["string", "number", "boolean"].includes(typeof value)) {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `${value.length} item${value.length === 1 ? "" : "s"}`;
    }
    if (typeof value === "object") {
      return Object.keys(value).slice(0, 4).join(", ");
    }
    return "";
  };

  if (Array.isArray(payload)) {
    return summarizeValue(payload);
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (payload.status) {
    return summarizeValue(payload.status);
  }
  if (payload.ok != null) {
    return payload.ok ? "ok" : "not ok";
  }
  if (Array.isArray(payload.notifications)) {
    return `${payload.notifications.length} notifications`;
  }
  if (Array.isArray(payload.commands)) {
    return `${payload.commands.length} commands`;
  }
  if (Array.isArray(payload.titles)) {
    return `${payload.titles.length} titles`;
  }
  if (Array.isArray(payload.tasks)) {
    return `${payload.tasks.length} tasks`;
  }
  if (Array.isArray(payload.services)) {
    return `${payload.services.length} services`;
  }
  return Object.keys(payload).slice(0, 4).join(", ");
};

/**
 * Build a grouped endpoint matrix with GET probe results.
 *
 * @param {{config: Record<string, unknown>, serviceJson: Function, includeChecks?: boolean}} options
 * @returns {Promise<Record<string, unknown>>}
 */
export const buildSystemStatusPayload = async ({config, serviceJson, includeChecks = true}) => {
  const registry = buildEndpointRegistry();
  const groups = await Promise.all(registry.map(async (group) => {
    const endpoints = includeChecks
      ? await Promise.all(group.endpoints.map(async (entry) => ({
        ...entry,
        ...(await probeEndpoint({config, groupId: group.id, endpoint: entry, serviceJson}))
      })))
      : group.endpoints.map((entry) => ({
        ...entry,
        probeStatus: entry.safeToProbe ? "pending" : "not_probed",
        statusCode: null,
        latencyMs: null,
        lastCheckedAt: null,
        error: "",
        payloadSummary: ""
      }));
    return {
      ...group,
      endpoints
    };
  }));

  const endpoints = groups.flatMap((group) => normalizeArray(group.endpoints));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: endpoints.length,
      probed: endpoints.filter((entry) => entry.safeToProbe).length,
      checked: endpoints.filter((entry) => entry.safeToProbe && entry.probeStatus !== "pending").length,
      online: endpoints.filter((entry) => entry.probeStatus === "online").length,
      protected: endpoints.filter((entry) => entry.probeStatus === "protected").length,
      degraded: endpoints.filter((entry) => entry.probeStatus === "degraded").length,
      notProbed: endpoints.filter((entry) => entry.probeStatus === "not_probed").length
    },
    groups
  };
};

export default {
  buildEndpointRegistry,
  buildSystemStatusPayload
};
