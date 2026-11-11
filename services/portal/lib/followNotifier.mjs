import {FOLLOW_NOTIFICATION_POLL_MS} from "./discord/constants.mjs";
import {createDownloadAllDelivery} from "./downloadAllDelivery.mjs";
import {resolveBulkRunAttention} from "./discord/downloadAllShared.mjs";

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
const isPermanentDirectMessageFailure = (error) => {
  const code = Number(error?.code || error?.rawError?.code || 0);
  const message = String(error?.message || error?.rawError?.message || "");
  return code === 50007
    || /cannot send messages to this user|no mutual guilds/i.test(message);
};
const isGenericReleaseChapterLabel = (value) => {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
  return !normalized
    || /^(raven\s+)?download(ed)?\s+completed\.?$/.test(normalized)
    || normalized === "completed"
    || normalized === "raven completed";
};
const normalizeReleaseChapterLabel = (value, fallback = "Latest chapter") => {
  const normalized = normalizeString(value);
  return normalized && !isGenericReleaseChapterLabel(normalized)
    ? normalized
    : fallback;
};
const formatTypeLabel = (value) => normalizeString(value, "library")
  .replace(/[-_]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());
const escapeMarkdownLinkText = (value) => normalizeString(value)
  .replace(/\\/g, "\\\\")
  .replace(/\[/g, "\\[")
  .replace(/\]/g, "\\]");
const DOWNLOADALL_APPROVE_REACTION = "✅";
const DOWNLOADALL_DENY_REACTION = "❌";

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
  const skippedActive = toCount(summary.skippedActive ?? counts.skippedActiveCount ?? notification.skippedActiveCount, 0);
  const skippedAdult = toCount(summary.skippedAdultContent ?? counts.skippedAdultContentCount ?? notification.skippedAdultContentCount, 0);
  const skippedNoMetadata = toCount(summary.skippedNoMetadata ?? counts.skippedNoMetadataCount ?? notification.skippedNoMetadataCount, 0);
  const skippedAmbiguous = toCount(summary.skippedAmbiguousMetadata ?? counts.skippedAmbiguousMetadataCount ?? notification.skippedAmbiguousMetadataCount, 0);
  const invalidSource = toCount(summary.invalidSource ?? counts.invalidSourceCount ?? notification.invalidSourceCount, 0);
  const {failedTitles, unresolvedPlans, pauseReason} = resolveBulkRunAttention(notification);
  const staleTitles = toCount(summary.staleTitles ?? counts.staleTitleTaskCount ?? notification.staleTitleTaskCount, 0);
  const displayRunId = compactRunId(runId);
  const hasApproval = Boolean(normalizeString(notification.approvalId));
  const actionLine = status === "paused" && hasApproval
    ? `React ${DOWNLOADALL_APPROVE_REACTION} to run the next ${batchesPerApproval} batch(es), or ${DOWNLOADALL_DENY_REACTION} to cancel.`
    : status === "paused" ? "Use the continue slash command to approve the next batch window." : `Run ${displayRunId || "unknown"} is ${status}.`;
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
    unresolvedPlans ? `Unresolved title plans: **${unresolvedPlans}**` : "",
    failedTitles ? `Failed title tasks: **${failedTitles}**` : "",
    staleTitles ? `Stale title tasks: **${staleTitles}**` : ""
  ].filter(Boolean).join("\n") || "None reported";

  return {
    content: [
      status === "paused"
        ? pauseReason ? `Downloadall paused: ${pauseReason}.` : completedBatches ? `Downloadall paused after ${completedBatches} batch(es).` : "Downloadall paused before any batch completed."
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
          ].filter(Boolean).join("\n"),
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
            `Already current: **${skippedCurrent}**`,
            `Already active: **${skippedActive}**`,
            `Adult or unverified content: **${skippedAdult}**`,
            `No metadata match: **${skippedNoMetadata}**`,
            `Ambiguous metadata: **${skippedAmbiguous}**`,
            `Unavailable source: **${toCount(counts.skippedUnavailableCount, 0)}**`,
            `Invalid source rows: **${invalidSource}**`
          ].join("\n"),
          inline: true
        },
        {
          name: "Needs attention",
          value: needsAttention,
          inline: true
        },
        currentBatchLabel ? {
          name: status === "paused"
            ? completedBatches > 0 && (!currentBatch.status || currentBatch.status === "completed") ? "Last completed batch" : "Paused batch"
            : "Current batch",
          value: currentBatchLabel,
          inline: true
        } : null,
        status === "paused" ? {
          name: "Next action",
          value: [
            ...(hasApproval ? [`${DOWNLOADALL_APPROVE_REACTION} Continue next **${batchesPerApproval}** batch(es)`, `${DOWNLOADALL_DENY_REACTION} Cancel remaining run`] : []),
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
      footer: status === "paused" && hasApproval
        ? {text: "React once. Duplicate or late decisions are ignored."}
        : undefined
    }]
  };
};

