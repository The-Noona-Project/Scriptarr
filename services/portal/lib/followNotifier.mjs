import {FOLLOW_NOTIFICATION_POLL_MS} from "./discord/constants.mjs";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const truncate = (value, max = 1900) => {
  const normalized = normalizeString(value);
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 3))}...` : normalized;
};
const normalizeObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const toCount = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const DOWNLOADALL_APPROVE_REACTION = "✅";
const DOWNLOADALL_DENY_REACTION = "❌";

const addDownloadAllDecisionReactions = async (message, logger) => {
  if (!message || typeof message.react !== "function") {
    return;
  }
  try {
    await message.react(DOWNLOADALL_APPROVE_REACTION);
    await message.react(DOWNLOADALL_DENY_REACTION);
  } catch (error) {
    logger?.warn?.("Portal could not add downloadall decision reactions.", {error});
  }
};

const resolveRequestEventType = (notification = {}) => {
  const normalized = normalizeString(
    notification.decisionType
    || notification.eventType
    || notification.notificationType
    || notification.type
    || notification.status
  ).toLowerCase();
  if (["approved", "queued"].includes(normalized)) {
    return "approved";
  }
  if (["denied", "rejected"].includes(normalized)) {
    return "denied";
  }
  if (["blocked"].includes(normalized)) {
    return "blocked";
  }
  if (["ready"].includes(normalized)) {
    return "ready";
  }
  if (["source-found", "source_found"].includes(normalized)) {
    return "source-found";
  }
  if (["expired"].includes(normalized)) {
    return "expired";
  }
  return "completed";
};

const resolveRequestNotificationId = (notification = {}) => {
  const explicitId = normalizeString(notification.id);
  if (explicitId) {
    return explicitId;
  }
  const requestId = normalizeString(notification.requestId);
  const decisionType = resolveRequestEventType(notification);
  return requestId
    ? `${requestId}:${decisionType}`
    : "";
};

const resolveNotificationLink = (notification, kind, publicBaseUrl) => {
  const explicitLink = normalizeString(
    notification?.linkUrl
    || notification?.moonUrl
    || notification?.requestUrl
    || notification?.requestsUrl
    || notification?.titleUrl
  );
  if (explicitLink) {
    return explicitLink;
  }

  const baseUrl = normalizeString(publicBaseUrl).replace(/\/+$/g, "");
  if (!baseUrl || kind !== "request") {
    return "";
  }

  const eventType = resolveRequestEventType(notification);
  return ["completed", "ready"].includes(eventType)
    ? ""
    : `${baseUrl}/myrequests`;
};

const titleCase = (value) => {
  const normalized = normalizeString(value, "updated").replace(/[_-]+/g, " ").toLowerCase();
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const resolveDownloadAllColor = (status) => {
  switch (status) {
    case "completed":
      return 0x16a34a;
    case "failed":
      return 0xdc2626;
    case "cancelled":
    case "canceled":
      return 0x64748b;
    case "paused":
      return 0xf59e0b;
    default:
      return 0x60a5fa;
  }
};

const compactRunId = (runId) => {
  const normalized = normalizeString(runId);
  return normalized.length > 26 ? `${normalized.slice(0, 18)}...${normalized.slice(-6)}` : normalized;
};

export const buildDownloadAllDirectMessagePayload = (notification = {}, publicBaseUrl = "", brandName = "Scriptarr") => {
  const linkUrl = resolveNotificationLink(notification, "downloadall", publicBaseUrl);
  const runId = normalizeString(notification.runId || notification.jobId);
  const status = normalizeString(notification.status || notification.decisionType, "updated").toLowerCase();
  const summary = normalizeObject(notification.summary);
  const counts = normalizeObject(notification.counts);
  const filters = normalizeObject(notification.filters);
  const currentBatch = normalizeObject(notification.currentBatch);
  const batchesPerApproval = toCount(
    notification.batchesPerApproval ?? summary.batchesPerApproval ?? filters.batchesPerApproval,
    1
  );
  const completedBatches = toCount(summary.completedBatches ?? counts.completedBatches ?? notification.completedBatches, 0);
  const remainingBatches = toCount(summary.remainingBatches ?? counts.remainingBatches ?? notification.remainingBatches, 0);
  const completedTitles = toCount(summary.completedTitles ?? counts.completedTitleTaskCount ?? notification.completedTitleTaskCount, 0);
  const queued = toCount(summary.queued ?? counts.queuedCount ?? notification.queuedCount, 0);
  const appended = toCount(summary.appended ?? counts.appendedCount ?? notification.appendedCount, 0);
  const skippedCompleted = toCount(summary.skippedCompleted ?? counts.skippedCompletedCount ?? notification.skippedCompletedCount, 0);
  const skippedCurrent = toCount(summary.skippedCurrent ?? counts.skippedCurrentCount ?? notification.skippedCurrentCount, 0);
  const failedTitles = toCount(summary.failedTitles ?? counts.failedTitleTaskCount ?? notification.failedTitleTaskCount, 0);
  const staleTitles = toCount(summary.staleTitles ?? counts.staleTitleTaskCount ?? notification.staleTitleTaskCount, 0);
  const displayRunId = compactRunId(runId);
  const actionLine = status === "paused"
    ? `React ${DOWNLOADALL_APPROVE_REACTION} to run the next ${batchesPerApproval} batch(es), or ${DOWNLOADALL_DENY_REACTION} to cancel.`
    : `Run ${displayRunId || "unknown"} is ${status}.`;
  const fallbackCommand = runId ? `\`/downloadall continue runid:${runId}\`` : "`/downloadall continue runid:<id>`";
  const currentBatchLabel = normalizeString(
    summary.currentBatchLabel
    || currentBatch.label
    || [
      normalizeString(currentBatch.titlePrefix || currentBatch.titlegroup),
      normalizeString(currentBatch.type)
    ].filter(Boolean).join(" ")
  );
  const queueLink = linkUrl ? `[Open queue](${linkUrl})` : "";
  const needsAttention = [
    failedTitles ? `Failed title tasks: **${failedTitles}**` : "",
    staleTitles ? `Stale title tasks: **${staleTitles}**` : ""
  ].filter(Boolean).join("\n") || "None reported";

  return {
    content: [
      status === "paused"
        ? `Downloadall paused after ${completedBatches} batch(es).`
        : `Downloadall ${status}: ${completedTitles} title task(s) completed.`,
      actionLine
    ].filter(Boolean).join("\n"),
    embeds: [{
      title: `${brandName} downloadall ${titleCase(status)}`,
      description: runId ? `Run \`${displayRunId}\`` : "Durable downloadall run",
      url: linkUrl || undefined,
      color: resolveDownloadAllColor(status),
      fields: [
        {
          name: "Progress",
          value: [
            `Batches: **${completedBatches}** done / **${remainingBatches}** remaining`,
            `Title tasks completed: **${completedTitles}**`
          ].join("\n"),
          inline: true
        },
        {
          name: "Queued work",
          value: [
            `New titles queued: **${queued}**`,
            `Append updates: **${appended}**`
          ].join("\n"),
          inline: true
        },
        {
          name: "Skipped",
          value: [
            `Completed titles: **${skippedCompleted}**`,
            `Already current: **${skippedCurrent}**`
          ].join("\n"),
          inline: true
        },
        {
          name: "Needs attention",
          value: needsAttention,
          inline: true
        },
        currentBatchLabel ? {
          name: status === "paused" ? "Last completed batch" : "Current batch",
          value: currentBatchLabel,
          inline: true
        } : null,
        status === "paused" ? {
          name: "Next action",
          value: [
            `${DOWNLOADALL_APPROVE_REACTION} Continue next **${batchesPerApproval}** batch(es)`,
            `${DOWNLOADALL_DENY_REACTION} Cancel remaining run`,
            `Fallback: ${fallbackCommand}`
          ].join("\n"),
          inline: false
        } : null,
        queueLink ? {
          name: brandName,
          value: queueLink,
          inline: false
        } : null
      ].filter(Boolean),
      footer: status === "paused"
        ? {text: "React once. Duplicate or late decisions are ignored."}
        : undefined
    }]
  };
};

