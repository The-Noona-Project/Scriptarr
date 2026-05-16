"use client";

/**
 * @file Oracle and LocalAI controls for Moon admin.
 */

import {useCallback, useEffect, useRef, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const clampPercent = (value) => Math.min(100, Math.max(0, Number.parseInt(String(value), 10) || 0));

/**
 * Resolve Oracle's admin badge label without rendering nested health payloads.
 *
 * @param {any} pageData
 * @returns {"healthy" | "degraded" | "disabled" | "offline"}
 */
const resolveOracleStatusLabel = (pageData) => {
  const health = pageData?.oracleHealth || {};
  const status = pageData?.oracleStatus || {};
  const oracle = pageData?.oracle || status?.oracle || {};
  const probeStatus = (
    normalizeString(status?.status)
    || normalizeString(status?.probeStatus)
    || normalizeString(health?.probeStatus)
  ).toLowerCase();

  if (health?.ok === false || status?.ok === false || ["offline", "failed", "error"].includes(probeStatus)) {
    return "offline";
  }

  if (oracle?.enabled === false || status?.oracle?.enabled === false || health?.enabled === false) {
    return "disabled";
  }

  if (["degraded", "warning"].includes(probeStatus)) {
    return "degraded";
  }

  if (health?.ok === true || status?.ok === true) {
    return "healthy";
  }

  return "degraded";
};

/**
 * Map Oracle's compact status label to the shared badge tone.
 *
 * @param {string} label
 * @returns {string}
 */
const oracleTone = (label) => {
  if (label === "healthy") {
    return "good";
  }
  if (label === "disabled") {
    return "queued";
  }
  return "bad";
};

/**
 * Resolve the value stored for a LocalAI profile option.
 *
 * @param {any} profile
 * @returns {string}
 */
const localAiProfileValue = (profile) => formatDisplayValue(
  profile?.key || profile?.id || profile?.name || profile?.image || profile,
  "profile"
);

/**
 * Resolve a render-safe label for a LocalAI profile option.
 *
 * @param {any} profile
 * @returns {string}
 */
const localAiProfileLabel = (profile) => {
  const directLabel = formatDisplayValue(profile?.label || profile?.name, "");
  if (directLabel) {
    return directLabel;
  }

  const key = localAiProfileValue(profile);
  if (key && key !== "profile" && !key.includes("/")) {
    return key.toUpperCase();
  }

  return formatDisplayValue(profile?.image || profile?.configuredImage || profile, "Profile");
};

/**
 * Resolve LocalAI's current lifecycle label from Warden's runtime payload.
 *
 * @param {any} localAi
 * @returns {string}
 */
const resolveLocalAiStatusLabel = (localAi) => {
  const phase = normalizeString(localAi?.phase).toLowerCase();
  if (phase && phase !== "idle") {
    return phase;
  }
  if (localAi?.ready === true) {
    return "ready";
  }
  if (localAi?.running === true) {
    return "running";
  }
  if (localAi?.installed === true) {
    return "installed";
  }
  if (phase) {
    return phase;
  }
  return formatDisplayValue(localAi?.message, "unknown");
};

/**
 * Map LocalAI runtime state to the shared badge tone.
 *
 * @param {any} localAi
 * @returns {string}
 */
const localAiTone = (localAi) => {
  const phase = normalizeString(localAi?.phase).toLowerCase();
  if (localAi?.lastError || ["failed", "error"].includes(phase)) {
    return "bad";
  }
  if (["installing", "starting", "removing"].includes(phase)) {
    return "warning";
  }
  if (localAi?.ready || localAi?.running) {
    return "running";
  }
  if (localAi?.installed) {
    return "queued";
  }
  return "bad";
};

/**
 * Resolve the configured LocalAI image from current and compatibility fields.
 *
 * @param {any} localAi
 * @returns {string}
 */
const resolveLocalAiImage = (localAi) => formatDisplayValue(
  localAi?.configuredImage
    || localAi?.image
    || localAi?.selectedImage
    || localAi?.configuredProfile?.image
    || localAi?.detectedProfile?.image,
  "unknown"
);

/**
 * Resolve the selected LocalAI profile key from current and compatibility fields.
 *
 * @param {any} pageData
 * @param {any} draft
 * @returns {string}
 */
const resolveSelectedLocalAiProfile = (pageData, draft) => formatDisplayValue(
  pageData?.localAi?.profileKey
    || pageData?.localAi?.configuredProfileKey
    || pageData?.localAiProfile?.selectedProfile
    || pageData?.localAi?.configuredProfile?.key
    || draft?.localAiProfileKey,
  "unknown"
);

const resolveLocalAiJob = (localAi) => localAi?.job && typeof localAi.job === "object" ? localAi.job : null;

const resolveLocalAiJobTask = (job) => {
  const tasks = normalizeArray(job?.tasks);
  return tasks.find((task) => normalizeString(task?.status) === "running")
    || [...tasks].reverse().find((task) => normalizeString(task?.status))
    || null;
};

const resolveLocalAiProgress = (job) => {
  if (!job) {
    return 0;
  }
  const explicit = clampPercent(job.progressPercent);
  if (explicit) {
    return explicit;
  }
  const tasks = normalizeArray(job.tasks);
  if (!tasks.length) {
    return normalizeString(job.status) === "completed" ? 100 : 0;
  }
  return clampPercent(Math.round(tasks.reduce((sum, task) => sum + clampPercent(task?.percent), 0) / tasks.length));
};

const resolveJobDoneMessage = (job) => {
  const action = normalizeString(job?.payload?.action, "LocalAI");
  const status = normalizeString(job?.status).toLowerCase();
  if (status === "completed") {
    if (action === "start") {
      return "LocalAI is ready. A Discord DM was queued for the requester.";
    }
    if (action === "remove") {
      return "LocalAI was removed. A Discord DM was queued for the requester.";
    }
    return "LocalAI install completed. A Discord DM was queued for the requester.";
  }
  if (status === "failed") {
    return formatDisplayValue(job?.error || job?.result?.error, "LocalAI action failed. A Discord DM was queued for the requester.");
  }
  return "";
};

/**
 * Resolve the model id used as an option value.
 *
 * @param {any} model
 * @returns {string}
 */
const modelOptionValue = (model) => normalizeString(model?.id || model?.model || model?.name || model);

/**
 * Resolve the label shown in the provider model dropdown.
 *
 * @param {any} model
 * @returns {string}
 */
const modelOptionLabel = (model) => formatDisplayValue(model?.label || model?.name || model?.id || model, "Model");

/**
 * Normalize the provider model payload into unique dropdown choices.
 *
 * @param {any} payload
 * @returns {Array<{id: string, label: string}>}
 */
const resolveModelChoices = (payload) => {
  const seen = new Set();
  return normalizeArray(payload?.models)
    .map((model) => ({
      id: modelOptionValue(model),
      label: modelOptionLabel(model)
    }))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    });
};

