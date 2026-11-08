const text = (value) => typeof value === "string" ? value.trim() : "";
const checked = (response, operation) => {
  if (response?.ok !== true) throw new Error(`Downloadall ${operation} failed (HTTP ${response?.status || "unavailable"}).`);
  return response.payload;
};

/** Deliver downloadall notifications through durable Sage phases. Unknown old
 * sends require reconciliation; an accepted message is never blindly resent.
 * @param {{sage: object, discord: object, botIdentity: string, logger?: object}} options Dependencies.
 * @returns {{poll: Function}} A scoped notification poller.
 */
export const createDownloadAllDelivery = ({sage, discord, botIdentity, logger}) => {
  const accepted = new Map();
  return {
    async poll(buildPayload, shouldContinue = () => true) {
      if (typeof sage?.listDownloadAllNotifications !== "function") return;
      const response = await sage.listDownloadAllNotifications();
      if (!response?.ok || !shouldContinue()) return;
      for (const notification of response.payload?.notifications || []) {
        const id = text(notification.id);
        if (!id || !shouldContinue()) continue;
        try {
          let delivery = checked(await sage.beginDownloadAllDelivery(id, {botIdentity}), "delivery claim")?.delivery;
          if (!delivery || delivery.phase === "acknowledged") continue;
          let message = accepted.get(id);
          if (!delivery.messageId && !message) {
            if (delivery.phase !== "sending") {
              logger?.warn?.("Downloadall delivery needs reconciliation; automatic resend disabled.", {notificationId: id});
              continue;
            }
            const payload = await buildPayload(notification);
            if (!shouldContinue()) return;
            message = await discord.sendDirectMessage(notification.discordUserId, {...payload, nonce: delivery.nonce, enforceNonce: true});
            if (!text(message?.id) || !text(message?.channelId || message?.channel?.id)) throw new Error("Discord did not return the accepted message identity.");
            accepted.set(id, message);
          }
          // Always record a known accepted message, even when stop races send.
          if (!delivery.messageId) {
            delivery = checked(await sage.recordDownloadAllDelivery(id, {
              messageId: text(message.id), channelId: text(message.channelId || message.channel?.id)
            }), "delivery receipt")?.delivery;
            accepted.delete(id);
          }
          if (notification.status === "paused" && notification.approvalId) {
            if (!delivery.promptReady) checked(await sage.recordDownloadAllDecisionPrompt(id, {messageId: delivery.messageId}), "approval prompt");
            // Persist the prompt before exposing its reactions to the owner.
            try {
              message ||= await discord.fetchDirectMessage?.(delivery.channelId, delivery.messageId);
              if (message?.react) { await message.react("✅"); await message.react("❌"); }
            } catch { logger?.warn?.("Downloadall approval reactions unavailable; slash controls remain available.", {notificationId: id}); }
          }
          checked(await sage.acknowledgeDownloadAllNotification(id), "acknowledgement");
          accepted.delete(id);
        } catch (error) {
          logger?.error?.("Downloadall delivery phase failed; retaining the original message for retry.", {notificationId: id, error});
        }
      }
    }
  };
};
