import {FOLLOW_NOTIFICATION_POLL_MS} from "./discord/constants.mjs";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const buildDirectMessagePayload = (notification, kind) => {
  const titleName = normalizeString(notification?.titleName || notification?.title || "your Scriptarr title");
  const titleUrl = normalizeString(notification?.titleUrl);
  const coverUrl = normalizeString(notification?.coverUrl);
  const titleLine = kind === "request"
    ? `Your Scriptarr request for **${titleName}** is ready.`
    : `New Scriptarr download completed for **${titleName}**.`;
  const linkLine = titleUrl ? `\nOpen in Scriptarr: ${titleUrl}` : "";
  const payload = {
    content: `${titleLine}${linkLine}`
  };

  if (coverUrl || titleUrl) {
    payload.embeds = [{
      title: titleName,
      description: kind === "request"
        ? "Requested title download completed."
        : "Followed title download completed.",
      url: titleUrl || undefined,
      image: coverUrl ? {url: coverUrl} : undefined
    }];
  }

  return payload;
};

const deliverNotifications = async ({
  list,
  acknowledge,
  kind,
  discord,
  logger
}) => {
  if (typeof list !== "function" || typeof acknowledge !== "function") {
    return;
  }

  const response = await list();
  if (!response?.ok) {
    return;
  }

  for (const notification of normalizeArray(response.payload?.notifications)) {
    const notificationId = normalizeString(notification?.id, normalizeString(notification?.requestId));
    try {
      await discord.sendDirectMessage(notification.discordUserId, buildDirectMessagePayload(notification, kind));
      if (notificationId) {
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
        logger
      });
      await deliverNotifications({
        list: () => sage?.listRequestNotifications?.(),
        acknowledge: (id) => sage?.acknowledgeRequestNotification?.(id),
        kind: "request",
        discord,
        logger
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
