"use client";

/**
 * @file Shared admin toast provider and live-event bridge.
 */

import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventSubscription} from "../lib/api.js";
import {createToastDedupeState, serializeToastDedupeState, shouldShowToast} from "../lib/toastDedupe.js";

const defaultPreferences = Object.freeze({
  actionToasts: true,
  jobToasts: true,
  liveEventToasts: true,
  failuresOnly: false,
  severities: {
    info: true,
    success: true,
    warning: true,
    error: true
  }
});

const eventDomainsByGrant = Object.freeze({
  overview: ["overview"],
  library: ["library", "reader", "follow"],
  add: ["add"],
  import: ["import"],
  calendar: ["calendar"],
  mediamanagement: ["mediamanagement"],
  activity: ["activity"],
  wanted: ["wanted"],
  requests: ["requests"],
  users: ["users", "auth", "access"],
  discord: ["discord"],
  ai: ["ai"],
  settings: ["settings"],
  database: ["database"],
  system: ["system"],
  publicapi: ["publicapi"]
});

const AdminToastContext = createContext({
  notify: () => {},
  preferences: defaultPreferences,
  toastSettings: {global: defaultPreferences, personal: null, effective: defaultPreferences, canEditGlobal: false},
  savePersonalPreferences: async () => ({ok: false}),
  saveGlobalPreferences: async () => ({ok: false}),
  refreshToastSettings: async () => {}
});

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const toneToSeverity = (tone = "") => {
  const normalized = normalizeString(tone).toLowerCase();
  if (["bad", "failed", "error"].includes(normalized)) {
    return "error";
  }
  if (["warning", "queued"].includes(normalized)) {
    return "warning";
  }
  if (["good", "success", "running"].includes(normalized)) {
    return "success";
  }
  return "info";
};

const normalizePreferences = (value, fallback = defaultPreferences) => {
  const severities = value?.severities && typeof value.severities === "object" ? value.severities : {};
  return {
    actionToasts: value?.actionToasts ?? fallback.actionToasts,
    jobToasts: value?.jobToasts ?? fallback.jobToasts,
    liveEventToasts: value?.liveEventToasts ?? fallback.liveEventToasts,
    failuresOnly: value?.failuresOnly ?? fallback.failuresOnly,
    severities: {
      info: severities.info ?? fallback.severities.info,
      success: severities.success ?? fallback.severities.success,
      warning: severities.warning ?? fallback.severities.warning,
      error: severities.error ?? fallback.severities.error
    }
  };
};

const canShowCategory = (preferences, category) => {
  if (category === "job") {
    return preferences.jobToasts !== false;
  }
  if (category === "event") {
    return preferences.liveEventToasts !== false;
  }
  return preferences.actionToasts !== false;
};

const accessibleEventDomains = (user) => {
  if (!user) {
    return [];
  }
  const domains = new Set();
  for (const [grantDomain, eventDomains] of Object.entries(eventDomainsByGrant)) {
    if (hasAdminGrant(user, grantDomain, "read")) {
      eventDomains.forEach((domain) => domains.add(domain));
    }
  }
  return Array.from(domains).sort();
};

const normalizeSequence = (value) => Math.max(0, Number.parseInt(String(value || 0), 10) || 0);

const toastStorageKey = (user) => {
  const userKey = normalizeString(user?.discordUserId || user?.id || user?.username, "anonymous");
  return `scriptarr.admin.toast-dedupe.v1.${userKey}`;
};

/**
 * Read persisted toast dedupe state for the signed-in admin.
 *
 * @param {string} key
 * @returns {{dedupe: ReturnType<typeof createToastDedupeState>, afterSequence: number}}
 */
const readStoredToastDedupe = (key) => {
  if (!key || typeof window === "undefined" || !window.localStorage) {
    return {dedupe: createToastDedupeState(), afterSequence: 0};
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "{}");
    return {
      dedupe: createToastDedupeState(parsed.dedupe),
      afterSequence: normalizeSequence(parsed.afterSequence)
    };
  } catch {
    return {dedupe: createToastDedupeState(), afterSequence: 0};
  }
};

/**
 * Persist the toast dedupe cache and event cursor after receiving live events.
 *
 * @param {string} key
 * @param {ReturnType<typeof createToastDedupeState>} dedupe
 * @param {number} afterSequence
 */
const writeStoredToastDedupe = (key, dedupe, afterSequence) => {
  if (!key || typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify({
      dedupe: serializeToastDedupeState(dedupe),
      afterSequence: normalizeSequence(afterSequence),
      updatedAt: new Date().toISOString()
    }));
  } catch {
    // Toasts are optional UI polish; storage denial should not break admin pages.
  }
};

/**
 * Read the shared admin toast context.
 *
 * @returns {React.ContextType<typeof AdminToastContext>}
 */
export const useAdminToast = () => useContext(AdminToastContext);

/**
 * Mount the shared toast stack and optional live event subscription.
 *
 * @param {{children: import("react").ReactNode, user: any}} props
 * @returns {import("react").ReactNode}
 */
