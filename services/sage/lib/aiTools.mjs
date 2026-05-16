/**
 * @file Sage-owned AI tool registry, settings, and proposal lifecycle.
 */

export const AI_TOOL_SETTINGS_KEY = "oracle.tools";
export const AI_PROPOSALS_KEY = "oracle.proposals";

const MAX_PROPOSALS = 100;
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const nowIso = () => new Date().toISOString();

export const AI_TOOL_REGISTRY = Object.freeze([
  {id: "stack_status", label: "Stack Status", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read service health and high-level Scriptarr state."},
  {id: "service_health", label: "Service Health", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read Warden, Portal, Oracle, Raven, Vault, and Sage health."},
  {id: "events", label: "Events", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read recent durable admin/service events."},
  {id: "queue", label: "Queue", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read current Raven queue state."},
  {id: "requests", label: "Requests", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read request moderation summaries."},
  {id: "library_search", label: "Library Search", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Search the readable library catalog."},
  {id: "missing_content", label: "Missing Content", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read missing content and quality summaries."},
  {id: "discord_runtime", label: "Discord Runtime", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read Portal Discord runtime state."},
  {id: "trivia_status", label: "Trivia Status", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read current trivia round and leaderboard state."},
  {id: "localai_status", label: "LocalAI Status", kind: "read", risk: "safe", grant: {domain: "ai", level: "read"}, defaultEnabled: true, description: "Read LocalAI runtime and job state."},
  {id: "status_check", label: "Check Status Endpoints", kind: "operation", risk: "low", grant: {domain: "system", level: "read"}, defaultEnabled: false, description: "Run the System Status GET/read endpoint checks."},
  {id: "request_refresh_sources", label: "Refresh Request Sources", kind: "operation", risk: "medium", grant: {domain: "requests", level: "write"}, defaultEnabled: false, description: "Refresh download sources for a request."},
  {id: "queue_retry_failed", label: "Retry Queue Attention", kind: "operation", risk: "medium", grant: {domain: "activity", level: "write"}, defaultEnabled: false, description: "Retry failed queue items that are eligible for recovery."},
  {id: "system_task_run", label: "Run System Task", kind: "operation", risk: "medium", grant: {domain: "system", level: "root"}, defaultEnabled: false, description: "Run an allowlisted Sage system task."},
  {id: "localai_install", label: "Install LocalAI", kind: "operation", risk: "high", grant: {domain: "ai", level: "root"}, defaultEnabled: false, description: "Start Warden's LocalAI install job."},
  {id: "localai_start", label: "Start LocalAI", kind: "operation", risk: "medium", grant: {domain: "ai", level: "root"}, defaultEnabled: false, description: "Start LocalAI and wait for readiness."},
  {id: "localai_remove", label: "Remove LocalAI", kind: "operation", risk: "high", grant: {domain: "ai", level: "root"}, defaultEnabled: false, description: "Remove the LocalAI container/image."},
  {id: "trivia_start", label: "Start Trivia Round", kind: "operation", risk: "low", grant: {domain: "discord", level: "write"}, defaultEnabled: false, description: "Start a manual Discord trivia round."},
  {id: "trivia_stop", label: "Stop Trivia Round", kind: "operation", risk: "low", grant: {domain: "discord", level: "write"}, defaultEnabled: false, description: "Stop the active Discord trivia round."}
]);

const toolById = new Map(AI_TOOL_REGISTRY.map((tool) => [tool.id, tool]));

const normalizeToolSettings = (value = {}) => {
  const source = normalizeObject(value, {}) || {};
  const toggles = normalizeObject(source.toggles || source.tools, {}) || {};
  const lastUsed = normalizeObject(source.lastUsed, {}) || {};
  return {
    key: AI_TOOL_SETTINGS_KEY,
    toggles: Object.fromEntries(AI_TOOL_REGISTRY.map((tool) => [
      tool.id,
      typeof toggles[tool.id] === "boolean" ? toggles[tool.id] : tool.defaultEnabled
    ])),
    lastUsed: Object.fromEntries(Object.entries(lastUsed)
      .map(([toolId, at]) => [normalizeString(toolId), normalizeString(at)])
      .filter(([toolId, at]) => toolById.has(toolId) && at))
  };
};

const normalizeProposal = (proposal = {}) => ({
  id: normalizeString(proposal.id),
  toolId: normalizeString(proposal.toolId),
  prompt: normalizeString(proposal.prompt).slice(0, 2000),
  args: normalizeObject(proposal.args, {}) || {},
  status: ["pending", "confirmed", "cancelled", "expired", "failed"].includes(normalizeString(proposal.status))
    ? normalizeString(proposal.status)
    : "pending",
  result: normalizeObject(proposal.result, {}) || {},
  error: normalizeString(proposal.error),
  createdBy: normalizeObject(proposal.createdBy, {}) || {},
  createdAt: normalizeString(proposal.createdAt, nowIso()),
  updatedAt: normalizeString(proposal.updatedAt, nowIso()),
  expiresAt: normalizeString(proposal.expiresAt)
});

const normalizeProposalStore = (value = {}) => ({
  key: AI_PROPOSALS_KEY,
  proposals: normalizeArray(normalizeObject(value, {})?.proposals || value)
    .map(normalizeProposal)
    .filter((proposal) => proposal.id && toolById.has(proposal.toolId))
    .slice(-MAX_PROPOSALS)
});

/**
 * Read normalized AI tool settings from Vault.
 *
 * @param {{getSetting: Function}} vaultClient
 * @returns {Promise<Record<string, unknown>>}
 */
export const readAiToolSettings = async (vaultClient) =>
  normalizeToolSettings((await vaultClient.getSetting(AI_TOOL_SETTINGS_KEY))?.value || {});

/**
 * Persist normalized AI tool settings.
 *
 * @param {{setSetting: Function}} vaultClient
 * @param {Record<string, unknown>} value
 * @returns {Promise<unknown>}
 */
export const writeAiToolSettings = async (vaultClient, value) =>
  vaultClient.setSetting(AI_TOOL_SETTINGS_KEY, normalizeToolSettings(value));

/**
 * Read normalized AI action proposals.
 *
 * @param {{getSetting: Function}} vaultClient
 * @returns {Promise<Record<string, unknown>>}
 */
export const readAiProposals = async (vaultClient) =>
  normalizeProposalStore((await vaultClient.getSetting(AI_PROPOSALS_KEY))?.value || {});

/**
 * Persist normalized AI action proposals.
 *
 * @param {{setSetting: Function}} vaultClient
 * @param {Record<string, unknown>} value
 * @returns {Promise<unknown>}
 */
export const writeAiProposals = async (vaultClient, value) =>
  vaultClient.setSetting(AI_PROPOSALS_KEY, normalizeProposalStore(value));

/**
 * Build the admin-facing AI tool registry payload.
 *
 * @param {{getSetting: Function}} vaultClient
 * @returns {Promise<{settings: Record<string, unknown>, tools: Array<Record<string, unknown>>}>}
 */
export const buildToolPayload = async (vaultClient) => {
  const settings = await readAiToolSettings(vaultClient);
  return {
    settings,
    tools: AI_TOOL_REGISTRY.map((tool) => ({
      ...tool,
      enabled: settings.toggles[tool.id] !== false,
      lastUsedAt: settings.lastUsed[tool.id] || null
    }))
  };
};

/**
 * Mark an AI tool as used for admin visibility.
 *
 * @param {{getSetting: Function, setSetting: Function}} vaultClient
 * @param {string} toolId
 * @returns {Promise<void>}
 */
export const markToolUsed = async (vaultClient, toolId) => {
  const settings = await readAiToolSettings(vaultClient);
  await writeAiToolSettings(vaultClient, {
    ...settings,
    lastUsed: {
      ...settings.lastUsed,
      [toolId]: nowIso()
    }
  });
};

const detectToolFromPrompt = (prompt) => {
  const text = normalizeString(prompt).toLowerCase();
  if (/trivia/.test(text) && /\b(stop|cancel|end)\b/.test(text)) {
    return "trivia_stop";
  }
  if (/trivia/.test(text) && /\b(start|begin|run)\b/.test(text)) {
    return "trivia_start";
  }
  if (/localai/.test(text) && /\b(remove|delete|uninstall)\b/.test(text)) {
    return "localai_remove";
  }
  if (/localai/.test(text) && /\b(install|download)\b/.test(text)) {
    return "localai_install";
  }
  if (/localai/.test(text) && /\b(start|run|boot)\b/.test(text)) {
    return "localai_start";
  }
  if (/\b(status|endpoint|health|probe|check)\b/.test(text)) {
    return "status_check";
  }
  if (/\b(task|cron|maintenance)\b/.test(text)) {
    return "system_task_run";
  }
  if (/\b(queue|retry|failed)\b/.test(text)) {
    return "queue_retry_failed";
  }
  if (/\b(request|source|refresh)\b/.test(text)) {
    return "request_refresh_sources";
  }
  return "stack_status";
};

/**
 * Resolve a prompt into a read tool result or a pending operation proposal.
 *
 * @param {{vaultClient: {getSetting: Function, setSetting: Function}, prompt: string, user?: Record<string, unknown>, requestedToolId?: string, args?: Record<string, unknown>, allowedToolIds?: string[]}} options
 * @returns {Promise<Record<string, unknown>>}
 */
export const proposeAiAction = async ({vaultClient, prompt, user, requestedToolId = "", args = {}, allowedToolIds = []}) => {
  const tools = await buildToolPayload(vaultClient);
  const toolId = normalizeString(requestedToolId) || detectToolFromPrompt(prompt);
  const allowed = normalizeArray(allowedToolIds).map((entry) => normalizeString(entry)).filter(Boolean);
  if (allowed.length && !allowed.includes(toolId)) {
    return {ok: false, status: 403, error: "That AI tool is not allowed from this surface."};
  }
  const tool = tools.tools.find((entry) => entry.id === toolId);
  if (!tool) {
    return {ok: false, status: 400, error: "AI could not map that prompt to an allowlisted tool."};
  }
  if (tool.enabled === false) {
    return {ok: false, status: 409, error: `${tool.label} is disabled in AI tool settings.`};
  }
  if (tool.kind === "read") {
    return {
      ok: true,
      mode: "read",
      tool,
      message: `${tool.label} is available as a read tool.`
    };
  }
  const createdAt = new Date();
  const proposal = normalizeProposal({
    id: `aip_${createdAt.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    toolId: tool.id,
    prompt,
    args,
    status: "pending",
    createdBy: {
      discordUserId: normalizeString(user?.discordUserId),
      username: normalizeString(user?.username, "Admin")
    },
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PROPOSAL_TTL_MS).toISOString()
  });
  const store = await readAiProposals(vaultClient);
  await writeAiProposals(vaultClient, {
    proposals: [...store.proposals, proposal]
  });
  return {
    ok: true,
    mode: "proposal",
    tool,
    proposal,
    message: `${tool.label} needs confirmation before Scriptarr runs it.`
  };
};

/**
 * Patch an AI proposal status and result metadata.
 *
 * @param {{getSetting: Function, setSetting: Function}} vaultClient
 * @param {string} proposalId
 * @param {string | Record<string, unknown>} statusOrPatch
 * @param {Record<string, unknown>} patchValue
 * @returns {Promise<Record<string, unknown> | null>}
 */
export const updateProposalStatus = async (vaultClient, proposalId, statusOrPatch = {}, patchValue = {}) => {
  const patch = typeof statusOrPatch === "string"
    ? {status: statusOrPatch, ...normalizeObject(patchValue, {})}
    : normalizeObject(statusOrPatch, {}) || {};
  const store = await readAiProposals(vaultClient);
  const proposal = store.proposals.find((entry) => entry.id === proposalId);
  if (!proposal) {
    return null;
  }
  const next = normalizeProposal({
    ...proposal,
    ...patch,
    id: proposal.id,
    toolId: proposal.toolId,
    updatedAt: nowIso()
  });
  await writeAiProposals(vaultClient, {
    proposals: store.proposals.map((entry) => entry.id === next.id ? next : entry)
  });
  return next;
};

/**
 * Read one AI proposal by id.
 *
 * @param {{getSetting: Function}} vaultClient
 * @param {string} proposalId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export const getProposal = async (vaultClient, proposalId) =>
  (await readAiProposals(vaultClient)).proposals.find((proposal) => proposal.id === proposalId) || null;

/**
 * Resolve a registered AI tool by id.
 *
 * @param {string} toolId
 * @returns {Record<string, unknown> | null}
 */
export const toolForId = (toolId) => toolById.get(normalizeString(toolId)) || null;

export default {
  AI_TOOL_REGISTRY,
  AI_TOOL_SETTINGS_KEY,
  AI_PROPOSALS_KEY,
  buildToolPayload,
  getProposal,
  markToolUsed,
  proposeAiAction,
  readAiProposals,
  readAiToolSettings,
  toolForId,
  updateProposalStatus,
  writeAiProposals,
  writeAiToolSettings
};
