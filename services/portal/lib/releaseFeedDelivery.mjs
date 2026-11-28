/** @file Retry-safe channel delivery for catalog-backed release feeds. */
import {buildReleaseCard} from "./releaseCard.mjs";

const checked = response => {
  if (!response?.ok) throw new Error(`Release delivery broker failed (${response?.status || "unavailable"}).`);
  return response.payload;
};

/** Send a bounded page of durable feed events, retaining accepted receipts across broker failures.
 * @param {object} options Sage, Discord, configured branding and logger dependencies.
 * @returns {object} Feed poll operation.
 */
export const createReleaseFeedDelivery = ({sage, discord, getBrandName = () => "Scriptarr", logger}) => {
  const accepted = new Map();
  return {async poll(shouldContinue = () => true) {
    checked(await sage.prepareReleaseNotifications());
    if (!shouldContinue()) return;
    const {notifications = []} = checked(await sage.listReleaseNotifications());
    for (const event of notifications) {
      if (!event.id?.startsWith("release-feed:") || !shouldContinue()) continue;
      try {
        let message = accepted.get(event.id);
        const payload = buildReleaseCard(event, getBrandName());
        // Preparing an image is not a send attempt: a failed image read remains pending.
        if (event.kind === "title" && !message && !event.delivery?.messageId
          && !["ambiguous", "sent"].includes(event.delivery?.phase)) {
          const art = await sage.getReleaseArtwork(event.id);
          if (!art?.buffer?.length) throw new Error("Release artwork is not ready.");
          const name = art.contentType === "image/webp" ? "cover.webp" : art.contentType === "image/png" ? "cover.png" : "cover.jpg";
          payload.files = [{attachment: art.buffer, name}]; payload.embeds[0].image = {url: `attachment://${name}`};
        }
        let delivery = checked(await sage.beginReleaseDelivery(event.id)).delivery;
        if (!delivery || delivery.phase === "acknowledged") continue;
        if (!delivery.messageId && !message) {
          if (delivery.phase === "ambiguous") {
            message = await discord.reconcileChannelMessage?.(event.channelId, {nonce: delivery.nonce, attemptedAt: delivery.attemptedAt, payload});
            if (!message) {logger?.warn?.("Release send requires reconciliation; retaining event.", {notificationId: event.id}); continue;}
          } else if (delivery.phase === "sending") {
            if (!shouldContinue()) return;
            message = await discord.sendChannelMessage(event.channelId, {...payload, nonce: delivery.nonce, enforceNonce: true});
          } else continue;
          if (!message?.id || !(message.channelId || message.channel?.id)) throw new Error("Discord returned no accepted message identity.");
          accepted.set(event.id, message);
        }
        // Persist an accepted send even when shutdown races the response.
        if (!delivery.messageId) {
          delivery = checked(await sage.recordReleaseDelivery(event.id, {messageId: message.id, channelId: message.channelId || message.channel.id})).delivery;
          accepted.delete(event.id);
        }
        checked(await sage.acknowledgeReleaseNotification(event.id));
      } catch (error) {logger?.error?.("Release delivery retained for retry.", {notificationId: event.id, error});}
    }
  }};
};