const buildDirectMessagePayload = (notification, kind, publicBaseUrl, requestCommand, brandName = "Scriptarr") => {
  if (kind === "downloadall") {
    return buildDownloadAllDirectMessagePayload(notification, publicBaseUrl, brandName);
  }

  if (kind === "system") {
    const titleName = normalizeString(notification?.titleName, `${brandName} system task`);
    const message = normalizeString(notification?.message, `${titleName} changed state.`);
    const linkUrl = resolveNotificationLink(notification, kind, publicBaseUrl);
    const error = normalizeString(notification?.error);
    const image = normalizeString(notification?.image);
    const errorLine = error ? `\nError: ${error}` : "";
    const imageLine = image ? `\nImage: ${image}` : "";
    const linkLine = linkUrl ? `\nOpen in ${brandName}: ${linkUrl}` : "";

    return {
      content: `${message}${errorLine}${imageLine}${linkLine}`,
      embeds: [{
        title: titleName,
        description: message,
        url: linkUrl || undefined,
        fields: [
          image ? {name: "Image", value: image} : null,
          error ? {name: "Error", value: error} : null
        ].filter(Boolean)
      }]
    };
  }

  const titleName = normalizeString(notification?.titleName || notification?.title || `your ${brandName} title`);
  const titleUrl = resolveNotificationLink(notification, kind, publicBaseUrl);
  const coverUrl = normalizeString(notification?.coverUrl);
  const moderatorNote = normalizeString(notification?.moderatorNote || notification?.note || notification?.comment);
  const requestEventType = resolveRequestEventType(notification);
  const titleLine = kind === "request"
    ? (() => {
      switch (requestEventType) {
        case "approved":
          return `Your ${brandName} request for **${titleName}** was approved.`;
        case "denied":
          return `Your ${brandName} request for **${titleName}** was denied.`;
        case "blocked":
          return `${brandName} is already tracking **${titleName}**.`;
        case "ready":
          return `The ${brandName} title you asked to be notified about, **${titleName}**, is ready.`;
        case "source-found":
          return `${brandName} found a source for your unavailable request **${titleName}** and moved it back into staff review.`;
        case "expired":
          return `Your ${brandName} request for **${titleName}** expired after 90 days without a stable source.`;
        default:
          return `Your ${brandName} request for **${titleName}** is ready.`;
      }
    })()
    : `New ${brandName} download completed for **${titleName}**.`;
  const noteLine = moderatorNote ? `\nModerator note: ${moderatorNote}` : "";
  const linkLine = titleUrl ? `\nOpen in ${brandName}: ${titleUrl}` : "";
  const helperLine = kind === "request" && requestEventType === "blocked"
    ? "\nYou were added to the waitlist and will get another Discord DM when the title is ready."
    : "";
  const payload = {
    content: `${titleLine}${helperLine}${noteLine}${linkLine}`
  };

  if (coverUrl || titleUrl) {
    const embedDescription = kind === "request"
      ? (() => {
        switch (requestEventType) {
          case "approved":
            return "Requested title approved.";
          case "denied":
            return "Requested title denied.";
          case "blocked":
            return "Requested title already being tracked.";
          case "ready":
            return "Requested title is now ready.";
          case "source-found":
            return "A new download source was found and the request is back in staff review.";
          case "expired":
            return "Unavailable request expired.";
          default:
            return "Requested title download completed.";
        }
      })()
      : "Followed title download completed.";
    payload.embeds = [{
      title: titleName,
      description: embedDescription,
      url: titleUrl || undefined,
      image: coverUrl ? {url: coverUrl} : undefined,
      fields: moderatorNote
        ? [{
          name: "Moderator note",
          value: moderatorNote
        }]
        : undefined
    }];
  }

  return payload;
};