const defaultModelForProvider = (provider) => normalizeString(provider).toLowerCase() === "localai"
  ? "gpt-4"
  : "gpt-4.1-mini";

const AI_ENDPOINT = "/api/moon/v3/admin/system/ai";
const AI_RUNTIME_ENDPOINT = "/api/moon/v3/admin/system/ai/runtime";
const AI_MODELS_ENDPOINT = "/api/moon/v3/admin/system/ai/models";

const fallbackModelOptions = (provider, currentModel, error) => {
  const selectedModel = normalizeString(currentModel, defaultModelForProvider(provider));
  return {
    provider,
    selectedModel,
    models: [{id: selectedModel, label: selectedModel}],
    source: normalizeString(currentModel) ? "current" : "default",
    ok: false,
    error
  };
};

/**
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const SystemAiPage = ({user}) => {
  const canSaveOracle = hasAdminGrant(user, "ai", "write");
  const canManageLocalAi = hasAdminGrant(user, "ai", "root");
  const canToggleTools = hasAdminGrant(user, "ai", "root");
  const [draft, setDraft] = useState(null);
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const [testPrompt, setTestPrompt] = useState("Give me a two sentence Scriptarr health summary.");
  const [testReply, setTestReply] = useState("");
  const [assistPrompt, setAssistPrompt] = useState("Check Scriptarr status and tell me what needs attention.");
  const [assistReply, setAssistReply] = useState("");
  const [assistToolId, setAssistToolId] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [modelOptions, setModelOptions] = useState(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const lastJobToastRef = useRef("");
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson(AI_ENDPOINT, {
    fallback: {
      oracle: {},
      localAi: {}
    }
  });
  const refreshRuntime = useCallback(async () => {
    setRuntimeLoading(true);
    const result = await requestJson(AI_RUNTIME_ENDPOINT);
    setRuntimeLoading(false);
    if (!result.ok) {
      setRuntimeError(formatDisplayValue(result.payload?.error, "Moon could not hydrate AI runtime state."));
      return;
    }
    const payload = result.payload || {};
    setRuntimeError("");
    setData((current) => ({
      ...(current || {}),
      oracleHealth: payload.oracleHealth ?? current?.oracleHealth ?? {},
      oracleStatus: payload.oracleStatus ?? current?.oracleStatus ?? {},
      localAi: payload.localAi ?? current?.localAi ?? {},
      localAiProfile: payload.localAiProfile ?? current?.localAiProfile ?? {}
    }));
  }, [setData]);
  const refreshAiPage = useCallback(async () => {
    await refresh();
    await refreshRuntime();
  }, [refresh, refreshRuntime]);
  const localAiJob = resolveLocalAiJob(data?.localAi);
  const localAiJobStatus = normalizeString(localAiJob?.status).toLowerCase();
  const localAiActionActive = ["installing", "starting", "removing"].includes(normalizeString(data?.localAi?.phase).toLowerCase())
    || localAiJobStatus === "running";
  const live = useAdminEventStaleness({
    domains: ["system", "ai"],
    enabled: true,
    locked: Boolean(actionBusy),
    onStale: () => {},
    onRefresh: refreshAiPage
  });

  useEffect(() => {
    if (!draft && data?.oracle) {
      setDraft({
        enabled: Boolean(data.oracle.enabled),
        provider: normalizeString(data.oracle.provider, "openai"),
        model: normalizeString(data.oracle.model),
        temperature: String(data.oracle.temperature ?? 0.2),
        localAiProfileKey: normalizeString(data.oracle.localAiProfileKey, "nvidia"),
        localAiImageMode: normalizeString(data.oracle.localAiImageMode, "preset"),
        localAiCustomImage: normalizeString(data.oracle.localAiCustomImage),
        openAiApiKey: ""
      });
    }
  }, [data?.oracle, draft]);

  useEffect(() => {
    const payloadProvider = normalizeString(data?.modelOptions?.provider).toLowerCase();
    const draftProvider = normalizeString(draft?.provider).toLowerCase();
    if (payloadProvider && (!draftProvider || payloadProvider === draftProvider)) {
      setModelOptions(data.modelOptions);
    }
  }, [data?.modelOptions, draft?.provider]);

  useEffect(() => {
    if (loading) {
      return;
    }
    void refreshRuntime();
  }, [loading, refreshRuntime]);

  useEffect(() => {
    const provider = normalizeString(draft?.provider).toLowerCase();
    if (!provider) {
      return undefined;
    }

    let cancelled = false;
    setModelLoading(true);
    void requestJson(`${AI_MODELS_ENDPOINT}?provider=${encodeURIComponent(provider)}`).then((result) => {
      if (cancelled) {
        return;
      }
      const payload = result.ok
        ? result.payload
        : fallbackModelOptions(provider, draft?.model, formatDisplayValue(result.payload?.error, "Moon could not load available models."));
      const choices = resolveModelChoices(payload);
      const preferredModel = normalizeString(payload?.selectedModel);
      const selectedModel = choices.some((choice) => choice.id === preferredModel)
        ? preferredModel
        : choices[0]?.id || defaultModelForProvider(provider);
      setModelOptions(payload);
      if (choices.length && !choices.some((choice) => choice.id === draft?.model)) {
        setDraft((current) => normalizeString(current?.provider).toLowerCase() === provider
          ? {...(current || {}), model: selectedModel}
          : current);
      }
      setModelLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [draft?.provider]);

  useEffect(() => {
    if (!localAiActionActive) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refreshRuntime();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [localAiActionActive, refreshRuntime]);

  useEffect(() => {
    if (!localAiJob?.jobId) {
      return;
    }
    const marker = `${localAiJob.jobId}:${localAiJobStatus}`;
    if (!lastJobToastRef.current) {
      lastJobToastRef.current = marker;
      return;
    }
    if (marker === lastJobToastRef.current) {
      return;
    }
    lastJobToastRef.current = marker;
    if (["completed", "failed"].includes(localAiJobStatus)) {
      const message = resolveJobDoneMessage(localAiJob);
      const tone = localAiJobStatus === "completed" ? "good" : "bad";
      setFlash(message);
      setFlashTone(tone);
      notify({message, tone, category: "job", eventId: marker});
    }
  }, [localAiJob, localAiJobStatus, notify]);

  const patchDraft = (patch) => setDraft((current) => ({
    ...(current || {}),
    ...patch
  }));

  const saveOracle = async () => {
    setFlash("");
    setActionBusy("oracle");
    const result = await requestJson("/api/moon/v3/admin/system/ai/oracle", {
      method: "PUT",
      json: {
        ...draft,
        temperature: Number(draft?.temperature ?? 0.2)
      }
    });
    setActionBusy("");
    if (!result.ok) {
      const message = formatDisplayValue(result.payload?.error, "Moon could not save Oracle settings.");
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setData((current) => ({
      ...current,
      oracle: result.payload
    }));
    setDraft((current) => ({...(current || {}), openAiApiKey: ""}));
    setFlash("Oracle settings saved.");
    setFlashTone("good");
    notify({message: "Oracle settings saved.", tone: "good", category: "action"});
    void refreshAiPage();
  };

  const runLocalAiAction = async (action) => {
    setFlash("");
    setActionBusy(action);
    const result = await requestJson(`/api/moon/v3/admin/system/ai/localai/${action}`, {
      method: "POST",
      json: {
        localAiProfileKey: draft?.localAiProfileKey,
        localAiImageMode: draft?.localAiImageMode,
        localAiCustomImage: draft?.localAiCustomImage
      }
    });
    setActionBusy("");
    if (!result.ok) {
      const message = formatDisplayValue(result.payload?.error, `Moon could not ${action} LocalAI.`);
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "job"});
      return;
    }
    const message = action === "install"
      ? "LocalAI install job started."
      : action === "remove"
        ? "LocalAI removal job started."
        : "LocalAI startup job requested.";
    setFlash(message);
    setFlashTone("good");
    notify({message, tone: "good", category: "job"});
    setData((current) => ({
      ...current,
      localAi: result.payload || current?.localAi
    }));
    void refreshRuntime();
  };

  const runTest = async () => {
    setTestReply("");
    const result = await requestJson("/api/moon/v3/admin/system/ai/test", {
      method: "POST",
      json: {
        message: testPrompt
      }
    });
    if (!result.ok) {
      const message = formatDisplayValue(result.payload?.error, "Oracle test failed.");
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setTestReply(normalizeString(result.payload?.reply, JSON.stringify(result.payload || {}, null, 2)));
  };

  const saveToolToggle = async (toolId, enabled) => {
    setActionBusy(`tool:${toolId}`);
    const currentToggles = data?.tools?.settings?.toggles || {};
    const result = await requestJson("/api/moon/v3/admin/system/ai/tools", {
      method: "PUT",
      json: {
        ...data?.tools?.settings,
        toggles: {
          ...currentToggles,
          [toolId]: enabled
        }
      }
    });
    setActionBusy("");
    if (!result.ok) {
      const message = formatDisplayValue(result.payload?.error, "Moon could not save AI tool settings.");
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setData((current) => ({...current, tools: result.payload}));
    setFlash("AI tool settings saved.");
    setFlashTone("good");
    notify({message: "AI tool settings saved.", tone: "good", category: "action"});
  };

  const runAssist = async () => {
    setAssistReply("");
    setActionBusy("assist");
    const result = await requestJson("/api/moon/v3/admin/system/ai/assist", {
      method: "POST",
      json: {
        prompt: assistPrompt,
        toolId: assistToolId || undefined
      }
    });
    setActionBusy("");
    if (!result.ok || result.payload?.ok === false) {
      const message = formatDisplayValue(result.payload?.error, "AI assist failed.");
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setAssistReply(result.payload?.message || JSON.stringify(result.payload || {}, null, 2));
    setData((current) => ({
      ...current,
      ...(result.payload?.tools ? {tools: result.payload.tools} : {}),
      ...(result.payload?.proposal ? {proposals: [result.payload.proposal, ...normalizeArray(current?.proposals)]} : {})
    }));
    notify({
      message: result.payload?.proposal ? "AI proposal drafted." : formatDisplayValue(result.payload?.message, "AI read tool completed."),
      tone: "good",
      category: "action"
    });
  };

  const updateProposal = async (proposalId, action) => {
    setActionBusy(`${action}:${proposalId}`);
    const result = await requestJson(`/api/moon/v3/admin/system/ai/proposals/${encodeURIComponent(proposalId)}/${action}`, {
      method: "POST",
      json: {}
    });
    setActionBusy("");
    const proposal = result.payload?.proposal || result.payload;
    if (!result.ok) {
      if (proposal?.id) {
        setData((current) => ({
          ...current,
          proposals: normalizeArray(current?.proposals).some((entry) => entry.id === proposal.id)
            ? normalizeArray(current?.proposals).map((entry) => entry.id === proposal.id ? proposal : entry)
            : [proposal, ...normalizeArray(current?.proposals)]
        }));
      }
      const message = formatDisplayValue(result.payload?.error, `Moon could not ${action} the AI proposal.`);
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setData((current) => ({
      ...current,
      proposals: normalizeArray(current?.proposals).map((entry) => entry.id === proposal.id ? proposal : entry)
    }));
    const message = action === "confirm" ? "AI proposal confirmed." : "AI proposal cancelled.";
    setFlash(message);
    setFlashTone("good");
    notify({message, tone: "good", category: "action"});
    void refreshAiPage();
  };

  if (loading || !draft) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading AI</h2>
        <p>Moon is reading Oracle settings and LocalAI runtime state through Sage.</p>
      </section>
    );
  }

  const profiles = normalizeArray(
    data?.localAiProfile?.profiles
      || data?.localAi?.profiles
      || data?.localAiProfile?.availableProfiles
      || data?.localAi?.availableProfiles
  );
  const oracleStatusLabel = resolveOracleStatusLabel(data);
  const localAiStatusLabel = resolveLocalAiStatusLabel(data?.localAi);
  const localAiHealthLabel = formatDisplayValue(data?.localAi?.message, localAiStatusLabel);
  const modelPayload = normalizeString(modelOptions?.provider).toLowerCase() === normalizeString(draft.provider).toLowerCase()
    ? modelOptions
    : null;
  const modelChoices = resolveModelChoices(modelPayload);
  const modelSelectValue = modelChoices.some((choice) => choice.id === draft.model) ? draft.model : "";
  const modelWarning = !modelLoading && modelPayload?.ok === false
    ? formatDisplayValue(modelPayload.error, "Moon could not load available models.")
    : "";
  const localAiTask = resolveLocalAiJobTask(localAiJob);
  const localAiProgress = resolveLocalAiProgress(localAiJob);
  const localAiJobMessage = formatDisplayValue(
    localAiTask?.message || localAiJob?.error || localAiJob?.result?.error || localAiJob?.label,
    "No LocalAI job is running."
  );
  const localAiActionDisabled = !canManageLocalAi || Boolean(actionBusy) || localAiActionActive;
  const oracleSaveDisabled = !canSaveOracle || actionBusy === "oracle" || modelLoading || !modelChoices.length;
  const aiTools = normalizeArray(data?.tools?.tools);
  const proposals = normalizeArray(data?.proposals);

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flashTone}>{flash}</AdminActionBanner> : null}
      {runtimeError ? <AdminActionBanner tone="warning">{runtimeError}</AdminActionBanner> : null}
      {modelWarning ? <AdminActionBanner tone="warning">{modelWarning}</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>AI</h2>
            <p className="admin-muted">Oracle settings and LocalAI lifecycle controls stay brokered through Moon and Sage.</p>
          </div>
          <AdminStatusBadge tone={refreshing || runtimeLoading ? "warning" : oracleTone(oracleStatusLabel)}>
            {refreshing || runtimeLoading ? "Refreshing quietly" : oracleStatusLabel}
          </AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Oracle provider</span><strong>{formatDisplayValue(data?.oracle?.provider, "openai")}</strong></article>
          <article className="admin-metric-card"><span>Model</span><strong>{formatDisplayValue(data?.oracle?.model, "not set")}</strong></article>
          <article className="admin-metric-card"><span>OpenAI key</span><strong>{data?.oracle?.openAiApiKeyConfigured ? "configured" : "missing"}</strong></article>
          <article className="admin-metric-card"><span>LocalAI</span><strong>{localAiStatusLabel}</strong></article>
        </div>
        <div className="admin-log-meta">
          <span>Events: {formatDisplayValue(live.state, "idle")}</span>
          <span>Runtime: {runtimeLoading ? "hydrating" : runtimeError ? "degraded" : "loaded"}</span>
        </div>
      </section>
      <section className="admin-ai-grid">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Oracle</div>
              <h2>Provider settings</h2>
            </div>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Enabled</span>
              <select disabled={!canSaveOracle} value={draft.enabled ? "true" : "false"} onChange={(event) => patchDraft({enabled: event.target.value === "true"})}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
            <label>
              <span>Provider</span>
              <select disabled={!canSaveOracle} value={draft.provider} onChange={(event) => patchDraft({provider: event.target.value, model: ""})}>
                <option value="openai">OpenAI</option>
                <option value="localai">LocalAI</option>
              </select>
            </label>
            <label>
              <span>Model</span>
              <select disabled={!canSaveOracle || modelLoading || !modelChoices.length} value={modelSelectValue} onChange={(event) => patchDraft({model: event.target.value})}>
                {modelLoading ? (
                  <option value="">Loading models...</option>
                ) : modelChoices.length ? modelChoices.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                )) : (
                  <option value="">No models available</option>
                )}
              </select>
            </label>
            <label>
              <span>Temperature</span>
              <input disabled={!canSaveOracle} type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => patchDraft({temperature: event.target.value})} />
            </label>
            <label>
              <span>OpenAI key</span>
              <input disabled={!canSaveOracle} value={draft.openAiApiKey} onChange={(event) => patchDraft({openAiApiKey: event.target.value})} placeholder={data?.oracle?.openAiApiKeyConfigured ? "Configured - leave blank to keep" : "Paste key to configure"} />
            </label>
          </div>
          <button className="admin-button solid" type="button" disabled={oracleSaveDisabled} onClick={() => void saveOracle()}>
            {actionBusy === "oracle" ? "Saving..." : "Save Oracle settings"}
          </button>
        </article>
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">LocalAI</div>
              <h2>Runtime</h2>
            </div>
            <AdminStatusBadge tone={localAiTone(data?.localAi)}>
              {localAiStatusLabel}
            </AdminStatusBadge>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Profile</span>
              <select disabled={!canSaveOracle} value={draft.localAiProfileKey} onChange={(event) => patchDraft({localAiProfileKey: event.target.value})}>
                {profiles.length ? profiles.map((profile, index) => {
                  const value = localAiProfileValue(profile);
                  return (
                    <option key={`${value}-${index}`} value={value}>
                      {localAiProfileLabel(profile)}
                    </option>
                  );
                }) : (
                  <>
                    <option value="nvidia">NVIDIA</option>
                    <option value="cpu">CPU</option>
                  </>
                )}
              </select>
            </label>
            <label>
              <span>Image mode</span>
              <select disabled={!canSaveOracle} value={draft.localAiImageMode} onChange={(event) => patchDraft({localAiImageMode: event.target.value})}>
                <option value="preset">Preset</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label>
              <span>Custom image</span>
              <input disabled={!canSaveOracle || draft.localAiImageMode !== "custom"} value={draft.localAiCustomImage} onChange={(event) => patchDraft({localAiCustomImage: event.target.value})} />
            </label>
          </div>
          <div className="admin-action-row">
            <button className="admin-button ghost" type="button" disabled={localAiActionDisabled} onClick={() => void runLocalAiAction("install")}>
              {actionBusy === "install" ? "Starting job..." : "Install LocalAI"}
            </button>
            <button className="admin-button solid" type="button" disabled={localAiActionDisabled} onClick={() => void runLocalAiAction("start")}>
              {actionBusy === "start" ? "Starting job..." : "Start LocalAI"}
            </button>
            <button className="admin-button ghost danger" type="button" disabled={localAiActionDisabled || (!data?.localAi?.installed && !data?.localAi?.running)} onClick={() => void runLocalAiAction("remove")}>
              {actionBusy === "remove" ? "Starting job..." : "Remove LocalAI"}
            </button>
          </div>
          {localAiJob ? (
            <div className={`admin-progress-card ${localAiJobStatus === "failed" ? "is-danger" : ""}`}>
              <div className="admin-progress-head">
                <div>
                  <div className="admin-kicker">Lifecycle job</div>
                  <strong>{formatDisplayValue(localAiJob.label, "LocalAI job")}</strong>
                </div>
                <AdminStatusBadge tone={localAiJobStatus === "completed" ? "good" : localAiJobStatus === "failed" ? "bad" : "warning"}>
                  {formatDisplayValue(localAiJob.status, "running")}
                </AdminStatusBadge>
              </div>
              <div className="admin-progress-track" aria-label="LocalAI progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={localAiProgress} role="progressbar">
                <span style={{width: `${localAiProgress}%`}} />
              </div>
              <div className="admin-progress-meta">
                <span>{localAiProgress}%</span>
                <span>{formatDisplayValue(localAiTask?.label, "Waiting for job")}</span>
              </div>
              <p className="admin-muted">{localAiJobMessage}</p>
            </div>
          ) : null}
          <div className="admin-detail-grid">
            <span><strong>Profile</strong>{resolveSelectedLocalAiProfile(data, draft)}</span>
            <span><strong>Image</strong>{resolveLocalAiImage(data?.localAi)}</span>
            <span><strong>Updated</strong>{formatDate(data?.localAi?.updatedAt || data?.localAi?.checkedAt)}</span>
            <span><strong>Health</strong>{localAiHealthLabel}</span>
          </div>
        </article>
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Test</div>
            <h2>Admin prompt</h2>
            <p className="admin-muted">A small smoke test through Oracle. It should degrade gracefully if AI is offline.</p>
          </div>
        </div>
        <div className="admin-filter-bar">
          <label className="admin-filter-grow">
            <span>Prompt</span>
            <input value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} />
          </label>
          <button className="admin-button solid" type="button" onClick={() => void runTest()}>Send test</button>
        </div>
        {testReply ? <pre className="admin-ai-reply">{testReply}</pre> : <div className="admin-empty">No test response yet.</div>}
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Sage tools</div>
            <h2>{aiTools.length} governed tool{aiTools.length === 1 ? "" : "s"}</h2>
            <p className="admin-muted">Read tools can run immediately. Operational tools create proposals and require admin confirmation.</p>
          </div>
        </div>
        <AdminDenseTable
          rows={aiTools}
          getKey={(row) => row.id}
          columns={[
            {key: "enabled", label: "Enabled", render: (row) => (
              <input
                aria-label={`${row.label} enabled`}
                checked={row.enabled !== false}
                disabled={!canToggleTools || actionBusy === `tool:${row.id}`}
                type="checkbox"
                onChange={(event) => void saveToolToggle(row.id, event.target.checked)}
              />
            )},
            {key: "tool", label: "Tool", render: (row) => (
              <span>
                <strong>{row.label}</strong>
                <br />
                <span className="admin-muted">{row.description}</span>
              </span>
            )},
            {key: "kind", label: "Kind", render: (row) => <AdminStatusBadge tone={row.kind === "read" ? "good" : "warning"}>{row.kind}</AdminStatusBadge>},
            {key: "risk", label: "Risk", render: (row) => formatDisplayValue(row.risk, "safe")},
            {key: "grant", label: "Grant", render: (row) => `${row.grant?.domain || "ai"}:${row.grant?.level || "read"}`},
            {key: "lastUsed", label: "Last used", render: (row) => formatDate(row.lastUsedAt)}
          ]}
        />
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Assistant</div>
            <h2>Operational prompt</h2>
            <p className="admin-muted">Ask Noona to inspect state or draft an allowlisted action proposal.</p>
          </div>
        </div>
        <div className="admin-filter-bar">
          <label>
            <span>Tool</span>
            <select value={assistToolId} onChange={(event) => setAssistToolId(event.target.value)}>
              <option value="">Auto</option>
              {aiTools.map((tool) => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
            </select>
          </label>
          <label className="admin-filter-grow">
            <span>Prompt</span>
            <input value={assistPrompt} onChange={(event) => setAssistPrompt(event.target.value)} />
          </label>
          <button className="admin-button solid" type="button" disabled={actionBusy === "assist"} onClick={() => void runAssist()}>
            {actionBusy === "assist" ? "Thinking..." : "Ask AI"}
          </button>
        </div>
        {assistReply ? <pre className="admin-ai-reply">{assistReply}</pre> : null}
        {proposals.length ? (
          <AdminDenseTable
            rows={proposals}
            getKey={(row) => row.id}
            columns={[
              {key: "status", label: "Status", render: (row) => <AdminStatusBadge tone={row.status === "pending" ? "warning" : row.status === "confirmed" ? "good" : "queued"}>{row.status}</AdminStatusBadge>},
              {key: "tool", label: "Tool", render: (row) => formatDisplayValue(row.toolId, "tool")},
              {key: "prompt", label: "Prompt", render: (row) => formatDisplayValue(row.prompt, "none")},
              {key: "expires", label: "Expires", render: (row) => formatDate(row.expiresAt)},
              {key: "actions", label: "Actions", render: (row) => row.status === "pending" ? (
                <span className="admin-action-row">
                  <button className="admin-button solid" type="button" disabled={Boolean(actionBusy)} onClick={() => void updateProposal(row.id, "confirm")}>Confirm</button>
                  <button className="admin-button ghost" type="button" disabled={Boolean(actionBusy)} onClick={() => void updateProposal(row.id, "cancel")}>Cancel</button>
                </span>
              ) : formatDate(row.updatedAt)}
            ]}
          />
        ) : <div className="admin-empty">No AI proposals yet.</div>}
      </section>
    </>
  );
};

export default SystemAiPage;