export const AdminToastProvider = ({children, user}) => {
  const [toasts, setToasts] = useState([]);
  const [toastSettings, setToastSettings] = useState({
    global: defaultPreferences,
    personal: null,
    effective: defaultPreferences,
    canEditGlobal: false
  });
  const dedupeState = useRef(createToastDedupeState());
  const eventCursor = useRef(0);
  const storageKey = useMemo(() => user ? toastStorageKey(user) : "", [user]);
  const preferences = useMemo(() =>
    normalizePreferences(toastSettings.effective || defaultPreferences),
  [toastSettings.effective]);

  useEffect(() => {
    const stored = readStoredToastDedupe(storageKey);
    dedupeState.current = stored.dedupe;
    eventCursor.current = stored.afterSequence;
  }, [storageKey]);

  const refreshToastSettings = useCallback(async () => {
    if (!user) {
      return;
    }
    const result = await requestJson("/api/moon/v3/admin/settings/toasts");
    const nextToastSettings = result.payload?.toastSettings || result.payload;
    if (result.ok && nextToastSettings?.effective) {
      setToastSettings({
        global: normalizePreferences(nextToastSettings.global),
        personal: nextToastSettings.personal
          ? normalizePreferences(nextToastSettings.personal, nextToastSettings.global)
          : null,
        effective: normalizePreferences(nextToastSettings.effective),
        canEditGlobal: Boolean(nextToastSettings.canEditGlobal)
      });
    }
  }, [user]);

  useEffect(() => {
    void refreshToastSettings();
  }, [refreshToastSettings]);

  const notify = useCallback((input) => {
    const message = normalizeString(input?.message);
    if (!message) {
      return;
    }
    const category = normalizeString(input?.category, "action");
    const severity = normalizeString(input?.severity, toneToSeverity(input?.tone));
    if (!canShowCategory(preferences, category)) {
      return;
    }
    if (preferences.failuresOnly && severity !== "error") {
      return;
    }
    if (preferences.severities?.[severity] === false) {
      return;
    }
    const dedupeKey = normalizeString(input?.eventId || input?.id);
    const eventSequence = normalizeSequence(input?.eventSequence || input?.sequence);
    const shouldShow = shouldShowToast(dedupeState.current, {id: dedupeKey, category, severity, message});
    if (category === "event") {
      eventCursor.current = Math.max(eventCursor.current, eventSequence);
      writeStoredToastDedupe(storageKey, dedupeState.current, eventCursor.current);
    }
    if (!shouldShow) {
      return;
    }
    const id = dedupeKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tone = normalizeString(input?.tone, severity === "error" ? "bad" : severity === "warning" ? "warning" : "good");
    setToasts((current) => [
      ...current.slice(-4),
      {id, message, tone, severity}
    ]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, Number(input?.durationMs || 8000));
  }, [preferences, storageKey]);

  const liveEventDomains = useMemo(() => accessibleEventDomains(user), [user]);
  useAdminEventSubscription({
    domains: liveEventDomains,
    enabled: Boolean(user && liveEventDomains.length && preferences.liveEventToasts !== false),
    onEvent: (payload) => {
      notify({
        category: "event",
        eventId: payload?.eventId || payload?.sequence,
        eventSequence: payload?.sequence,
        message: payload?.message,
        severity: payload?.severity || "info",
        tone: payload?.severity === "error" ? "bad" : payload?.severity === "warning" ? "warning" : "good"
      });
    }
  });

  const savePersonalPreferences = useCallback(async (nextPreferences) => {
    const result = await requestJson("/api/moon/v3/admin/settings/toasts/personal", {
      method: "PUT",
      json: normalizePreferences(nextPreferences, preferences)
    });
    if (result.ok) {
      setToastSettings(result.payload);
      notify({message: "Personal toast preferences saved.", tone: "good", category: "action"});
    }
    return result;
  }, [notify, preferences]);

  const saveGlobalPreferences = useCallback(async (nextPreferences) => {
    const result = await requestJson("/api/moon/v3/admin/settings/toasts/global", {
      method: "PUT",
      json: normalizePreferences(nextPreferences, toastSettings.global)
    });
    if (result.ok) {
      setToastSettings(result.payload);
      notify({message: "Global toast defaults saved.", tone: "good", category: "action"});
    }
    return result;
  }, [notify, toastSettings.global]);

  const value = useMemo(() => ({
    notify,
    preferences,
    toastSettings,
    savePersonalPreferences,
    saveGlobalPreferences,
    refreshToastSettings
  }), [notify, preferences, refreshToastSettings, saveGlobalPreferences, savePersonalPreferences, toastSettings]);

  return (
    <AdminToastContext.Provider value={value}>
      {children}
      {toasts.length ? (
        <div className="admin-toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div className={`admin-toast ${toast.tone}`} key={toast.id}>{toast.message}</div>
          ))}
        </div>
      ) : null}
    </AdminToastContext.Provider>
  );
};

export default AdminToastProvider;