export const buildReleaseChannelPayload = (notification = {}, publicBaseUrl = "", brandName = "Scriptarr") => {
  const titleName = normalizeString(notification.titleName || notification.title, `${brandName} title`);
  const chapterLabel = normalizeString(notification.chapterLabel || notification.latestChapter, "Latest chapter");
  const linkUrl = normalizeString(notification.linkUrl || notification.readerUrl || notification.titleUrl)
    || (normalizeString(publicBaseUrl) ? normalizeString(publicBaseUrl).replace(/\/+$/g, "") : "");
  const coverUrl = normalizeString(notification.coverUrl);
  const linkLine = linkUrl ? `\nRead it here: ${linkUrl}` : "";
  const description = `**${titleName}** downloaded ${chapterLabel}.${linkLine}`;
  return {
    content: `New ${brandName} release: ${titleName} - ${chapterLabel}${linkLine}`,
    embeds: [{
      title: titleName,
      description,
      url: linkUrl || undefined,
      image: coverUrl ? {url: coverUrl} : undefined,
      fields: [
        {name: "Chapter", value: chapterLabel}
      ]
    }]
  };
};

export const buildUpdateChannelPayload = (notification = {}, publicBaseUrl = "", brandName = "Scriptarr") => {
  const repository = normalizeString(notification.repository, "The-Noona-Project/Scriptarr");
  const branch = normalizeString(notification.branch, "main");
  const summary = normalizeString(notification.summary, `Noona found a ${brandName} update.`);
  const compareUrl = normalizeString(notification.compareUrl);
  const adminUrl = normalizeString(publicBaseUrl) ? `${normalizeString(publicBaseUrl).replace(/\/+$/g, "")}/admin/system/updates` : "";
  const commitCount = toCount(notification.commitCount, normalizeArray(notification.commits).length);
  const latestSha = normalizeString(notification.latestSha);
  const commitLines = normalizeArray(notification.commits)
    .slice(0, 5)
    .map((commit) => {
      const sha = normalizeString(commit.sha);
      const title = normalizeString(commit.title, "Untitled commit");
      const url = normalizeString(commit.url);
      return url ? `[${sha}](${url}) ${title}` : `${sha} ${title}`.trim();
    });
  const linkLine = compareUrl ? `\nCompare: ${compareUrl}` : adminUrl ? `\nOpen updates: ${adminUrl}` : "";
  return {
    content: truncate(`${summary}${linkLine}`, 1900),
    embeds: [{
      title: `${brandName} update from Noona`,
      description: summary,
      url: compareUrl || adminUrl || undefined,
      color: 0x8b5cf6,
      fields: [
        {name: "Repository", value: `${repository} (${branch})`, inline: true},
        {name: "Commits", value: String(commitCount), inline: true},
        latestSha ? {name: "Latest", value: latestSha, inline: true} : null,
        commitLines.length ? {
          name: "Included commits",
          value: commitLines.join("\n").slice(0, 1000),
          inline: false
        } : null,
        adminUrl ? {
          name: brandName,
          value: `[Open updates](${adminUrl})`,
          inline: false
        } : null
      ].filter(Boolean),
      footer: {text: "Mention Noona to ask what changed or how to use it."}
    }]
  };
};

