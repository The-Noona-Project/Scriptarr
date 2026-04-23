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

const buildDirectMessagePayload = (notification, kind, publicBaseUrl, requestCommand) => {
  const titleName = normalizeString(notification?.titleName || notification?.title || "your Scriptarr title");
  const titleUrl = resolveNotificationLink(notification, kind, publicBaseUrl);
  const coverUrl = normalizeString(notification?.coverUrl);
  const moderatorNote = normalizeString(notification?.moderatorNote || notification?.note || notification?.comment);
  const requestEventType = resolveRequestEventType(notification);
  const titleLine = kind === "request"
    ? (() => {
      switch (requestEventType) {
        case "approved":
          return `Your Scriptarr request for **${titleName}** was approved.`;
        case "denied":
          return `Your Scriptarr request for **${titleName}** was denied.`;
        case "blocked":
          return `Scriptarr is already tracking **${titleName}**.`;
        case "ready":
          return `The Scriptarr title you asked to be notified about, **${titleName}**, is ready.`;
        case "source-found":
          return `Scriptarr found a source for your unavailable request **${titleName}** and moved it back into admin review.`;
        case "expired":
          return `Your Scriptarr request for **${titleName}** expired after 90 days without a stable source.`;
        default:
          return `Your Scriptarr request for **${titleName}** is ready.`;
      }
    })()
    : `New Scriptarr download completed for **${titleName}**.`;
  const noteLine = moderatorNote ? `\nModerator note: ${moderatorNote}` : "";
  const linkLine = titleUrl ? `\nOpen in Scriptarr: ${titleUrl}` : "";
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
            return "A new download source was found and the request is back in admin review.";
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

const deliverNotifications = async ({
  list,
  acknowledge,
  kind,
  discord,
  logger,
  publicBaseUrl,
  requestCommand
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
      await discord.sendDirectMessage(
        notification.discordUserId,
        buildDirectMessagePayload(notification, kind, publicBaseUrl, requestCommand)
      );
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
  requestCommand,
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
        publicBaseUrl,
        requestCommand
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
