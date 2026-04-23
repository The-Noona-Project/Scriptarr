/**
 * @file Scriptarr Sage module: services/sage/lib/registerInternalBrokerRoutes.mjs.
 */
import {appendDurableEvent, buildServiceActor} from "./adminEvents.mjs";
import {knownPortalDiscordCommands, readPortalDiscordSettings} from "./portalDiscordSettings.mjs";
import {buildIntakeSelection, evaluateSelectionAgainstGuardState} from "./requestSelectionGuards.mjs";
import {buildRequestWorkConflictPayload, isRequestWorkConflictError} from "./requestConflict.mjs";
import {
  attachRequestWaitlistEntry,
  buildActiveRequestDuplicatePayload,
  buildLibraryDuplicatePayload,
  normalizeDownloadOption,
  selectAutoApproveDownload
} from "./requestFlow.mjs";

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

const runServiceAuth = (middleware, req, res) => new Promise((resolve, reject) => {
  let settled = false;
  const settle = (callback, value) => {
    if (settled) {
      return;
    }
    settled = true;
    callback(value);
  };
  const next = (error) => {
    if (error) {
      settle(reject, error);
      return;
    }
    settle(resolve);
  };
  Promise.resolve(middleware(req, res, next))
    .then(() => {
      if (res.headersSent) {
        settle(resolve);
      }
    })
    .catch((error) => settle(reject, error));
});