const deliverNotifications = async ({
  list,
  acknowledge,
  kind,
  discord,
  sage,
  logger,
  publicBaseUrl,
  requestCommand,
  getBrandName = () => "Scriptarr"
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok) {
    return;
  }

  const deliveredIds = new Set();

  for (const notification of normalizeArray(response.payload?.notifications)) {
    const notificationId = kind === "request"
      ? resolveRequestNotificationId(notification)
      : normalizeString(notification?.id, normalizeString(notification?.requestId));
    if (notificationId && deliveredIds.has(notificationId)) {
      continue;
    }
    try {
      const payload = await appendAiMessageContext({
        sage,
        kind,
        notification,
        payload: buildDirectMessagePayload(notification, kind, publicBaseUrl, requestCommand, getBrandName()),
        logger
      });
      const sentMessage = await discord.sendDirectMessage(
        notification.discordUserId,
        payload
      );
      if (kind === "downloadall" && normalizeString(notification.status) === "paused") {
        await addDownloadAllDecisionReactions(sentMessage, logger);
        if (notificationId && typeof sage?.recordDownloadAllDecisionPrompt === "function") {
          await sage.recordDownloadAllDecisionPrompt(notificationId, {
            messageId: normalizeString(sentMessage?.id),
            channelId: normalizeString(sentMessage?.channelId || sentMessage?.channel?.id),
            ownerDiscordUserId: normalizeString(notification.discordUserId),
            runId: normalizeString(notification.jobId || notification.runId),
            batchId: normalizeString(notification.batchId),
            batchesPerApproval: toCount(notification.batchesPerApproval, 1),
            status: normalizeString(notification.status)
          });
        }
      }
      if (notificationId) {
        deliveredIds.add(notificationId);
        await acknowledge(notificationId);
      }
    } catch (error) {
      logger?.error?.(`Portal ${kind} notifier delivery failed.`, {notificationId, error});
    }
  }
};

