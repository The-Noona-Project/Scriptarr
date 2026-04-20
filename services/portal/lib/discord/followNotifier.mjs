/**
 * Poll Sage for completed Raven downloads that should fan out to Discord DMs
 * for users following the affected titles.
 */

/**
 * @param {{
 *   discordClient: {sendDirectMessage: Function},
 *   sage: ReturnType<import("../sageClient.mjs").createSageClient>,
 *   logger?: {warn?: Function},
 *   pollMs?: number
 * }} options
 * @returns {{start: () => void, stop: () => void}}
 */
export const createFollowNotificationPoller = ({
  discordClient,
  sage,
  logger,
  pollMs = 30000
}) => {
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const response = await sage.listFollowNotifications();
      if (!response.ok) {
        return;
      }

      for (const notification of Array.isArray(response.payload?.notifications) ? response.payload.notifications : []) {
        try {
          const titleName = notification?.titleName || "your followed title";
          const titleUrl = notification?.titleUrl ? `\nOpen in Scriptarr: ${notification.titleUrl}` : "";
          await discordClient.sendDirectMessage(notification.discordUserId, {
            content: `New Scriptarr download completed for **${titleName}**.${titleUrl}`
          });
          await sage.acknowledgeFollowNotification(notification.id);
        } catch (error) {
          logger?.warn?.("Portal follow notification delivery failed.", {
            notificationId: notification?.id,
            error: error?.message || String(error)
          });
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, pollMs);
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
};

export default createFollowNotificationPoller;