const withService = (requireService, allowedServices, handler) => async (req, res, next) => {
  try {
    await runServiceAuth(requireService(allowedServices), req, res);
    if (res.headersSent) {
      return;
    }
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

const proxyResult = async (res, promise) => {
  const result = await safeServiceJson(promise);
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

const attachPortalDuplicateWaitlist = async ({vaultClient, request, user}) => {
  const nextWaitlist = attachRequestWaitlistEntry(request, {
    discordUserId: normalizeString(user.discordUserId || user.requestedBy),
    username: normalizeString(user.username, "Reader"),
    avatarUrl: normalizeString(user.avatarUrl),
    source: normalizeString(user.source, "discord")
  });
  if (!nextWaitlist.added) {
    return request;
  }
  return vaultClient.updateRequest(request.id, {
    detailsMerge: {
      waitlist: nextWaitlist.waitlist
    },
    actor: "scriptarr-sage",
    appendStatusEvent: false
  });
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

const normalizeRequestNotificationUserState = (value = {}) => Object.fromEntries(
  Object.entries(normalizeObject(value, {}) || {})
    .map(([key, entry]) => {
      const discordUserId = normalizeScalarString(key);
      const sentAt = normalizeString(
        typeof entry === "string" ? entry : entry?.sentAt,
        typeof entry === "object" ? normalizeString(entry?.at) : ""
      );
      return [discordUserId, sentAt];
    })
    .filter(([discordUserId, sentAt]) => discordUserId && sentAt)
);

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
    ),
    sourceFoundSentAt: normalizeString(
      normalized.sourceFoundSentAt,
      normalizeString(normalized["source-found"]?.sentAt)
    ),
    expiredSentAt: normalizeString(
      normalized.expiredSentAt,
      normalizeString(normalized.expired?.sentAt)
    ),
    blockedByUser: normalizeRequestNotificationUserState(
      normalized.blockedByUser || normalized.blocked?.users
    ),
    readyByUser: normalizeRequestNotificationUserState(
      normalized.readyByUser || normalized.ready?.users
    )
  };
};

const isRequestNotificationAcked = (state, decisionType, discordUserId = "") => {
  const normalized = normalizeRequestNotificationState(state);
  if (["blocked", "ready"].includes(normalizeString(decisionType).toLowerCase())) {
    const keyedState = normalizeString(decisionType).toLowerCase() === "blocked"
      ? normalized.blockedByUser
      : normalized.readyByUser;
    return Boolean(keyedState[normalizeScalarString(discordUserId)]);
  }
  if (decisionType === "source-found") {
    return Boolean(normalized.sourceFoundSentAt);
  }
  return Boolean(normalized[`${decisionType}SentAt`]);
};

const markRequestNotificationAcked = (state, decisionType, sentAt = new Date().toISOString(), discordUserId = "") => {
  const normalized = normalizeRequestNotificationState(state);
  const normalizedDecisionType = normalizeString(decisionType).toLowerCase();
  const normalizedSentAt = normalizeString(sentAt, new Date().toISOString());
  if (normalizedDecisionType === "blocked" && normalizeScalarString(discordUserId)) {
    return {
      ...normalized,
      blockedByUser: {
        ...normalized.blockedByUser,
        [normalizeScalarString(discordUserId)]: normalizedSentAt
      }
    };
  }
  if (normalizedDecisionType === "ready" && normalizeScalarString(discordUserId)) {
    return {
      ...normalized,
      readyByUser: {
        ...normalized.readyByUser,
        [normalizeScalarString(discordUserId)]: normalizedSentAt
      }
    };
  }
  if (normalizedDecisionType === "source-found") {
    return {
      ...normalized,
      sourceFoundSentAt: normalizedSentAt
    };
  }
  return {
    ...normalized,
    [`${normalizedDecisionType}SentAt`]: normalizedSentAt
  };
};

const buildRequestNotificationId = (requestId, decisionType, discordUserId = "") => {
  const normalizedRequestId = normalizeString(requestId);
  const normalizedDecisionType = normalizeString(decisionType, "completed");
  const normalizedDiscordUserId = normalizeScalarString(discordUserId);
  if (!normalizedRequestId) {
    return "";
  }
  if (["blocked", "ready"].includes(normalizedDecisionType) && normalizedDiscordUserId) {
    return `${normalizedRequestId}:${normalizedDecisionType}:${normalizedDiscordUserId}`;
  }
  return normalizedDecisionType === "completed"
    ? normalizedRequestId
    : `${normalizedRequestId}:${normalizedDecisionType}`;
};

const parseRequestNotificationId = (value) => {
  const normalized = normalizeString(value);
  const perUserMatch = normalized.match(/^(.*?):(blocked|ready):([^:]+)$/);
  if (perUserMatch) {
    return {
      requestId: normalizeString(perUserMatch[1]),
      decisionType: normalizeString(perUserMatch[2], "completed"),
      discordUserId: normalizeScalarString(perUserMatch[3])
    };
  }
  const match = normalized.match(/^(.*?):(approved|denied|completed|source-found|expired)$/);
  if (!match) {
    return {
      requestId: normalized,
      decisionType: "completed",
      discordUserId: ""
    };
  }
  return {
    requestId: normalizeString(match[1]),
    decisionType: normalizeString(match[2], "completed"),
    discordUserId: ""
  };
};

const validatePortalBulkQueueProvider = (providerId) => {
  const normalizedProviderId = normalizeString(providerId).toLowerCase();
  if (!normalizedProviderId) {
    return "providerId is required.";
  }
  if (normalizedProviderId !== "weebcentral") {
    return "Portal bulk queue is locked to the WeebCentral provider.";
  }
  return "";
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
    const selectedMetadata = normalizeObject(details.selectedMetadata);
    const selectedDownload = normalizeObject(details.selectedDownload);
    const waitlist = normalizeArray(details.waitlist);
    const linkedTask = tasksByRequestId.get(requestId) || tasksByTaskId.get(normalizeScalarString(details.taskId));
    const matchedTitle = resolveLibraryTitle({
      titleId: linkedTask?.titleId || details?.titleId,
      sourceUrl: linkedTask?.titleUrl || selectedDownload?.titleUrl,
      titleName: linkedTask?.titleName || request?.title || selectedMetadata?.title || selectedDownload?.titleName,
      typeSlug: linkedTask?.libraryTypeSlug || selectedDownload?.libraryTypeSlug || request?.requestType
    });
    const titleName = normalizeString(
      linkedTask?.titleName,
      normalizeString(selectedMetadata?.title, normalizeString(request?.title, "Untitled"))
    );
    const libraryTypeSlug = normalizeTypeSlug(
      linkedTask?.libraryTypeSlug || selectedDownload?.libraryTypeSlug || matchedTitle?.libraryTypeSlug || request?.requestType
    );
    const titleId = normalizeScalarString(
      linkedTask?.titleId,
      normalizeScalarString(details?.titleId, normalizeScalarString(matchedTitle?.id))
    );
    const coverUrl = normalizeString(
      linkedTask?.coverUrl,
      normalizeString(
        details.coverUrl,
        normalizeString(selectedDownload?.coverUrl, normalizeString(selectedMetadata?.coverUrl, matchedTitle?.coverUrl))
      )
    );
    const titleUrl = titleId
      ? `${config.publicBaseUrl}/title/${encodeURIComponent(libraryTypeSlug)}/${encodeURIComponent(titleId)}`
      : "";
    const requestsUrl = `${normalizeString(config.publicBaseUrl).replace(/\/+$/g, "")}/myrequests`;
    const requestStatus = normalizeString(request?.status).toLowerCase();
    const baseNotification = {
      requestId,
      titleName,
      coverUrl,
      moderatorNote: normalizeString(request?.moderatorComment),
      titleUrl,
      requestsUrl,
      selectedMetadata,
      selectedDownload,
      sourceFoundOptions: normalizeArray(details.sourceFoundOptions)
    };

    if (["pending", "unavailable", "queued", "downloading", "failed"].includes(requestStatus)) {
      for (const entry of waitlist) {
        const discordUserId = normalizeScalarString(entry?.discordUserId);
        if (!discordUserId || !usersByDiscordId.has(discordUserId) || isRequestNotificationAcked(notificationState, "blocked", discordUserId)) {
          continue;
        }
        notifications.push({
          ...baseNotification,
          id: buildRequestNotificationId(requestId, "blocked", discordUserId),
          decisionType: "blocked",
          discordUserId,
          username: normalizeString(entry?.username, normalizeString(usersByDiscordId.get(discordUserId)?.username, "Reader")),
          status: requestStatus,
          linkUrl: requestsUrl,
          attachedAt: normalizeString(entry?.attachedAt, request?.updatedAt)
        });
      }
    }

    if (
      (["queued", "downloading"].includes(requestStatus)
        || (requestStatus === "completed" && normalizeString(request?.source).toLowerCase() !== "discord"))
      && !isRequestNotificationAcked(notificationState, "approved")
    ) {
      notifications.push({
        ...baseNotification,
        id: buildRequestNotificationId(requestId, "approved"),
        decisionType: "approved",
        discordUserId: requesterDiscordId,
        username: normalizeString(usersByDiscordId.get(requesterDiscordId)?.username, "Reader"),
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
        discordUserId: requesterDiscordId,
        username: normalizeString(usersByDiscordId.get(requesterDiscordId)?.username, "Reader"),
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
        discordUserId: requesterDiscordId,
        username: normalizeString(usersByDiscordId.get(requesterDiscordId)?.username, "Reader"),
        status: "completed",
        linkUrl: titleUrl,
        completedAt: normalizeString(linkedTask?.updatedAt, request?.updatedAt)
      });
    }

    if (requestStatus === "completed") {
      for (const entry of waitlist) {
        const discordUserId = normalizeScalarString(entry?.discordUserId);
        if (!discordUserId || !usersByDiscordId.has(discordUserId) || isRequestNotificationAcked(notificationState, "ready", discordUserId)) {
          continue;
        }
        notifications.push({
          ...baseNotification,
          id: buildRequestNotificationId(requestId, "ready", discordUserId),
          decisionType: "ready",
          discordUserId,
          username: normalizeString(entry?.username, normalizeString(usersByDiscordId.get(discordUserId)?.username, "Reader")),
          status: "completed",
          linkUrl: titleUrl || requestsUrl,
          completedAt: normalizeString(linkedTask?.updatedAt, request?.updatedAt)
        });
      }
    }

    if (
      requestStatus === "pending"
      && !normalizeString(selectedDownload?.titleUrl)
      && normalizeArray(details.sourceFoundOptions).length
      && normalizeString(details.sourceFoundAt)
      && !isRequestNotificationAcked(notificationState, "source-found")
    ) {
      notifications.push({
        ...baseNotification,
        id: buildRequestNotificationId(requestId, "source-found"),
        decisionType: "source-found",
        discordUserId: requesterDiscordId,
        username: normalizeString(usersByDiscordId.get(requesterDiscordId)?.username, "Reader"),
        status: "pending",
        linkUrl: requestsUrl,
        sourceFoundAt: normalizeString(details.sourceFoundAt)
      });
    }

    if (requestStatus === "expired" && !isRequestNotificationAcked(notificationState, "expired")) {
      notifications.push({
        ...baseNotification,
        id: buildRequestNotificationId(requestId, "expired"),
        decisionType: "expired",
        discordUserId: requesterDiscordId,
        username: normalizeString(usersByDiscordId.get(requesterDiscordId)?.username, "Reader"),
        status: "expired",
        linkUrl: requestsUrl,
        decidedAt: normalizeString(request?.updatedAt)
      });
    }
  }

  return notifications.slice(0, 100);
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
 *   readRequestWorkflowSettings: () => Promise<Record<string, unknown>>,
 *   serviceJson: (baseUrl: string, path: string, options?: {method?: string, body?: unknown, headers?: Record<string, string>}) => Promise<{ok: boolean, status: number, payload: any}>
 * }} options
 */
