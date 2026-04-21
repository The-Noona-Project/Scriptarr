/**
 * @file Scriptarr Sage module: services/sage/lib/registerInternalBrokerRoutes.mjs.
 */
import {knownPortalDiscordCommands, readPortalDiscordSettings} from "./portalDiscordSettings.mjs";
import {buildIntakeSelection, evaluateSelectionAgainstGuardState} from "./requestSelectionGuards.mjs";
import {buildRequestWorkConflictPayload, isRequestWorkConflictError} from "./requestConflict.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const normalizeScalarString = (value, fallback = "") => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || fallback;
  }
  return fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

const withService = (requireService, allowedServices, handler) => async (req, res) => {
  await requireService(allowedServices)(req, res, async () => {
    await handler(req, res);
  });
};

const proxyResult = async (res, promise) => {
  const result = await promise;
  res.status(result.status).json(result.payload);
};

const readUserScopedSetting = async (vaultClient, prefix, discordUserId, fallback) => {
  const setting = await vaultClient.getSetting(`${prefix}.${discordUserId}`);
  return setting?.value ?? fallback;
};

const writeUserScopedSetting = async (vaultClient, prefix, discordUserId, value) =>
  vaultClient.setSetting(`${prefix}.${discordUserId}`, value);

const safeServiceJson = async (promise) => {
  try {
    return await promise;
  } catch (error) {
    return {
      ok: false,
      status: 503,
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
};

const FOLLOW_NOTIFICATION_ACK_PREFIX = "portal.followNotifications";
const REQUEST_NOTIFICATION_ACK_PREFIX = "portal.requestNotifications";

const normalizeTitleKey = (value) => normalizeString(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();
const titleIdentityKey = (titleName, typeSlug) => {
  const normalizedTitle = normalizeTitleKey(titleName);
  if (!normalizedTitle) {
    return "";
  }
  return `${normalizeTypeSlug(typeSlug)}::${normalizedTitle}`;
};

const matchesLibraryQuery = (title, query) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    normalizeString(title?.title),
    ...normalizeArray(title?.aliases),
    normalizeString(title?.libraryTypeLabel),
    normalizeString(title?.latestChapter)
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
};

const toPortalLibraryResult = (config, title = {}) => {
  const typeSlug = normalizeTypeSlug(title.libraryTypeSlug || title.mediaType);
  return {
    id: normalizeString(title.id),
    title: normalizeString(title.title, "Untitled"),
    mediaType: normalizeString(title.mediaType, "manga"),
    libraryTypeLabel: normalizeString(title.libraryTypeLabel, normalizeString(title.mediaType, "Manga")),
    libraryTypeSlug: typeSlug,
    latestChapter: normalizeString(title.latestChapter),
    summary: normalizeString(title.summary),
    aliases: normalizeArray(title.aliases),
    coverUrl: normalizeString(title.coverUrl),
    moonTitleUrl: `${config.publicBaseUrl}/title/${encodeURIComponent(typeSlug)}/${encodeURIComponent(normalizeString(title.id))}`,
    moonLibraryUrl: `${config.publicBaseUrl}/library/${encodeURIComponent(typeSlug)}`
  };
};

const createIntakeBackedRequestPayload = (body = {}, requestedBy) => {
  const selectedMetadata = normalizeObject(body.selectedMetadata);
  const selectedDownload = normalizeObject(body.selectedDownload);
  return {
    source: normalizeString(body.source, "discord"),
    title: normalizeString(selectedMetadata?.title, body.title || "Untitled request"),
    requestType: normalizeString(body.requestType || selectedDownload?.requestType || selectedMetadata?.type || "manga", "manga"),
    notes: normalizeString(body.notes),
    requestedBy,
    status: selectedDownload?.titleUrl ? "pending" : "unavailable",
    details: {
      query: normalizeString(body.query),
      selectedMetadata,
      selectedDownload,
      availability: selectedDownload?.titleUrl ? "available" : "unavailable"
    }
  };
};

const loadPortalRequestGuardState = async ({config, vaultClient, serviceJson}) => {
  const [libraryResult, requests, taskResult] = await Promise.all([
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/library")),
    vaultClient.listRequests(),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/downloads/tasks"))
  ]);

  return {
    libraryTitles: normalizeArray(libraryResult.payload?.titles),
    requests: normalizeArray(requests),
    tasks: normalizeArray(taskResult.payload)
  };
};

const buildFollowEntry = (payload = {}) => ({
  titleId: normalizeString(payload.titleId),
  title: normalizeString(payload.title),
  latestChapter: normalizeString(payload.latestChapter),
  mediaType: normalizeString(payload.mediaType, "manga"),
  libraryTypeLabel: normalizeString(payload.libraryTypeLabel, normalizeString(payload.mediaType, "Manga")),
  libraryTypeSlug: normalizeTypeSlug(payload.libraryTypeSlug || payload.mediaType)
});

const followNotificationId = (discordUserId, taskId) => `${discordUserId}::${taskId}`;

const parseFollowNotificationId = (value) => {
  const [discordUserId = "", taskId = ""] = normalizeString(value).split("::");
  return {
    discordUserId: normalizeString(discordUserId),
    taskId: normalizeString(taskId)
  };
};

const matchesFollowTask = (follow, task) => {
  const followTitleId = normalizeString(follow?.titleId);
  const taskTitleId = normalizeString(task?.titleId);
  if (followTitleId && taskTitleId) {
    return followTitleId === taskTitleId;
  }

  return normalizeTitleKey(follow?.title) === normalizeTitleKey(task?.titleName);
};

const readAckedFollowNotifications = async (vaultClient, discordUserId) =>
  normalizeArray((await vaultClient.getSetting(`${FOLLOW_NOTIFICATION_ACK_PREFIX}.${discordUserId}`))?.value)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);

const writeAckedFollowNotifications = async (vaultClient, discordUserId, taskIds) =>
  vaultClient.setSetting(`${FOLLOW_NOTIFICATION_ACK_PREFIX}.${discordUserId}`, normalizeArray(taskIds)
    .map((entry) => normalizeString(entry))
    .filter(Boolean));

const readRequestNotificationState = async (vaultClient, requestId) =>
  normalizeObject((await vaultClient.getSetting(`${REQUEST_NOTIFICATION_ACK_PREFIX}.${requestId}`))?.value, {}) || {};

const writeRequestNotificationState = async (vaultClient, requestId, value) =>
  vaultClient.setSetting(`${REQUEST_NOTIFICATION_ACK_PREFIX}.${requestId}`, normalizeObject(value, {}) || {});

const normalizeRequestNotificationState = (value = {}) => {
  const normalized = normalizeObject(value, {}) || {};
  return {
    approvedSentAt: normalizeString(
      normalized.approvedSentAt,
      normalizeString(normalized.approved?.sentAt)
    ),
    deniedSentAt: normalizeString(
      normalized.deniedSentAt,
      normalizeString(normalized.denied?.sentAt)
    ),
    completedSentAt: normalizeString(
      normalized.completedSentAt,
      normalizeString(
        normalized.completed?.sentAt,
        normalizeString(normalized.status) === "completed"
          ? normalizeString(normalized.sentAt)
          : ""
      )
    )
  };
};

const isRequestNotificationAcked = (state, decisionType) =>
  Boolean(normalizeRequestNotificationState(state)[`${decisionType}SentAt`]);

const markRequestNotificationAcked = (state, decisionType, sentAt = new Date().toISOString()) => {
  const normalized = normalizeRequestNotificationState(state);
  return {
    ...normalized,
    [`${decisionType}SentAt`]: normalizeString(sentAt, new Date().toISOString())
  };
};

const buildRequestNotificationId = (requestId, decisionType) =>
  normalizeString(decisionType) === "completed"
    ? normalizeString(requestId)
    : `${normalizeString(requestId)}:${normalizeString(decisionType)}`;

const parseRequestNotificationId = (value) => {
  const normalized = normalizeString(value);
  const match = normalized.match(/^(.*?):(approved|denied|completed)$/);
  if (!match) {
    return {
      requestId: normalized,
      decisionType: "completed"
    };
  }
  return {
    requestId: normalizeString(match[1]),
    decisionType: normalizeString(match[2], "completed")
  };
};

const buildPortalStatusSummary = async ({config, vaultClient, serviceJson}) => {
  const [warden, portal, oracle, raven, requests, tasks, users] = await Promise.all([
    safeServiceJson(serviceJson(config.wardenBaseUrl, "/health")),
    safeServiceJson(serviceJson(config.portalBaseUrl, "/health")),
    safeServiceJson(serviceJson(config.oracleBaseUrl, "/health")),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/health")),
    vaultClient.listRequests(),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/downloads/tasks")),
    vaultClient.listUsers()
  ]);

  const normalizedTasks = normalizeArray(tasks.payload);
  const normalizedRequests = normalizeArray(requests);
  const followers = await Promise.all(normalizeArray(users).map(async (user) => {
    const discordUserId = normalizeString(user?.discordUserId);
    if (!discordUserId) {
      return 0;
    }
    return normalizeArray(await readUserScopedSetting(vaultClient, "moon.following", discordUserId, [])).length;
  }));

  return {
    services: {
      warden: warden.payload || warden,
      portal: portal.payload || portal,
      oracle: oracle.payload || oracle,
      raven: raven.payload || raven
    },
    requests: {
      pending: normalizedRequests.filter((entry) => normalizeString(entry?.status) === "pending").length,
      unavailable: normalizedRequests.filter((entry) => normalizeString(entry?.status) === "unavailable").length,
      queued: normalizedRequests.filter((entry) => normalizeString(entry?.status) === "queued").length,
      downloading: normalizedRequests.filter((entry) => normalizeString(entry?.status) === "downloading").length
    },
    tasks: {
      queued: normalizedTasks.filter((entry) => normalizeString(entry?.status) === "queued").length,
      running: normalizedTasks.filter((entry) => normalizeString(entry?.status) === "running").length,
      completed: normalizedTasks.filter((entry) => normalizeString(entry?.status) === "completed").length,
      failed: normalizedTasks.filter((entry) => normalizeString(entry?.status) === "failed").length
    },
    followers: followers.reduce((sum, count) => sum + count, 0)
  };
};

const buildFollowNotifications = async ({config, vaultClient, serviceJson}) => {
  const [users, tasksResponse, libraryResponse] = await Promise.all([
    vaultClient.listUsers(),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/downloads/tasks")),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/library"))
  ]);

  const buildLibraryLookup = (titles = []) => {
    const byId = new Map();
    const bySourceUrl = new Map();
    const byIdentity = new Map();

    for (const title of normalizeArray(titles)) {
      const titleId = normalizeScalarString(title?.id);
      if (titleId && !byId.has(titleId)) {
        byId.set(titleId, title);
      }

      const sourceUrl = normalizeString(title?.sourceUrl);
      if (sourceUrl && !bySourceUrl.has(sourceUrl)) {
        bySourceUrl.set(sourceUrl, title);
      }

      const primaryIdentity = titleIdentityKey(title?.title, title?.libraryTypeSlug || title?.mediaType);
      if (primaryIdentity && !byIdentity.has(primaryIdentity)) {
        byIdentity.set(primaryIdentity, title);
      }
      for (const alias of normalizeArray(title?.aliases)) {
        const aliasIdentity = titleIdentityKey(alias, title?.libraryTypeSlug || title?.mediaType);
        if (aliasIdentity && !byIdentity.has(aliasIdentity)) {
          byIdentity.set(aliasIdentity, title);
        }
      }
    }

    return {byId, bySourceUrl, byIdentity};
  };
  const libraryLookup = buildLibraryLookup(libraryResponse.ok ? libraryResponse.payload?.titles : []);
  const resolveLibraryTitle = ({titleId, sourceUrl, titleName, typeSlug}) => {
    const normalizedTitleId = normalizeScalarString(titleId);
    if (normalizedTitleId && libraryLookup.byId.has(normalizedTitleId)) {
      return libraryLookup.byId.get(normalizedTitleId);
    }

    const normalizedSourceUrl = normalizeString(sourceUrl);
    if (normalizedSourceUrl && libraryLookup.bySourceUrl.has(normalizedSourceUrl)) {
      return libraryLookup.bySourceUrl.get(normalizedSourceUrl);
    }

    const identity = titleIdentityKey(titleName, typeSlug);
    if (identity && libraryLookup.byIdentity.has(identity)) {
      return libraryLookup.byIdentity.get(identity);
    }

    return null;
  };

  const completedTasks = normalizeArray(tasksResponse.payload)
    .filter((task) => normalizeString(task?.status) === "completed")
    .sort((left, right) => normalizeString(right?.updatedAt).localeCompare(normalizeString(left?.updatedAt)));

  const notifications = [];
  for (const user of normalizeArray(users)) {
    const discordUserId = normalizeString(user?.discordUserId);
    if (!discordUserId) {
      continue;
    }

    const [following, ackedTaskIds] = await Promise.all([
      readUserScopedSetting(vaultClient, "moon.following", discordUserId, []),
      readAckedFollowNotifications(vaultClient, discordUserId)
    ]);
    const ackedSet = new Set(ackedTaskIds);
    for (const follow of normalizeArray(following)) {
      for (const task of completedTasks) {
        const taskId = normalizeString(task?.taskId);
        if (!taskId || ackedSet.has(taskId) || !matchesFollowTask(follow, task)) {
          continue;
        }

        const matchedTitle = resolveLibraryTitle({
          titleId: task?.titleId || follow?.titleId,
          sourceUrl: task?.titleUrl,
          titleName: task?.titleName || follow?.title,
          typeSlug: task?.libraryTypeSlug || follow?.libraryTypeSlug || follow?.mediaType
        });
        const resolvedTitleId = normalizeScalarString(
          task?.titleId,
          normalizeScalarString(follow?.titleId, normalizeScalarString(matchedTitle?.id))
        );
        const resolvedTypeSlug = normalizeTypeSlug(
          task?.libraryTypeSlug || follow?.libraryTypeSlug || follow?.mediaType || matchedTitle?.libraryTypeSlug
        );

        notifications.push({
          id: followNotificationId(discordUserId, taskId),
          discordUserId,
          username: normalizeString(user?.username, "Reader"),
          taskId,
          titleId: resolvedTitleId,
          titleName: normalizeString(task?.titleName, normalizeString(follow?.title, "Untitled")),
          libraryTypeSlug: resolvedTypeSlug,
          latestChapter: normalizeString(task?.message),
          coverUrl: normalizeString(task?.coverUrl, normalizeString(matchedTitle?.coverUrl)),
          titleUrl: resolvedTitleId
            ? `${config.publicBaseUrl}/title/${encodeURIComponent(resolvedTypeSlug)}/${encodeURIComponent(resolvedTitleId)}`
            : "",
          sentAt: normalizeString(task?.updatedAt)
        });
      }
    }
  }

  return notifications.slice(0, 50);
};