const resolveIngestRunLink = (notification = {}, publicBaseUrl = "") => {
  const explicitLink = normalizeString(notification.linkUrl || notification.moonUrl || notification.adminUrl);
  const baseUrl = normalizeString(publicBaseUrl).replace(/\/+$/g, "");
  if (explicitLink.startsWith("/") && baseUrl) {
    return `${baseUrl}${explicitLink}`;
  }
  if (explicitLink) {
    return explicitLink;
  }
  return baseUrl ? `${baseUrl}/admin/activity/queue` : "";
};

const resolveIngestRunColor = (status) => {
  switch (normalizeString(status).toLowerCase()) {
    case "completed":
      return 0x16a34a;
    case "failed":
      return 0xdc2626;
    case "cancelled":
    case "canceled":
      return 0x64748b;
    default:
      return 0x60a5fa;
  }
};

export const buildIngestRunDirectMessagePayload = (notification = {}, publicBaseUrl = "", brandName = "Scriptarr") => {
  const runId = normalizeString(notification.runId || notification.jobId);
  const status = normalizeString(notification.status, "running").toLowerCase();
  const typeLabel = normalizeString(notification.libraryTypeLabel, formatTypeLabel(notification.libraryTypeSlug || "library"));
  const totalTitles = toCount(notification.totalTitles, 0);
  const completedTitles = toCount(notification.completedTitles, 0);
  const failedTitles = toCount(notification.failedTitles, 0);
  const remainingTitles = toCount(notification.remainingTitles, Math.max(0, totalTitles - completedTitles - failedTitles));
  const milestone = toCount(notification.milestone, 0);
  const percent = notification.terminal ? 100 : toCount(notification.percent, milestone);
  const linkUrl = resolveIngestRunLink(notification, publicBaseUrl);
  const doneLine = notification.terminal
    ? failedTitles > 0 || status === "failed"
      ? `${brandName} ingest finished with issues for ${typeLabel}.`
      : `${brandName} ingest completed for ${typeLabel}.`
    : `${brandName} ingest is ${milestone || percent}% done for ${typeLabel}.`;
  const runLine = runId ? `Run \`${compactRunId(runId)}\`` : "Library ingest run";
  const linkLine = linkUrl ? `\nOpen queue: ${linkUrl}` : "";

  return {
    content: `${doneLine}${linkLine}`,
    embeds: [{
      title: notification.terminal ? `${brandName} ingest ${titleCase(status)}` : `${brandName} ingest ${milestone || percent}%`,
      description: `${runLine} - ${typeLabel}`,
      url: linkUrl || undefined,
      color: resolveIngestRunColor(status),
      fields: [
        {
          name: "Progress",
          value: [
            `Completed: **${completedTitles}** / **${totalTitles}** title(s)`,
            `Remaining: **${remainingTitles}**`
          ].join("\n"),
          inline: true
        },
        {
          name: "Issues",
          value: failedTitles ? `Failed title(s): **${failedTitles}**` : "None reported",
          inline: true
        },
        runId ? {
          name: "Run",
          value: `\`${compactRunId(runId)}\``,
          inline: true
        } : null
      ].filter(Boolean),
      footer: notification.terminal
        ? {text: "Final ingest update"}
        : {text: "Appa will DM the next milestone when the run crosses it."}
    }]
  };
};

