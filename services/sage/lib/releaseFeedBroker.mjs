/** @file Durable per-title Discord feeds; observation never advances delivery state. */
import {readPortalDiscordSettings} from "./portalDiscordSettings.mjs";
import {createHash} from "node:crypto";
import {buildReleaseFeedEvent, releaseReadyChapters, releaseTitleJobId, releaseCardVersion} from "./releaseFeed.mjs";

const KIND = "portal-release-title";
const CONTROL = "portal_release_feed_control";
const array = value => Array.isArray(value) ? value : [];
const fail = (status, message) => Object.assign(new Error(message), {status});
const receiptId = id => `portal_release_receipt_${createHash("sha256").update(id).digest("hex")}`;

/** Coordinate catalog discovery, one pending event per title, and accepted message receipts.
 * The supported single Sage runtime serializes mutations; generic jobs are not distributed locks.
 * @param {{vaultClient: object, config: object, clock?: Function}} options Vault client, trusted configuration and optional clock.
 * @returns {object} Prepare, observation and delivery operations.
 */
export const createReleaseFeedBroker = ({vaultClient: vault, config, clock = Date.now}) => {
  let tail = Promise.resolve();
  const serial = work => {const result = tail.catch(() => {}).then(work); tail = result; return result;};
  const now = () => new Date(clock()).toISOString();
  const save = (jobId, payload, result, old) => vault.upsertJob(jobId, {jobId, ownerService: "scriptarr-sage",
    kind: jobId === CONTROL ? "portal-release-control" : KIND, label: "Discord release feed", requestedBy: "scriptarr-portal",
    status: result.pending?.phase === "ambiguous" ? "blocked" : result.pending ? "running" : "completed",
    payload, result, createdAt: old?.createdAt || now(), updatedAt: now()});
  const jobs = async () => {
    const rows = await vault.listJobs({ownerService: "scriptarr-sage", kind: KIND});
    if (!Array.isArray(rows)) throw fail(503, "Release checkpoints are unavailable.");
    return rows;
  };
  const loadEvent = async id => {
    const match = /^release-feed:([a-f0-9]{64}):[a-f0-9]{24}$/.exec(id);
    if (!match) throw fail(400, "A valid release event identity is required.");
    const job = await vault.getJob(`portal_release_title_${match[1]}`);
    if (!job) throw fail(404, "Release event not found.");
    if (job.result?.pending?.event?.id === id) return job;
    const receipt = job.result?.lastReceipt?.id === id ? job.result.lastReceipt : (await vault.getJob(receiptId(id)))?.payload;
    if (receipt?.id !== id || (receipt.titleId && receipt.titleId !== job.payload.titleId)) throw fail(404, "Release event not found.");
    return {...job, result: {...job.result, pending: null, lastReceipt: receipt}};
  };
  const cards = async () => {
    const result = [], seen = new Set(); let cursor = "0";
    for (;;) {
      if (seen.has(cursor)) throw fail(503, "Release catalog pagination repeated.");
      seen.add(cursor);
      const page = await vault.listRavenTitleCards({cursor, pageSize: 100, sort: "title"});
      if (!Array.isArray(page?.titles) || typeof page?.pageInfo?.hasMore !== "boolean"
        || page.degraded || page.error) throw fail(503, "Release catalog discovery is incomplete.");
      result.push(...page.titles);
      if (!page.pageInfo.hasMore) return result;
      cursor = String(page.pageInfo.nextCursor ?? "");
      if (!cursor) throw fail(503, "Release catalog cursor is missing.");
    }
  };
  return {
    initialized: async () => Boolean(await vault.getJob(CONTROL)),
    prepare: () => serial(async () => {
      const settings = await readPortalDiscordSettings(vault);
      const destinations = settings.notifications.releaseChannelIdsByLibraryType || {};
      if (!settings.notifications.releaseChannelId && !Object.values(destinations).some(Boolean)) return {prepared: 0};
      const inventory = await cards(); // A partial census must not initialize or advance checkpoints.
      let control = await vault.getJob(CONTROL);
      if (!control) control = await save(CONTROL, {cutoverAt: now()}, {}, null);
      const cutoff = Date.parse(control.payload.cutoverAt);
      const checkpoints = new Map((await jobs()).map(j => [j.payload.titleId, j]));
      let prepared = 0;
      for (const card of inventory) {
        const channelId = destinations[card.libraryTypeSlug || card.mediaType] || settings.notifications.releaseChannelId;
        if (!channelId) continue;
        const existing = checkpoints.get(card.id), state = existing?.result || {};
        if (state.pending || state.observedVersion === releaseCardVersion(card)) continue;
        const title = await vault.getRavenTitle(card.id);
        if (!title || title.id !== card.id || !Array.isArray(title.chapters) || !title.title) throw fail(503, "An exact release catalog title is unavailable.");
        const ready = releaseReadyChapters(title);
        const baseline = existing ? [] : ready.filter(c => {
          const at = Date.parse(c.ingestedAt || c.updatedAt || title.updatedAt);
          if (!Number.isFinite(at)) throw fail(503, "A release chapter has no durable readiness time.");
          return at <= cutoff;
        }).map(c => c.id);
        const known = new Set([...array(state.knownChapterIds), ...baseline]);
        const fresh = ready.filter(c => !known.has(c.id));
        const introduced = Boolean(state.introduced || baseline.length);
        // A new title is advertised only when its whole known chapter set is readable.
        const titleReady = title.ingestStatus === "ready" && ready.length > 0 && ready.length >= Number(title.chapterCount || title.chapters.length);
        const event = fresh.length && (introduced || titleReady)
          ? buildReleaseFeedEvent({title, chapters: introduced ? fresh : ready, kind: introduced ? "chapters" : "title", channelId, publicBaseUrl: config.publicBaseUrl}) : null;
        await save(releaseTitleJobId(title.id), {titleId: title.id}, {...state, introduced, knownChapterIds: [...known],
          observedVersion: event || (!introduced && fresh.length) ? "" : releaseCardVersion(card),
          ...(event ? {pending: {event, phase: "pending", createdAt: now()}} : {})}, existing);
        if (event) prepared++;
      }
      return {prepared};
    }),
    list: async () => (await jobs()).filter(j => j.result?.pending).sort((a, b) => a.result.pending.createdAt.localeCompare(b.result.pending.createdAt))
      .slice(0, 10).map(j => ({...j.result.pending.event, delivery: {...j.result.pending, event: undefined}})),
    event: async id => (await loadEvent(id)).result.pending?.event || null,
    begin: id => serial(async () => {
      const job = await loadEvent(id), pending = job.result.pending;
      if (!pending) return {phase: "acknowledged", ...job.result.lastReceipt};
      if (pending.phase === "pending") {pending.phase = "sending"; pending.attemptedAt = now();}
      else if (pending.phase === "sending" && clock() - Date.parse(pending.attemptedAt) >= 120000) pending.phase = "ambiguous";
      await save(job.jobId, job.payload, {...job.result, pending}, job);
      return {...pending, event: undefined, nonce: pending.event.nonce, channelId: pending.event.channelId};
    }),
    record: (id, receipt) => serial(async () => {
      const job = await loadEvent(id), pending = job.result.pending;
      if (!pending) return job.result.lastReceipt;
      if (!/^[0-9]{1,25}$/.test(receipt.messageId || "") || receipt.channelId !== pending.event.channelId) throw fail(400, "The Discord receipt must match this event's channel.");
      if (pending.messageId && pending.messageId !== receipt.messageId) throw fail(409, "A different message is already recorded.");
      if (pending.phase === "pending") throw fail(409, "The release delivery has not been claimed.");
      const next = {...pending, phase: "sent", messageId: receipt.messageId, channelId: receipt.channelId};
      await save(job.jobId, job.payload, {...job.result, pending: next}, job);
      return {...next, event: undefined};
    }),
    acknowledge: id => serial(async () => {
      const job = await loadEvent(id), pending = job.result.pending;
      if (!pending) return {ok: true};
      if (pending.phase !== "sent" || !pending.messageId) throw fail(409, "Record the accepted Discord message before acknowledgement.");
      const result = {...job.result, introduced: true, knownChapterIds: [...new Set([...array(job.result.knownChapterIds), ...pending.event.chapters.map(c => c.id)])],
        observedVersion: "", pending: null, lastReceipt: {id, messageId: pending.messageId, channelId: pending.channelId}};
      // Write the per-event tombstone before advancing the title checkpoint, retaining every accepted message.
      await vault.upsertJob(receiptId(id), {jobId: receiptId(id), ownerService: "scriptarr-sage", kind: "portal-release-receipt",
        label: "Discord release receipt", requestedBy: "scriptarr-portal", status: "completed",
        payload: {...result.lastReceipt, titleId: job.payload.titleId}, result: {acknowledgedAt: now()}});
      await save(job.jobId, job.payload, result, job);
      return {ok: true};
    })
  };
};