const buildRequestNotifications = async ({config, vaultClient, serviceJson}) => {
  const [users, requests, tasksResponse, libraryResponse] = await Promise.all([
    vaultClient.listUsers(),
    vaultClient.listRequests(),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/downloads/tasks")),
    safeServiceJson(serviceJson(config.ravenBaseUrl, "/v1/library"))
  ]);

  const usersByDiscordId = new Map(normalizeArray(users)
    .map((user) => [normalizeScalarString(user?.discordUserId), user])
    .filter(([discordUserId]) => discordUserId));
  const buildLibraryLookup = (titles = []) => {
    const byId = new Map();
    const bySourceUrl = new Map();
    const byIdentity = new Map();

    for (const title of normalizeArray(titles)) {
      const titleId = normalizeScalarString(title?.id);
      if (titleId && !byId.has(titleId)) {
        byId.set(titleId, title);
      }

      const sourceUrl = normalizeString(title?.sourceUrl);
      if (sourceUrl && !bySourceUrl.has(sourceUrl)) {
        bySourceUrl.set(sourceUrl, title);
      }

      const primaryIdentity = titleIdentityKey(title?.title, title?.libraryTypeSlug || title?.mediaType);
      if (primaryIdentity && !byIdentity.has(primaryIdentity)) {
        byIdentity.set(primaryIdentity, title);
      }
      for (const alias of normalizeArray(title?.aliases)) {
        const aliasIdentity = titleIdentityKey(alias, title?.libraryTypeSlug || title?.mediaType);
        if (aliasIdentity && !byIdentity.has(aliasIdentity)) {
          byIdentity.set(aliasIdentity, title);
        }
      }
    }

    return {byId, bySourceUrl, byIdentity};
  };
  const libraryLookup = buildLibraryLookup(libraryResponse.ok ? libraryResponse.payload?.titles : []);
  const resolveLibraryTitle = ({titleId, sourceUrl, titleName, typeSlug}) => {
    const normalizedTitleId = normalizeScalarString(titleId);
    if (normalizedTitleId && libraryLookup.byId.has(normalizedTitleId)) {
      return libraryLookup.byId.get(normalizedTitleId);
    }

    const normalizedSourceUrl = normalizeString(sourceUrl);
    if (normalizedSourceUrl && libraryLookup.bySourceUrl.has(normalizedSourceUrl)) {
      return libraryLookup.bySourceUrl.get(normalizedSourceUrl);
    }

    const identity = titleIdentityKey(titleName, typeSlug);
    if (identity && libraryLookup.byIdentity.has(identity)) {
      return libraryLookup.byIdentity.get(identity);
    }

    return null;
  };
  const completedTasks = normalizeArray(tasksResponse.payload)
    .filter((task) => normalizeString(task?.status) === "completed")
    .sort((left, right) => normalizeString(right?.updatedAt).localeCompare(normalizeString(left?.updatedAt)));
  const tasksByRequestId = new Map();
  const tasksByTaskId = new Map();
  for (const task of completedTasks) {
    const requestId = normalizeScalarString(task?.requestId);
    const taskId = normalizeScalarString(task?.taskId);
    if (requestId && !tasksByRequestId.has(requestId)) {
      tasksByRequestId.set(requestId, task);
    }
    if (taskId && !tasksByTaskId.has(taskId)) {
      tasksByTaskId.set(taskId, task);
    }
  }

  const notifications = [];
  for (const request of normalizeArray(requests)
    .sort((left, right) => normalizeString(right?.updatedAt).localeCompare(normalizeString(left?.updatedAt)))) {
    const requestId = normalizeScalarString(request?.id);
    const requesterDiscordId = normalizeScalarString(request?.requestedBy);
    if (!requestId || !requesterDiscordId || !usersByDiscordId.has(requesterDiscordId)) {
      continue;
    }

    const notificationState = normalizeRequestNotificationState(await readRequestNotificationState(vaultClient, requestId));

    const details = normalizeObject(request?.details, {}) || {};
    const linkedTask = tasksByRequestId.get(requestId) || tasksByTaskId.get(normalizeScalarString(details.taskId));
    const matchedTitle = resolveLibraryTitle({
      titleId: linkedTask?.titleId || details?.titleId,
      sourceUrl: linkedTask?.titleUrl || details?.selectedDownload?.titleUrl,
      titleName: linkedTask?.titleName || request?.title || details?.selectedMetadata?.title || details?.selectedDownload?.titleName,
      typeSlug: linkedTask?.libraryTypeSlug || details?.selectedDownload?.libraryTypeSlug || request?.requestType
    });
    const titleName = normalizeString(linkedTask?.titleName, normalizeString(request?.title, "Untitled"));
    const libraryTypeSlug = normalizeTypeSlug(
      linkedTask?.libraryTypeSlug || details?.selectedDownload?.libraryTypeSlug || matchedTitle?.libraryTypeSlug || request?.requestType
    );
    const titleId = normalizeScalarString(linkedTask?.titleId, normalizeScalarString(details?.titleId, normalizeScalarString(matchedTitle?.id)));
    const coverUrl = normalizeString(
      linkedTask?.coverUrl,
      normalizeString(details.coverUrl, normalizeString(details?.selectedDownload?.coverUrl, normalizeString(details?.selectedMetadata?.coverUrl, matchedTitle?.coverUrl)))
    );
    const titleUrl = titleId
      ? `${config.publicBaseUrl}/title/${encodeURIComponent(libraryTypeSlug)}/${encodeURIComponent(titleId)}`
      : "";
    const requestsUrl = `${normalizeString(config.publicBaseUrl).replace(/\/+$/g, "")}/myrequests`;
    const baseNotification = {
      requestId,
      discordUserId: requesterDiscordId,
      username: normalizeString(usersByDiscordId.get(requesterDiscordId)?.username, "Reader"),
      titleName,
      coverUrl,
      moderatorNote: normalizeString(request?.moderatorComment),
      titleUrl,
      requestsUrl
    };
    const requestStatus = normalizeString(request?.status);

    if (["queued", "downloading", "completed"].includes(requestStatus) && !isRequestNotificationAcked(notificationState, "approved")) {
      notifications.push({
        ...baseNotification,
        id: buildRequestNotificationId(requestId, "approved"),
        decisionType: "approved",
        status: requestStatus,
        linkUrl: requestsUrl,
        decidedAt: normalizeString(request?.updatedAt)
      });
    }

    if (requestStatus === "denied" && !isRequestNotificationAcked(notificationState, "denied")) {
      notifications.push({
        ...baseNotification,
        id: buildRequestNotificationId(requestId, "denied"),
        decisionType: "denied",
        status: "denied",
        linkUrl: requestsUrl,
        decidedAt: normalizeString(request?.updatedAt)
      });
    }

    if (requestStatus === "completed" && !isRequestNotificationAcked(notificationState, "completed")) {
      notifications.push({
        ...baseNotification,
        id: buildRequestNotificationId(requestId, "completed"),
        decisionType: "completed",
        status: "completed",
        linkUrl: titleUrl,
        completedAt: normalizeString(linkedTask?.updatedAt, request?.updatedAt)
      });
    }
  }

  return notifications.slice(0, 50);
};