const buildDirectMessagePayload = (notification, kind, publicBaseUrl, requestCommand, brandName = "Scriptarr") => {
  if (kind === "downloadall") {
    return buildDownloadAllDirectMessagePayload(notification, publicBaseUrl, brandName);
  }

  if (kind === "ingest") {
    return buildIngestRunDirectMessagePayload(notification, publicBaseUrl, brandName);
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
  const digestItems = normalizeArray(notification.items);
  const titleGroups = normalizeArray(notification.titleGroups);
  if (titleGroups.length || digestItems.length || notification.digest === true) {
    const totalCount = Math.max(toCount(notification.totalCount, digestItems.length), digestItems.length);
    const hiddenCount = Math.max(0, toCount(notification.hiddenCount, totalCount - digestItems.length));
    const typeLabel = normalizeString(notification.libraryTypeLabel)
      || (notification.libraryTypeSlug ? formatTypeLabel(notification.libraryTypeSlug) : "");
    const visibleGroups = titleGroups.length
      ? titleGroups.slice(0, 8)
      : digestItems.slice(0, 10).map((item) => ({
        titleName: item.titleName,
        titleUrl: item.titleUrl || item.linkUrl,
        coverUrl: item.coverUrl,
        chapterCount: 1,
        chapters: [{
          chapterLabel: item.chapterLabel || item.latestChapter,
          linkUrl: item.linkUrl || item.readerUrl || item.titleUrl,
          completedAt: item.completedAt
        }]
      }));
    const releaseWord = totalCount === 1 ? "release" : "releases";
    const hiddenLine = hiddenCount > 0
      ? ` +${hiddenCount} more grouped into this digest.`
      : "";
    const fields = visibleGroups.map((group) => {
      const titleName = truncate(normalizeString(group.titleName || group.title, `${brandName} title`), 150);
      const titleLink = normalizeString(group.titleUrl || group.linkUrl);
      const fieldName = truncate(`${titleName}${group.chapterCount > 1 ? ` (${group.chapterCount})` : ""}`, 240);
      const titleLine = titleLink ? `[Open title](${titleLink})` : "";
      const chapterLines = normalizeArray(group.chapters).slice(0, 6).map((chapter) => {
        const label = truncate(normalizeReleaseChapterLabel(chapter.chapterLabel || chapter.latestChapter, "Latest chapter"), 90);
        const link = normalizeString(chapter.linkUrl || chapter.readerUrl || chapter.titleUrl);
        return link
          ? `- [${escapeMarkdownLinkText(label)}](${link})`
          : `- ${label}`;
      });
      return {
        name: fieldName,
        value: truncate([titleLine, ...chapterLines].filter(Boolean).join("\n") || "Latest chapter", 1024),
        inline: false
      };
    });
    const firstCoverUrl = normalizeString(
      visibleGroups.find((group) => normalizeString(group.coverUrl))?.coverUrl
      || digestItems.find((item) => normalizeString(item.coverUrl))?.coverUrl
    );
    const windowValue = [
      notification.newestCompletedAt ? `Newest: ${notification.newestCompletedAt}` : "",
      notification.oldestCompletedAt && notification.oldestCompletedAt !== notification.newestCompletedAt ? `Oldest: ${notification.oldestCompletedAt}` : ""
    ].filter(Boolean).join("\n");
    return {
      content: truncate(`${totalCount} new ${brandName}${typeLabel ? ` ${typeLabel}` : ""} ${releaseWord} are ready to read.${hiddenLine}`, 1900),
      embeds: [{
        title: `${typeLabel ? `${typeLabel} ` : ""}${brandName} ${releaseWord} ready`,
        description: truncate(`${visibleGroups.length} title group${visibleGroups.length === 1 ? "" : "s"} in this digest.`, 600),
        color: 0x5865f2,
        thumbnail: firstCoverUrl ? {url: firstCoverUrl} : undefined,
        fields: [
          ...fields,
          windowValue ? {
            name: "Window",
            value: windowValue,
            inline: true
          } : null,
          typeLabel ? {
            name: "Library",
            value: typeLabel,
            inline: true
          } : null,
          hiddenCount > 0 ? {
            name: "More",
            value: `+${hiddenCount} more grouped in this digest.`
          } : null
        ].filter(Boolean),
        footer: {text: "Grouped by Noona to keep the channel readable."}
      }]
    };
  }

  const titleName = normalizeString(notification.titleName || notification.title, `${brandName} title`);
  const chapterLabel = normalizeReleaseChapterLabel(notification.chapterLabel || notification.latestChapter, "Latest chapter");
  const linkUrl = normalizeString(notification.linkUrl || notification.readerUrl || notification.titleUrl)
    || (normalizeString(publicBaseUrl) ? normalizeString(publicBaseUrl).replace(/\/+$/g, "") : "");
  const coverUrl = normalizeString(notification.coverUrl);
  const linkLine = linkUrl ? `\nRead it here: ${linkUrl}` : "";
  const description = `**${titleName}** is ready to read: ${chapterLabel}.${linkLine}`;
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
  const summary = normalizeString(notification.summary, `Noona found a ${brandName} update.`);
  const compareUrl = normalizeString(notification.compareUrl);
  const commitCount = toCount(notification.commitCount, normalizeArray(notification.commits).length);
  const components = compareUrl
    ? [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: "View changes",
        url: compareUrl
      }]
    }]
    : [];
  return {
    content: truncate(`New ${brandName} update is ready.`, 1900),
    embeds: [{
      title: `${brandName} update`,
      description: truncate(summary, 1600),
      color: 0x8b5cf6,
      fields: [],
      footer: {text: `${commitCount || 1} change${commitCount === 1 ? "" : "s"} included`}
    }],
    components
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
  getBrandName = () => "Scriptarr",
  shouldContinue = () => true
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok || !shouldContinue()) {
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
      if (!shouldContinue()) {
        return;
      }
      const payload = await appendAiMessageContext({
        sage,
        kind,
        notification,
        payload: buildDirectMessagePayload(notification, kind, publicBaseUrl, requestCommand, getBrandName()),
        logger
      });
      if (!shouldContinue()) {
        return;
      }
      const sentMessage = await discord.sendDirectMessage(
        notification.discordUserId,
        payload
      );
      if (!shouldContinue()) {
        return;
      }
      if (notificationId) {
        deliveredIds.add(notificationId);
        await acknowledge(notificationId);
      }
    } catch (error) {
      if (kind === "ingest" && notificationId && isPermanentDirectMessageFailure(error)) {
        logger?.warn?.("Portal ingest notifier skipped unreachable DM recipient.", {notificationId, error});
        deliveredIds.add(notificationId);
        await acknowledge(notificationId);
        continue;
      }
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
  getBrandName = () => "Scriptarr",
  shouldContinue = () => true
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok || !shouldContinue()) {
    return;
  }

  const deliveredIds = new Set();
  for (const notification of normalizeArray(response.payload?.notifications)) {
    const notificationId = normalizeString(notification?.id);
    const deliveries = normalizeArray(notification?.deliveries).length
      ? normalizeArray(notification.deliveries)
      : [notification];
    if (!notificationId || deliveredIds.has(notificationId)) {
      continue;
    }
    try {
      for (const delivery of deliveries) {
        const channelId = normalizeString(delivery?.channelId, normalizeString(notification?.channelId));
        if (!channelId) {
          throw new Error("A release notification channel id is required.");
        }
        if (!shouldContinue()) {
          return;
        }
        const deliveryNotification = {
          ...notification,
          ...delivery,
          id: notificationId
        };
        const payload = await appendAiMessageContext({
          sage,
          kind: "release",
          notification: deliveryNotification,
          payload: buildReleaseChannelPayload(deliveryNotification, publicBaseUrl, getBrandName()),
          logger
        });
        if (!shouldContinue()) {
          return;
        }
        await discord.sendChannelMessage(
          channelId,
          payload
        );
        if (!shouldContinue()) {
          return;
        }
      }
      deliveredIds.add(notificationId);
      await acknowledge(notificationId, {
        ackItemIds: normalizeArray(notification.ackItemIds),
        silenceThrough: normalizeString(notification.silenceThrough || notification.newestCompletedAt)
      });
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
  getBrandName = () => "Scriptarr",
  shouldContinue = () => true
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok || !shouldContinue()) {
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
      if (!shouldContinue()) {
        return;
      }
      await discord.sendChannelMessage(
        channelId,
        buildUpdateChannelPayload(notification, publicBaseUrl, getBrandName())
      );
      if (!shouldContinue()) {
        return;
      }
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
  adminDiscord,
  logger,
  publicBaseUrl,
  requestCommand,
  getBrandName,
  pollMs = FOLLOW_NOTIFICATION_POLL_MS
} = {}) => {
  let timer = null;
  let active = false;
  let inFlight = false;
  let inFlightPromise = null;
  let generation = 0;
  const downloadAllDelivery = createDownloadAllDelivery({sage, discord: adminDiscord || discord,
    botIdentity: adminDiscord ? "appa" : "noona", logger,
    discordForIdentity: (identity) => identity === "noona" ? discord : identity === "appa" ? adminDiscord : null});

  const shouldContinue = (pollGeneration = generation) => active && pollGeneration === generation;

  const poll = async () => {
    const pollGeneration = generation;
    if (!shouldContinue(pollGeneration)) {
      return;
    }

    inFlight = true;
    try {
      const canContinue = () => shouldContinue(pollGeneration);
      await deliverNotifications({
        list: () => sage?.listFollowNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeFollowNotification?.(id),
        kind: "follow",
        discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName,
        shouldContinue: canContinue
      });
      if (!canContinue()) {
        return;
      }
      await deliverNotifications({
        list: () => sage?.listRequestNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeRequestNotification?.(id),
        kind: "request",
        discord,
        sage,
        logger,
        publicBaseUrl,
        requestCommand,
        getBrandName,
        shouldContinue: canContinue
      });
      if (!canContinue()) {
        return;
      }
      await deliverReleaseChannelNotifications({
        list: () => sage?.listReleaseNotifications?.(),
        acknowledge: (id, payload) => sage?.acknowledgeReleaseNotification?.(id, payload),
        discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName,
        shouldContinue: canContinue
      });
      if (!canContinue()) {
        return;
      }
      await deliverUpdateChannelNotifications({
        list: () => sage?.listUpdateNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeUpdateNotification?.(id),
        discord,
        logger,
        publicBaseUrl,
        getBrandName,
        shouldContinue: canContinue
      });
      if (!canContinue()) {
        return;
      }
      await deliverNotifications({
        list: () => sage?.listIngestRunNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeIngestRunNotification?.(id),
        kind: "ingest",
        discord: adminDiscord || discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName,
        shouldContinue: canContinue
      });
      if (!canContinue()) {
        return;
      }
      await deliverNotifications({
        list: () => sage?.listSystemNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeSystemNotification?.(id),
        kind: "system",
        discord: adminDiscord || discord,
        sage,
        logger,
        publicBaseUrl,
        getBrandName,
        shouldContinue: canContinue
      });
      if (!canContinue()) {
        return;
      }
      await downloadAllDelivery.poll((notification) => appendAiMessageContext({sage, kind: "downloadall", notification,
        payload: buildDirectMessagePayload(notification, "downloadall", publicBaseUrl, requestCommand, getBrandName?.() || "Scriptarr"), logger}), canContinue);
    } catch (error) {
      logger?.error?.("Portal notifier poll failed.", {error});
    } finally {
      inFlight = false;
    }
  };

  const triggerPoll = () => {
    if (inFlight) {
      return inFlightPromise;
    }
    inFlightPromise = poll();
    return inFlightPromise;
  };

  return {
    start() {
      if (active) {
        return;
      }
      active = true;
      generation += 1;
      timer = setInterval(() => {
        void triggerPoll();
      }, pollMs);
      timer.unref?.();
      void triggerPoll();
    },
    async stop() {
      active = false;
      generation += 1;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await inFlightPromise?.catch?.(() => {});
    }
  };
};

export default {
  createFollowNotifier
};
