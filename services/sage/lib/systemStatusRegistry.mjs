/**
 * @file Endpoint registry and safe probe helpers for Moon admin system status.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const endpoint = (service, method, path, {
  auth = "service",
  safeToProbe = method === "GET",
  description = "",
  probePath = path
} = {}) => ({
  id: `${service}:${method}:${path}`,
  service,
  method,
  path,
  auth,
  safety: safeToProbe ? "safe-read" : "mutation",
  safeToProbe,
  description,
  probePath
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
      endpoint("moon", "GET", "/health", {auth: "public", safeToProbe: false, description: "Moon Express health is checked by browser context and external uptime monitors."}),
      endpoint("moon", "GET", "/api/moon/auth/status", {auth: "browser-session", safeToProbe: false, description: "Current browser session."}),
      endpoint("moon", "GET", "/api/moon-v3/user/home", {auth: "user-session", safeToProbe: false, description: "User home shelves."}),
      endpoint("moon", "GET", "/api/moon-v3/admin/system/status", {auth: "admin system.read", safeToProbe: false, description: "This status payload."})
    ]
  },
  {
    id: "sage",
    label: "Sage",
    endpoints: [
      endpoint("sage", "GET", "/health", {auth: "public", safeToProbe: false, description: "Sage self-health is listed but not self-probed from the admin status request."}),
      endpoint("sage", "GET", "/api/moon-v3/admin/system/tasks", {auth: "admin system.read", safeToProbe: false, description: "Scheduler definitions."}),
      endpoint("sage", "PATCH", "/api/moon-v3/admin/system/tasks/:taskId", {auth: "admin system.root", safeToProbe: false, description: "Update an allowlisted task schedule."}),
      endpoint("sage", "POST", "/api/moon-v3/admin/system/tasks/:taskId/run", {auth: "admin system.root", safeToProbe: false, description: "Run an allowlisted task."})
    ]
  },
  {
    id: "vault",
    label: "Vault",
    endpoints: [
      endpoint("vault", "GET", "/health", {auth: "service", safeToProbe: true, description: "Vault service health."}),
      endpoint("vault", "GET", "/api/service/events", {auth: "service", safeToProbe: false, description: "Durable event log."}),
      endpoint("vault", "GET", "/api/service/jobs", {auth: "service", safeToProbe: false, description: "Broker job snapshots."}),
      endpoint("vault", "PUT", "/api/service/settings/:key", {auth: "service", safeToProbe: false, description: "Persist broker settings."})
    ]
  },
  {
    id: "raven",
    label: "Raven",
    endpoints: [
      endpoint("raven", "GET", "/health", {auth: "public", safeToProbe: true, description: "Downloader health."}),
      endpoint("raven", "GET", "/v1/library", {auth: "service", safeToProbe: true, description: "Imported title catalog."}),
      endpoint("raven", "GET", "/v1/downloads/tasks", {auth: "service", safeToProbe: true, description: "Live download queue."}),
      endpoint("raven", "POST", "/v1/downloads/queue", {auth: "service", safeToProbe: false, description: "Queue a concrete download target."})
    ]
  },
  {
    id: "warden",
    label: "Warden",
    endpoints: [
      endpoint("warden", "GET", "/health", {auth: "public", safeToProbe: true, description: "Docker steward health."}),
      endpoint("warden", "GET", "/api/bootstrap", {auth: "service", safeToProbe: true, description: "Bootstrap/runtime plan."}),
      endpoint("warden", "GET", "/api/runtime", {auth: "service", safeToProbe: true, description: "Runtime and container snapshot."}),
      endpoint("warden", "GET", "/api/updates", {auth: "service", safeToProbe: true, description: "Image update state."}),
      endpoint("warden", "POST", "/api/updates/check", {auth: "service", safeToProbe: false, description: "Check image updates."}),
      endpoint("warden", "POST", "/api/localai/actions/install", {auth: "service", safeToProbe: false, description: "Start the async LocalAI image install job."}),
      endpoint("warden", "POST", "/api/localai/actions/start", {auth: "service", safeToProbe: false, description: "Start LocalAI and wait for model readiness."}),
      endpoint("warden", "POST", "/api/localai/actions/remove", {auth: "service", safeToProbe: false, description: "Remove the LocalAI container and selected image."})
    ]
  },
  {
    id: "portal",
    label: "Portal",
    endpoints: [
      endpoint("portal", "GET", "/health", {auth: "public", safeToProbe: true, description: "Discord runtime health."}),
      endpoint("portal", "GET", "/api/commands", {auth: "service", safeToProbe: true, description: "Discord command inventory."}),
      endpoint("portal", "GET", "/api/internal/portal/notifications/system", {auth: "service", safeToProbe: false, description: "System DM notification queue, consumed by Portal through Sage."})
    ]
  },
  {
    id: "oracle",
    label: "Oracle",
    endpoints: [
      endpoint("oracle", "GET", "/health", {auth: "public", safeToProbe: true, description: "AI service health."}),
      endpoint("oracle", "GET", "/api/status", {auth: "service", safeToProbe: true, description: "Oracle provider status."}),
      endpoint("oracle", "POST", "/api/chat", {auth: "service", safeToProbe: false, description: "Admin test prompt and summaries."})
    ]
  },
  {
    id: "localai",
    label: "LocalAI",
    endpoints: [
      endpoint("localai", "GET", "/api/localai/status", {auth: "via Warden", safeToProbe: true, description: "LocalAI container/runtime state.", probePath: "/api/localai/status"}),
      endpoint("localai", "GET", "/api/localai/profile", {auth: "via Warden", safeToProbe: true, description: "Available LocalAI image profiles.", probePath: "/api/localai/profile"}),
      endpoint("localai", "PUT", "/api/localai/config", {auth: "via Warden", safeToProbe: false, description: "Persist LocalAI image profile."})
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
    case "localai":
      return config.wardenBaseUrl || "";
    case "portal":
      return config.portalBaseUrl || "";
    case "oracle":
      return config.oracleBaseUrl || "";
    default:
      return "";
  }
};

const probeEndpoint = async ({config, groupId, endpoint: entry, serviceJson, timeoutMs = 1800}) => {
  if (!entry.safeToProbe) {
    return {
      probeStatus: "not_probed",
      statusCode: null,
      latencyMs: null,
      lastCheckedAt: null,
      error: "",
      payloadSummary: "Mutation or user-context route."
    };
  }

  const started = Date.now();
  try {
    const path = normalizeString(entry.probePath, entry.path);
    let result;
    if (["raven", "warden", "portal", "oracle", "localai"].includes(groupId)) {
      result = await serviceJson(baseUrlFor(config, groupId), path, {
        method: entry.method,
        timeoutMs
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${baseUrlFor(config, groupId)}${path}`, {
        method: entry.method,
        signal: controller.signal
      });
      clearTimeout(timer);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      result = {ok: response.ok, status: response.status, payload};
    }
    const latencyMs = Date.now() - started;
    return {
      probeStatus: result.ok ? "online" : "degraded",
      statusCode: result.status || null,
      latencyMs,
      lastCheckedAt: new Date().toISOString(),
      error: result.ok ? "" : normalizeString(result.payload?.error, `HTTP ${result.status || "error"}`),
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
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (payload.status) {
    return String(payload.status);
  }
  if (payload.ok != null) {
    return payload.ok ? "ok" : "not ok";
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
 * Build a grouped endpoint matrix with safe probe results.
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
      online: endpoints.filter((entry) => entry.probeStatus === "online").length,
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