/**
 * Register Sage's token-authenticated internal broker routes. These routes are
 * for first-party service-to-service traffic only; browser clients should
 * continue using Moon-facing Sage endpoints instead.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config: Record<string, string>,
 *   vaultClient: ReturnType<import("./vaultClient.mjs").createVaultClient>,
 *   requireService: (allowedServices: string | string[]) => import("express").RequestHandler,
 *   serviceJson: (baseUrl: string, path: string, options?: {method?: string, body?: unknown, headers?: Record<string, string>}) => Promise<{ok: boolean, status: number, payload: any}>
 * }} options
 */
export const registerInternalBrokerRoutes = (app, {
  config,
  vaultClient,
  requireService,
  serviceJson
}) => {
  app.post("/api/internal/vault/users/upsert-discord", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    res.json(await vaultClient.upsertDiscordUser(req.body || {}));
  }));

  app.get("/api/internal/vault/users/by-discord/:discordUserId", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const user = await vaultClient.getUserByDiscordId(req.params.discordUserId);
    if (!user) {
      res.status(404).json({error: "User not found."});
      return;
    }
    res.json(user);
  }));

  app.get("/api/internal/vault/settings/:key", withService(requireService, ["scriptarr-oracle", "scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.getSetting(req.params.key));
  }));

  app.put("/api/internal/vault/settings/:key", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.setSetting(req.params.key, req.body?.value));
  }));

  app.get("/api/internal/vault/secrets/:key", withService(requireService, ["scriptarr-oracle", "scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.getSecret(req.params.key));
  }));

  app.put("/api/internal/vault/secrets/:key", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.setSecret(req.params.key, req.body?.value));
  }));

  app.get("/api/internal/vault/requests", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    res.json(await vaultClient.listRequests());
  }));

  app.post("/api/internal/vault/requests", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    try {
      res.status(201).json(await vaultClient.createRequest(req.body || {}));
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }
  }));

  app.get("/api/internal/vault/requests/:id", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    const request = await vaultClient.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(request);
  }));

  app.patch("/api/internal/vault/requests/:id", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    let request;
    try {
      request = await vaultClient.updateRequest(req.params.id, req.body || {});
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }
    if (!request) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(request);
  }));

  app.post("/api/internal/vault/requests/:id/review", withService(requireService, ["scriptarr-warden"], async (req, res) => {
    const reviewed = await vaultClient.reviewRequest(req.params.id, req.body || {});
    if (!reviewed) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    res.json(reviewed);
  }));

  app.get("/api/internal/vault/raven/titles", withService(requireService, ["scriptarr-raven"], async (_req, res) => {
    res.json(await vaultClient.listRavenTitles());
  }));

  app.get("/api/internal/vault/raven/titles/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    const title = await vaultClient.getRavenTitle(req.params.titleId);
    if (!title) {
      res.status(404).json({error: "Raven title not found."});
      return;
    }
    res.json(title);
  }));

  app.put("/api/internal/vault/raven/titles/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.upsertRavenTitle(req.params.titleId, {
      ...req.body,
      id: req.params.titleId
    }));
  }));

  app.put("/api/internal/vault/raven/titles/:titleId/chapters", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.replaceRavenChapters(req.params.titleId, normalizeArray(req.body?.chapters)));
  }));

  app.get("/api/internal/vault/raven/download-tasks", withService(requireService, ["scriptarr-raven"], async (_req, res) => {
    res.json(await vaultClient.listRavenDownloadTasks());
  }));

  app.put("/api/internal/vault/raven/download-tasks/:taskId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.upsertRavenDownloadTask(req.params.taskId, {
      ...req.body,
      taskId: req.params.taskId
    }));
  }));

  app.get("/api/internal/vault/raven/metadata-matches/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.getRavenMetadataMatch(req.params.titleId));
  }));

  app.put("/api/internal/vault/raven/metadata-matches/:titleId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.setRavenMetadataMatch(req.params.titleId, req.body || {}));
  }));

  app.get("/api/internal/jobs", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.listJobs({
      ownerService: normalizeString(req.query.ownerService),
      kind: normalizeString(req.query.kind),
      status: normalizeString(req.query.status)
    }));
  }));

  app.get("/api/internal/jobs/:jobId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    const job = await vaultClient.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({error: "Job not found."});
      return;
    }
    res.json(job);
  }));

  app.put("/api/internal/jobs/:jobId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.upsertJob(req.params.jobId, {
      ...req.body,
      jobId: req.params.jobId
    }));
  }));

  app.get("/api/internal/jobs/:jobId/tasks", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.listJobTasks(req.params.jobId, {
      status: normalizeString(req.query.status)
    }));
  }));

  app.put("/api/internal/jobs/:jobId/tasks/:taskId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.upsertJobTask(req.params.jobId, req.params.taskId, {
      ...req.body,
      taskId: req.params.taskId
    }));
  }));

  app.get("/api/internal/warden/bootstrap", withService(requireService, ["scriptarr-oracle"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/bootstrap"));
  }));

  app.get("/api/internal/warden/runtime", withService(requireService, ["scriptarr-oracle"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/runtime"));
  }));

  app.get("/api/internal/warden/updates", withService(requireService, ["scriptarr-oracle"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/updates"));
  }));

  app.post("/api/internal/warden/updates/check", withService(requireService, ["scriptarr-oracle"], async (req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/updates/check", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    }));
  }));

  app.post("/api/internal/warden/updates/install", withService(requireService, ["scriptarr-oracle"], async (req, res) => {
    await proxyResult(res, serviceJson(config.wardenBaseUrl, "/api/updates/install", {
      method: "POST",
      body: {
        services: normalizeArray(req.body?.services)
      }
    }));
  }));

  app.get("/api/internal/oracle/status", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    await proxyResult(res, serviceJson(config.oracleBaseUrl, "/api/status"));
  }));

  app.post("/api/internal/oracle/chat", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await proxyResult(res, serviceJson(config.oracleBaseUrl, "/api/chat", {
      method: "POST",
      body: req.body || {}
    }));
  }));

  app.get("/api/internal/portal/status", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    res.json(await buildPortalStatusSummary({config, vaultClient, serviceJson}));
  }));

  app.get("/api/internal/portal/discord/settings", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    res.json(await readPortalDiscordSettings(vaultClient));
  }));

  app.get("/api/internal/portal/discord-config", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    const [discord, branding] = await Promise.all([
      readPortalDiscordSettings(vaultClient),
      vaultClient.getSetting("moon.branding")
    ]);
    res.json({
      discord,
      branding: branding?.value || {siteName: "Scriptarr"},
      authConfigured: Boolean(config.discordClientId && config.discordClientSecret),
      botTokenConfigured: Boolean(config.discordToken),
      commandCatalog: knownPortalDiscordCommands
    });
  }));

  app.get("/api/internal/portal/library/search", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const result = await serviceJson(config.ravenBaseUrl, "/v1/library");
    if (!result.ok) {
      res.status(result.status).json(result.payload);
      return;
    }

    const query = normalizeString(req.query.query);
    const results = normalizeArray(result.payload?.titles)
      .filter((title) => matchesLibraryQuery(title, query))
      .map((title) => toPortalLibraryResult(config, title));

    res.json({
      query,
      results
    });
  }));

  app.get("/api/internal/portal/intake/search", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await proxyResult(res, serviceJson(config.ravenBaseUrl, `/v1/intake/search?query=${encodeURIComponent(normalizeString(req.query.query))}`));
  }));

  app.post("/api/internal/portal/requests", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const requestedBy = normalizeString(req.body?.requestedBy);
    if (!requestedBy) {
      res.status(400).json({error: "requestedBy is required."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }

    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query),
      title: normalizeString(req.body?.title),
      requestType: normalizeString(req.body?.requestType),
      selectedMetadata,
      selectedDownload: normalizeObject(req.body?.selectedDownload)
    }), await loadPortalRequestGuardState({config, vaultClient, serviceJson}));
    if (guard.alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      res.status(409).json({error: "That title is already queued or has an active request."});
      return;
    }

    try {
      res.status(201).json(await vaultClient.createRequest(createIntakeBackedRequestPayload(req.body, requestedBy)));
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }
  }));

  app.post("/api/internal/portal/requests/from-discord", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    req.url = "/api/internal/portal/requests";
    req.originalUrl = "/api/internal/portal/requests";
    const requestedBy = normalizeString(req.body?.requestedBy || req.body?.discordUserId);
    if (!requestedBy) {
      res.status(400).json({error: "requestedBy is required."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }

    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query),
      title: normalizeString(req.body?.title),
      requestType: normalizeString(req.body?.requestType),
      selectedMetadata,
      selectedDownload: normalizeObject(req.body?.selectedDownload)
    }), await loadPortalRequestGuardState({config, vaultClient, serviceJson}));
    if (guard.alreadyInLibrary) {
      res.status(409).json({error: "That title is already in the Scriptarr library."});
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      res.status(409).json({error: "That title is already queued or has an active request."});
      return;
    }

    try {
      res.status(201).json(await vaultClient.createRequest(createIntakeBackedRequestPayload(req.body, requestedBy)));
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }
  }));

  app.post("/api/internal/portal/following", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const discordUserId = normalizeString(req.body?.discordUserId);
    const nextEntry = buildFollowEntry(req.body || {});
    if (!discordUserId || !nextEntry.titleId) {
      res.status(400).json({error: "discordUserId and titleId are required."});
      return;
    }

    const current = normalizeArray(await readUserScopedSetting(vaultClient, "moon.following", discordUserId, []));
    const deduped = [...current.filter((entry) => entry.titleId !== nextEntry.titleId), nextEntry];
    await writeUserScopedSetting(vaultClient, "moon.following", discordUserId, deduped);
    res.status(201).json({following: deduped});
  }));

  app.post("/api/internal/portal/raven/bulk-queue", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await proxyResult(res, serviceJson(config.ravenBaseUrl, "/v1/downloads/bulk-queue", {
      method: "POST",
      body: {
        type: normalizeString(req.body?.type),
        nsfw: req.body?.nsfw,
        titlePrefix: normalizeString(req.body?.titlePrefix),
        requestedBy: normalizeString(req.body?.requestedBy, "scriptarr-portal")
      }
    }));
  }));

  app.post("/api/internal/portal/downloads/bulk-queue", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await proxyResult(res, serviceJson(config.ravenBaseUrl, "/v1/downloads/bulk-queue", {
      method: "POST",
      body: {
        type: normalizeString(req.body?.type),
        nsfw: req.body?.nsfw,
        titlePrefix: normalizeString(req.body?.titlePrefix),
        requestedBy: normalizeString(req.body?.requestedBy, "scriptarr-portal")
      }
    }));
  }));

  app.get("/api/internal/portal/notifications/follows", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    res.json({
      notifications: await buildFollowNotifications({config, vaultClient, serviceJson})
    });
  }));

  app.post("/api/internal/portal/notifications/follows/:notificationId/ack", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const parsed = parseFollowNotificationId(req.params.notificationId);
    if (!parsed.discordUserId || !parsed.taskId) {
      res.status(400).json({error: "A valid follow notification id is required."});
      return;
    }

    const current = await readAckedFollowNotifications(vaultClient, parsed.discordUserId);
    if (!current.includes(parsed.taskId)) {
      await writeAckedFollowNotifications(vaultClient, parsed.discordUserId, [...current, parsed.taskId]);
    }

    res.json({
      ok: true,
      notificationId: followNotificationId(parsed.discordUserId, parsed.taskId)
    });
  }));

  app.get("/api/internal/portal/notifications/requests", withService(requireService, ["scriptarr-portal"], async (_req, res) => {
    res.json({
      notifications: await buildRequestNotifications({config, vaultClient, serviceJson})
    });
  }));

  app.post("/api/internal/portal/notifications/requests/:requestId/ack", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const parsed = parseRequestNotificationId(req.params.requestId);
    if (!parsed.requestId) {
      res.status(400).json({error: "A valid request id is required."});
      return;
    }

    const currentState = await readRequestNotificationState(vaultClient, parsed.requestId);
    await writeRequestNotificationState(
      vaultClient,
      parsed.requestId,
      markRequestNotificationAcked(currentState, parsed.decisionType)
    );
    res.json({
      ok: true,
      requestId: buildRequestNotificationId(parsed.requestId, parsed.decisionType)
    });
  }));
};

export default registerInternalBrokerRoutes;
