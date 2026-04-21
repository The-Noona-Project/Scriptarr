import {FOLLOW_NOTIFICATION_POLL_MS} from "./discord/constants.mjs";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
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
  return eventType === "completed"
    ? ""
    : `${baseUrl}/myrequests`;
};

const buildDirectMessagePayload = (notification, kind, publicBaseUrl) => {
  const titleName = normalizeString(notification?.titleName || notification?.title || "your Scriptarr title");
  const titleUrl = resolveNotificationLink(notification, kind, publicBaseUrl);
  const coverUrl = normalizeString(notification?.coverUrl);
  const moderatorNote = normalizeString(notification?.moderatorNote || notification?.note || notification?.comment);
  const requestEventType = resolveRequestEventType(notification);
  const titleLine = kind === "request"
    ? requestEventType === "approved"
      ? `Your Scriptarr request for **${titleName}** was approved.`
      : requestEventType === "denied"
        ? `Your Scriptarr request for **${titleName}** was denied.`
        : `Your Scriptarr request for **${titleName}** is ready.`
    : `New Scriptarr download completed for **${titleName}**.`;
  const noteLine = moderatorNote ? `\nModerator note: ${moderatorNote}` : "";
  const linkLine = titleUrl ? `\nOpen in Scriptarr: ${titleUrl}` : "";
  const payload = {
    content: `${titleLine}${noteLine}${linkLine}`
  };

  if (coverUrl || titleUrl) {
    payload.embeds = [{
      title: titleName,
      description: kind === "request"
        ? requestEventType === "approved"
          ? "Requested title approved."
          : requestEventType === "denied"
            ? "Requested title denied."
            : "Requested title download completed."
        : "Followed title download completed.",
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

const deliverNotifications = async ({
  list,
  acknowledge,
  kind,
  discord,
  logger,
  publicBaseUrl
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
      await discord.sendDirectMessage(notification.discordUserId, buildDirectMessagePayload(notification, kind, publicBaseUrl));
      if (notificationId) {
        deliveredIds.add(notificationId);
        await acknowledge(notificationId);
      }
    } catch (error) {
      logger?.error?.(`Portal ${kind} notifier delivery failed.`, {notificationId, error});
    }
  }
};

export const createFollowNotifier = ({
  sage,
  discord,
  logger,
  publicBaseUrl,
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
        logger,
        publicBaseUrl
      });
      await deliverNotifications({
        list: () => sage?.listRequestNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeRequestNotification?.(id),
        kind: "request",
        discord,
        logger,
        publicBaseUrl
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