const deliverReleaseChannelNotifications = async ({
  list,
  acknowledge,
  discord,
  sage,
  logger,
  publicBaseUrl,
  getBrandName = () => "Scriptarr"
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok) {
    return;
  }

  const deliveredIds = new Set();
  for (const notification of normalizeArray(response.payload?.notifications)) {
    const notificationId = normalizeString(notification?.id);
    const channelId = normalizeString(notification?.channelId);
    if (!notificationId || !channelId || deliveredIds.has(notificationId)) {
      continue;
    }
    try {
      const payload = await appendAiMessageContext({
        sage,
        kind: "release",
        notification,
        payload: buildReleaseChannelPayload(notification, publicBaseUrl, getBrandName()),
        logger
      });
      await discord.sendChannelMessage(
        channelId,
        payload
      );
      deliveredIds.add(notificationId);
      await acknowledge(notificationId);
    } catch (error) {
      logger?.error?.("Portal release channel notification delivery failed.", {notificationId, error});
    }
  }
};

const deliverUpdateChannelNotifications = async ({
  list,
  acknowledge,
  discord,
  logger,
  publicBaseUrl,
  getBrandName = () => "Scriptarr"
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok) {
    return;
  }

  const deliveredIds = new Set();
  for (const notification of normalizeArray(response.payload?.notifications)) {
    const notificationId = normalizeString(notification?.id);
    const channelId = normalizeString(notification?.channelId);
    if (!notificationId || !channelId || deliveredIds.has(notificationId)) {
      continue;
    }
    try {
      await discord.sendChannelMessage(
        channelId,
        buildUpdateChannelPayload(notification, publicBaseUrl, getBrandName())
      );
      deliveredIds.add(notificationId);
      await acknowledge(notificationId);
    } catch (error) {
      logger?.error?.("Portal update channel notification delivery failed.", {notificationId, error});
    }
  }
};

const appendAiMessageContext = async ({
  sage,
  kind,
  notification,
  payload,
  logger
}) => {
  if (typeof sage?.assistOracle !== "function") {
    return payload;
  }
  try {
    const deterministicContent = normalizeString(payload?.content || payload?.embeds?.[0]?.description);
    if (!deterministicContent) {
      return payload;
    }
    const result = await sage.assistOracle({
      task: "message",
      kind,
      deterministicContent,
      context: {
        titleName: notification?.titleName || notification?.title,
        status: notification?.status,
        requestId: notification?.requestId,
        notificationId: notification?.id
      }
    });
    const appendix = normalizeString(result?.payload?.text || result?.payload?.appendix);
    if (!result?.ok || !appendix) {
      return payload;
    }
    return {
      ...payload,
      content: truncate(`${deterministicContent}\n${appendix}`, 1900)
    };
  } catch (error) {
    logger?.warn?.("Portal AI message assistance skipped.", {kind, error});
    return payload;
  }
};

export const createFollowNotifier = ({
  sage,
  discord,
  logger,
  publicBaseUrl,
  requestCommand,
  getBrandName,
  pollMs = FOLLOW_NOTIFICATION_POLL_MS
} = {}) => {
  let timer = null;
  let active = false;

  const poll = async () => {
    if (!active) {
      return;
    }

    try {
      await deliverNotifications({
        list: () => sage?.listFollowNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeFollowNotification?.(id),
        kind: "follow",
        discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName
      });
      await deliverNotifications({
        list: () => sage?.listRequestNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeRequestNotification?.(id),
        kind: "request",
        discord,
        sage,
        logger,
        publicBaseUrl,
        requestCommand,
        getBrandName
      });
      await deliverReleaseChannelNotifications({
        list: () => sage?.listReleaseNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeReleaseNotification?.(id),
        discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName
      });
      await deliverUpdateChannelNotifications({
        list: () => sage?.listUpdateNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeUpdateNotification?.(id),
        discord,
        logger,
        publicBaseUrl,
        getBrandName
      });
      await deliverNotifications({
        list: () => sage?.listSystemNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeSystemNotification?.(id),
        kind: "system",
        discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName
      });
      await deliverNotifications({
        list: () => sage?.listDownloadAllNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeDownloadAllNotification?.(id),
        kind: "downloadall",
        discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName
      });
    } catch (error) {
      logger?.error?.("Portal notifier poll failed.", {error});
    }
  };

  return {
    start() {
      if (active) {
        return;
      }
      active = true;
      timer = setInterval(() => {
        void poll();
      }, pollMs);
      timer.unref?.();
      void poll();
    },
    stop() {
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
};

export default {
  createFollowNotifier
};