export const registerInternalBrokerRoutes = (app, {
  config,
  vaultClient,
  requireService,
  readRequestWorkflowSettings,
  serviceJson
}) => {
  const appendServiceEvent = (serviceName, payload) => appendDurableEvent(vaultClient, {
    ...buildServiceActor(serviceName),
    ...payload
  });
  const describeService = (serviceName) => {
    const normalized = normalizeString(serviceName, "scriptarr-service");
    return normalized.replace(/^scriptarr-/, "");
  };
  const appendRequestLifecycleEvent = async (serviceName, beforeRequest, afterRequest) => {
    if (!afterRequest) {
      return;
    }
    const previousStatus = normalizeString(beforeRequest?.status);
    const nextStatus = normalizeString(afterRequest?.status);
    const previousAvailability = normalizeString(beforeRequest?.details?.availability);
    const nextAvailability = normalizeString(afterRequest?.details?.availability);
    const previousDownload = normalizeString(beforeRequest?.details?.selectedDownload?.titleUrl);
    const nextDownload = normalizeString(afterRequest?.details?.selectedDownload?.titleUrl);
    const nextSourceOptions = normalizeArray(afterRequest?.details?.sourceFoundOptions);
    let eventType = "";
    let message = "";
    let severity = "info";

    if (!beforeRequest) {
      eventType = nextStatus === "unavailable" ? "request-unavailable" : "request-created";
      message = `${describeService(serviceName)} created the ${normalizeString(afterRequest.title, "request")} request.`;
    } else if (previousStatus !== nextStatus && nextStatus) {
      eventType = `request-${nextStatus}`;
      message = `${describeService(serviceName)} moved ${normalizeString(afterRequest.title, "that request")} to ${nextStatus}.`;
      if (nextStatus === "failed") {
        severity = "warning";
      }
    } else if (
      (!previousDownload && nextDownload)
      || (previousAvailability !== "available" && nextAvailability === "available")
      || (!normalizeArray(beforeRequest?.details?.sourceFoundOptions).length && nextSourceOptions.length)
    ) {
      eventType = "request-source-found";
      message = `${describeService(serviceName)} found download candidates for ${normalizeString(afterRequest.title, "that request")}.`;
    }

    if (!eventType) {
      return;
    }

    await appendServiceEvent(serviceName, {
      domain: "requests",
      eventType,
      severity,
      targetType: "request",
      targetId: normalizeScalarString(afterRequest.id),
      message,
      metadata: {
        requestId: normalizeScalarString(afterRequest.id),
        title: normalizeString(afterRequest.title),
        status: nextStatus,
        availability: nextAvailability,
        requestedBy: normalizeString(afterRequest.requestedBy),
        providerId: normalizeString(afterRequest.details?.selectedDownload?.providerId),
        titleUrl: normalizeString(afterRequest.details?.selectedDownload?.titleUrl),
        sourceOptionCount: nextSourceOptions.length
      }
    });
  };
  const appendRavenTitleEvent = async (serviceName, beforeTitle, afterTitle) => {
    if (!afterTitle) {
      return;
    }
    const isNewTitle = !beforeTitle?.id;
    const changed =
      isNewTitle
      || normalizeString(beforeTitle?.status) !== normalizeString(afterTitle?.status)
      || normalizeString(beforeTitle?.latestChapter) !== normalizeString(afterTitle?.latestChapter)
      || Number(beforeTitle?.chapterCount || 0) !== Number(afterTitle?.chapterCount || 0)
      || Number(beforeTitle?.chaptersDownloaded || 0) !== Number(afterTitle?.chaptersDownloaded || 0)
      || normalizeString(beforeTitle?.sourceUrl) !== normalizeString(afterTitle?.sourceUrl)
      || normalizeString(beforeTitle?.metadataProvider) !== normalizeString(afterTitle?.metadataProvider);
    if (!changed) {
      return;
    }
    await appendServiceEvent(serviceName, {
      domain: "library",
      eventType: isNewTitle ? "title-cataloged" : "title-updated",
      severity: "info",
      targetType: "title",
      targetId: normalizeString(afterTitle.id),
      message: isNewTitle
        ? `${describeService(serviceName)} cataloged ${normalizeString(afterTitle.title, "a title")} in the library.`
        : `${describeService(serviceName)} refreshed ${normalizeString(afterTitle.title, "a library title")}.`,
      metadata: {
        titleId: normalizeString(afterTitle.id),
        title: normalizeString(afterTitle.title),
        status: normalizeString(afterTitle.status),
        latestChapter: normalizeString(afterTitle.latestChapter),
        chapterCount: Number(afterTitle.chapterCount || 0),
        chaptersDownloaded: Number(afterTitle.chaptersDownloaded || 0),
        sourceUrl: normalizeString(afterTitle.sourceUrl),
        metadataProvider: normalizeString(afterTitle.metadataProvider)
      }
    });
  };
  const appendDownloadTaskEvent = async (serviceName, beforeTask, afterTask) => {
    if (!afterTask) {
      return;
    }
    const previousStatus = normalizeString(beforeTask?.status);
    const nextStatus = normalizeString(afterTask?.status);
    if (beforeTask?.taskId && previousStatus === nextStatus) {
      return;
    }
    await appendServiceEvent(serviceName, {
      domain: "activity",
      eventType: beforeTask?.taskId ? `download-task-${nextStatus || "updated"}` : "download-task-created",
      severity: nextStatus === "failed" ? "warning" : "info",
      targetType: "download-task",
      targetId: normalizeString(afterTask.taskId),
      message: beforeTask?.taskId
        ? `${describeService(serviceName)} moved the ${normalizeString(afterTask.titleName, "download")} task to ${nextStatus || "updated"}.`
        : `${describeService(serviceName)} created a download task for ${normalizeString(afterTask.titleName, "a title")}.`,
      metadata: {
        taskId: normalizeString(afterTask.taskId),
        requestId: normalizeString(afterTask.requestId),
        titleId: normalizeString(afterTask.titleId),
        titleName: normalizeString(afterTask.titleName),
        providerId: normalizeString(afterTask.providerId),
        status: nextStatus,
        percent: Number(afterTask.percent || 0)
      }
    });
  };
  const appendJobEvent = async (serviceName, beforeJob, afterJob) => {
    if (!afterJob) {
      return;
    }
    const previousStatus = normalizeString(beforeJob?.status);
    const nextStatus = normalizeString(afterJob?.status);
    if (beforeJob?.jobId && previousStatus === nextStatus) {
      return;
    }
    await appendServiceEvent(serviceName, {
      domain: "system",
      eventType: beforeJob?.jobId ? `job-${nextStatus || "updated"}` : "job-created",
      severity: nextStatus === "failed" ? "warning" : "info",
      targetType: "job",
      targetId: normalizeString(afterJob.jobId),
      message: beforeJob?.jobId
        ? `${describeService(serviceName)} moved the ${normalizeString(afterJob.label, afterJob.kind || "job")} job to ${nextStatus || "updated"}.`
        : `${describeService(serviceName)} created the ${normalizeString(afterJob.label, afterJob.kind || "job")} job.`,
      metadata: {
        jobId: normalizeString(afterJob.jobId),
        kind: normalizeString(afterJob.kind),
        ownerService: normalizeString(afterJob.ownerService),
        status: nextStatus,
        requestedBy: normalizeString(afterJob.requestedBy)
      }
    });
  };
  const appendJobTaskEvent = async (serviceName, beforeTask, afterTask) => {
    if (!afterTask) {
      return;
    }
    const previousStatus = normalizeString(beforeTask?.status);
    const nextStatus = normalizeString(afterTask?.status);
    if (beforeTask?.taskId && previousStatus === nextStatus) {
      return;
    }
    await appendServiceEvent(serviceName, {
      domain: "system",
      eventType: beforeTask?.taskId ? `job-task-${nextStatus || "updated"}` : "job-task-created",
      severity: nextStatus === "failed" ? "warning" : "info",
      targetType: "job-task",
      targetId: normalizeString(afterTask.taskId),
      message: beforeTask?.taskId
        ? `${describeService(serviceName)} moved the ${normalizeString(afterTask.label, afterTask.taskKey || "job task")} task to ${nextStatus || "updated"}.`
        : `${describeService(serviceName)} created the ${normalizeString(afterTask.label, afterTask.taskKey || "job task")} task.`,
      metadata: {
        jobId: normalizeString(afterTask.jobId),
        taskId: normalizeString(afterTask.taskId),
        taskKey: normalizeString(afterTask.taskKey),
        status: nextStatus,
        percent: Number(afterTask.percent || 0)
      }
    });
  };

  const mergeDisplayStrings = (...values) => {
    const seen = new Set();
    const merged = [];
    for (const value of values.flatMap((entry) => normalizeArray(entry).length ? normalizeArray(entry) : [entry])) {
      const normalized = normalizeString(value);
      if (!normalized) {
        continue;
      }
      const dedupeKey = normalized.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      merged.push(normalized);
    }
    return merged;
  };

  const fetchPortalMetadataSearchResults = async (query) => {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
      return {query: "", results: []};
    }

    const response = await serviceJson(
      config.ravenBaseUrl,
      `/v1/metadata/search?name=${encodeURIComponent(normalizedQuery)}`
    );
    if (!response.ok) {
      return response;
    }

    const hydratedResults = await Promise.all(normalizeArray(response.payload).map(async (entry) => {
      const provider = normalizeString(entry.provider);
      const providerSeriesId = normalizeString(entry.providerSeriesId);
      let details = {};
      if (provider && providerSeriesId) {
        const detailResult = await safeServiceJson(serviceJson(
          config.ravenBaseUrl,
          `/v1/metadata/series-details?provider=${encodeURIComponent(provider)}&providerSeriesId=${encodeURIComponent(providerSeriesId)}`
        ));
        if (detailResult?.ok !== false) {
          details = normalizeObject(detailResult?.payload, {}) || {};
        }
      }

      const type = normalizeString(details.type, normalizeString(entry.type, "manga"));
      return {
        provider,
        providerName: normalizeString(entry.providerName, provider),
        providerSeriesId,
        title: normalizeString(details.title, normalizeString(entry.title, "Untitled")),
        url: normalizeString(details.url, normalizeString(entry.url)),
        summary: normalizeString(details.summary, normalizeString(entry.summary)),
        coverUrl: normalizeString(details.coverUrl, normalizeString(entry.coverUrl)),
        type,
        typeSlug: normalizeTypeSlug(details.typeSlug || type),
        aliases: mergeDisplayStrings(entry.aliases, details.aliases),
        tags: mergeDisplayStrings(entry.tags, details.tags),
        releaseLabel: normalizeString(details.releaseLabel, normalizeString(entry.releaseLabel)),
        status: normalizeString(details.status, normalizeString(entry.status))
      };
    }));

    return {
      ok: true,
      status: 200,
      payload: {
        query: normalizedQuery,
        results: hydratedResults
      }
    };
  };

  const fetchPortalDownloadOptions = async ({query, selectedMetadata}) => {
    const response = await serviceJson(config.ravenBaseUrl, "/v1/intake/download-options", {
      method: "POST",
      body: {
        query: normalizeString(query),
        selectedMetadata
      }
    });
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      status: 200,
      payload: {
        query: normalizeString(response.payload?.query, normalizeString(query)),
        availability: normalizeString(response.payload?.availability, "unavailable"),
        selectedMetadata: normalizeObject(response.payload?.selectedMetadata, selectedMetadata) || selectedMetadata,
        results: normalizeArray(response.payload?.results).map((entry) => normalizeDownloadOption(entry))
      }
    };
  };

  const queuePortalRequest = async ({requestId, request, actor, message}) => {
    const selectedDownload = normalizeObject(request.details?.selectedDownload);
    if (!selectedDownload?.titleUrl) {
      return {
        ok: false,
        status: 409,
        payload: {error: "This request does not have a concrete download target yet."}
      };
    }

    const queued = await serviceJson(config.ravenBaseUrl, "/v1/downloads/queue", {
      method: "POST",
      body: {
        titleName: normalizeString(selectedDownload.titleName, request.title),
        titleUrl: normalizeString(selectedDownload.titleUrl),
        requestType: normalizeString(selectedDownload.requestType, request.requestType),
        providerId: normalizeString(selectedDownload.providerId),
        requestId: String(requestId),
        requestedBy: request.requestedBy,
        selectedMetadata: normalizeObject(request.details?.selectedMetadata, {}),
        selectedDownload
      }
    });
    if (!queued.ok) {
      return queued;
    }

    const updated = await vaultClient.updateRequest(requestId, {
      status: "queued",
      eventType: "approved",
      eventMessage: normalizeString(message, "Scriptarr auto-approved and queued this request."),
      actor: normalizeString(actor, "scriptarr-sage"),
      appendStatusEvent: false,
      detailsMerge: {
        availability: "available",
        selectedMetadata: normalizeObject(request.details?.selectedMetadata, {}),
        selectedDownload,
        sourceFoundAt: "",
        sourceFoundOptions: [],
        jobId: normalizeString(queued.payload?.jobId),
        taskId: normalizeString(queued.payload?.taskId)
      }
    });

    return {
      ok: true,
      status: 201,
      payload: updated
    };
  };

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
      const request = await vaultClient.createRequest(req.body || {});
      await appendDurableEvent(vaultClient, {
        actorType: "user",
        actorId: normalizeString(req.body?.requestedBy),
        actorLabel: normalizeString(req.body?.username, normalizeString(req.body?.requestedBy, "Discord user")),
        domain: "requests",
        eventType: normalizeString(request?.status) === "unavailable" ? "request-unavailable" : "request-created",
        severity: "info",
        targetType: "request",
        targetId: normalizeScalarString(request?.id),
        message: `${normalizeString(req.body?.username, "Discord user")} created the ${normalizeString(request?.title, "request")} request from Discord.`,
        metadata: {
          requestId: normalizeScalarString(request?.id),
          requestedBy: normalizeString(req.body?.requestedBy),
          source: normalizeString(req.body?.source, "discord"),
          status: normalizeString(request?.status),
          availability: normalizeString(request?.details?.availability)
        }
      });
      res.status(201).json(request);
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
    const previous = await vaultClient.getRequest(req.params.id);
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
    await appendRequestLifecycleEvent(req.serviceName, previous, request);
    res.json(request);
  }));

  app.post("/api/internal/vault/requests/:id/review", withService(requireService, ["scriptarr-warden"], async (req, res) => {
    const previous = await vaultClient.getRequest(req.params.id);
    const reviewed = await vaultClient.reviewRequest(req.params.id, req.body || {});
    if (!reviewed) {
      res.status(404).json({error: "Request not found."});
      return;
    }
    await appendRequestLifecycleEvent(req.serviceName, previous, reviewed);
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
    const previous = await vaultClient.getRavenTitle(req.params.titleId);
    const title = await vaultClient.upsertRavenTitle(req.params.titleId, {
      ...req.body,
      id: req.params.titleId
    });
    await appendRavenTitleEvent(req.serviceName, previous, title);
    res.json(title);
  }));

  app.put("/api/internal/vault/raven/titles/:titleId/chapters", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    res.json(await vaultClient.replaceRavenChapters(req.params.titleId, normalizeArray(req.body?.chapters)));
  }));

  app.get("/api/internal/vault/raven/download-tasks", withService(requireService, ["scriptarr-raven"], async (_req, res) => {
    res.json(await vaultClient.listRavenDownloadTasks());
  }));

  app.put("/api/internal/vault/raven/download-tasks/:taskId", withService(requireService, ["scriptarr-raven"], async (req, res) => {
    const previous = normalizeArray(await vaultClient.listRavenDownloadTasks())
      .find((task) => normalizeString(task.taskId) === normalizeString(req.params.taskId)) || null;
    const task = await vaultClient.upsertRavenDownloadTask(req.params.taskId, {
      ...req.body,
      taskId: req.params.taskId
    });
    await appendDownloadTaskEvent(req.serviceName, previous, task);
    res.json(task);
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
    const previous = await vaultClient.getJob(req.params.jobId);
    const job = await vaultClient.upsertJob(req.params.jobId, {
      ...req.body,
      jobId: req.params.jobId
    });
    await appendJobEvent(req.serviceName, previous, job);
    res.json(job);
  }));

  app.get("/api/internal/jobs/:jobId/tasks", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    res.json(await vaultClient.listJobTasks(req.params.jobId, {
      status: normalizeString(req.query.status)
    }));
  }));

  app.put("/api/internal/jobs/:jobId/tasks/:taskId", withService(requireService, ["scriptarr-raven", "scriptarr-warden"], async (req, res) => {
    const previous = normalizeArray(await vaultClient.listJobTasks({
      jobId: req.params.jobId
    })).find((task) => normalizeString(task.taskId) === normalizeString(req.params.taskId)) || null;
    const task = await vaultClient.upsertJobTask(req.params.jobId, req.params.taskId, {
      ...req.body,
      taskId: req.params.taskId
    });
    await appendJobTaskEvent(req.serviceName, previous, task);
    res.json(task);
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

  app.get("/api/internal/portal/requests/metadata-search", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const response = await fetchPortalMetadataSearchResults(req.query.query);
    if (!response.ok) {
      res.status(response.status).json(response.payload);
      return;
    }
    res.json(response.payload);
  }));

  app.post("/api/internal/portal/requests/download-options", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }
    const response = await fetchPortalDownloadOptions({
      query: req.body?.query,
      selectedMetadata
    });
    res.status(response.status).json(response.payload);
  }));

  const handlePortalRequestCreate = async (req, res, requestedBy) => {
    if (!requestedBy) {
      res.status(400).json({error: "requestedBy is required."});
      return;
    }

    const selectedMetadata = normalizeObject(req.body?.selectedMetadata);
    if (!selectedMetadata?.provider || !selectedMetadata?.providerSeriesId) {
      res.status(400).json({error: "selectedMetadata with provider and providerSeriesId is required."});
      return;
    }

    const downloadResolution = await fetchPortalDownloadOptions({
      query: req.body?.query,
      selectedMetadata
    });
    if (!downloadResolution.ok) {
      res.status(downloadResolution.status).json(downloadResolution.payload);
      return;
    }

    const effectiveMetadata = normalizeObject(downloadResolution.payload?.selectedMetadata, selectedMetadata) || selectedMetadata;
    const requestWorkflow = await readRequestWorkflowSettings();
    const autoSelectedDownload = requestWorkflow.autoApproveAndDownload
      ? selectAutoApproveDownload(downloadResolution.payload?.results)
      : null;
    const hasConcreteOptions = normalizeArray(downloadResolution.payload?.results).length > 0;
    const nextStatus = autoSelectedDownload?.titleUrl
      ? "pending"
      : (hasConcreteOptions ? "pending" : "unavailable");
    const nextAvailability = hasConcreteOptions ? "available" : "unavailable";

    const guard = evaluateSelectionAgainstGuardState(buildIntakeSelection({
      query: normalizeString(req.body?.query),
      title: normalizeString(req.body?.title, effectiveMetadata.title),
      requestType: normalizeString(req.body?.requestType || autoSelectedDownload?.requestType || effectiveMetadata?.type),
      selectedMetadata: effectiveMetadata,
      selectedDownload: autoSelectedDownload
    }), await loadPortalRequestGuardState({config, vaultClient, serviceJson}));
    if (guard.alreadyInLibrary) {
      res.status(409).json(buildLibraryDuplicatePayload({
        matchingTitle: guard.matchingTitle,
        publicBaseUrl: config.publicBaseUrl
      }));
      return;
    }
    if (guard.alreadyQueuedOrRequested) {
      const duplicateRequest = guard.matchingRequest
        || (normalizeString(guard.matchingTask?.requestId)
          ? await vaultClient.getRequest(guard.matchingTask.requestId)
          : null);
      if (duplicateRequest) {
        await attachPortalDuplicateWaitlist({
          vaultClient,
          request: duplicateRequest,
          user: {
            discordUserId: requestedBy,
            username: normalizeString(req.body?.username, "Reader"),
            avatarUrl: normalizeString(req.body?.avatarUrl),
            source: normalizeString(req.body?.source, "discord")
          }
        });
        res.status(409).json(buildActiveRequestDuplicatePayload({
          matchingRequest: duplicateRequest,
          publicBaseUrl: config.publicBaseUrl
        }));
        return;
      }
      res.status(409).json({error: "That title is already queued or has an active request."});
      return;
    }

    try {
      const request = await vaultClient.createRequest({
        source: normalizeString(req.body?.source, "discord"),
        title: normalizeString(effectiveMetadata?.title, req.body?.title || "Untitled request"),
        requestType: normalizeString(req.body?.requestType || autoSelectedDownload?.requestType || effectiveMetadata?.type || "manga", "manga"),
        notes: normalizeString(req.body?.notes),
        requestedBy,
        status: nextStatus,
        details: {
          query: normalizeString(req.body?.query),
          selectedMetadata: effectiveMetadata,
          selectedDownload: autoSelectedDownload,
          availability: nextAvailability,
          sourceFoundOptions: []
        }
      });

      if (autoSelectedDownload?.titleUrl) {
        const queued = await queuePortalRequest({
          requestId: request.id,
          request: await vaultClient.getRequest(request.id),
          actor: "scriptarr-sage",
          message: "Scriptarr auto-approved and queued this Discord request because the source match was high confidence."
        });
        if (queued.ok) {
          res.status(201).json(queued.payload);
          return;
        }
      }

      res.status(201).json(await vaultClient.getRequest(request.id));
    } catch (error) {
      if (isRequestWorkConflictError(error)) {
        const duplicateRequest = normalizeString(error.requestId)
          ? await vaultClient.getRequest(error.requestId)
          : null;
        if (duplicateRequest) {
          await attachPortalDuplicateWaitlist({
            vaultClient,
            request: duplicateRequest,
            user: {
              discordUserId: requestedBy,
              username: normalizeString(req.body?.username, "Reader"),
              avatarUrl: normalizeString(req.body?.avatarUrl),
              source: normalizeString(req.body?.source, "discord")
            }
          });
          res.status(409).json(buildActiveRequestDuplicatePayload({
            matchingRequest: duplicateRequest,
            publicBaseUrl: config.publicBaseUrl
          }));
          return;
        }
        res.status(409).json(buildRequestWorkConflictPayload(error));
        return;
      }
      throw error;
    }
  };

  app.post("/api/internal/portal/requests", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await handlePortalRequestCreate(req, res, normalizeString(req.body?.requestedBy));
  }));

  app.post("/api/internal/portal/requests/from-discord", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    await handlePortalRequestCreate(req, res, normalizeString(req.body?.requestedBy || req.body?.discordUserId));
  }));

  app.post("/api/internal/portal/requests/:requestId/select-download", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    res.status(410).json({error: "Requesters no longer choose download providers. Admins now approve a source from /admin/requests."});
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
    const providerError = validatePortalBulkQueueProvider(req.body?.providerId);
    if (providerError) {
      res.status(400).json({error: providerError});
      return;
    }
    await proxyResult(res, serviceJson(config.ravenBaseUrl, "/v1/downloads/bulk-queue", {
      method: "POST",
      body: {
        providerId: normalizeString(req.body?.providerId),
        type: normalizeString(req.body?.type),
        nsfw: req.body?.nsfw,
        titlePrefix: normalizeString(req.body?.titlePrefix),
        requestedBy: normalizeString(req.body?.requestedBy, "scriptarr-portal")
      }
    }));
  }));

  app.post("/api/internal/portal/downloads/bulk-queue", withService(requireService, ["scriptarr-portal"], async (req, res) => {
    const providerError = validatePortalBulkQueueProvider(req.body?.providerId);
    if (providerError) {
      res.status(400).json({error: providerError});
      return;
    }
    await proxyResult(res, serviceJson(config.ravenBaseUrl, "/v1/downloads/bulk-queue", {
      method: "POST",
      body: {
        providerId: normalizeString(req.body?.providerId),
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
      markRequestNotificationAcked(currentState, parsed.decisionType, new Date().toISOString(), parsed.discordUserId)
    );
    res.json({
      ok: true,
      requestId: buildRequestNotificationId(parsed.requestId, parsed.decisionType)
    });
  }));
};

export default registerInternalBrokerRoutes;
