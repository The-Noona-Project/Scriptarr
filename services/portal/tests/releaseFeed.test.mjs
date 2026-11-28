import test from "node:test";
import assert from "node:assert/strict";
import {buildReleaseCard, releaseSynopsis} from "../lib/releaseCard.mjs";
import {createReleaseFeedDelivery} from "../lib/releaseFeedDelivery.mjs";

const event = {id: "release-feed:test", kind: "title", channelId: "11", titleName: "Flying Witch", libraryTypeLabel: "Manga",
  titleUrl: "https://pax-kun.com/title/manga/title", readerUrl: "https://pax-kun.com/reader/manga/title/c1",
  author: "Ishizuka Chihiro", summary: "A source synopsis.\n___\n**Links:** bad appendix", tags: ["Comedy", "comedy", "Magic"],
  chapters: [{id: "c1", label: "Chapter 1", readerUrl: "https://pax-kun.com/reader/manga/title/c1"}], chapterCount: 7};
const ok = payload => ({ok: true, payload});

test("rich card has one synopsis, source tags, full art and canonical title/read buttons", () => {
  const payload = buildReleaseCard({...event, artUrl: "attachment://cover.jpg"}, "Pax-Kun");
  assert.equal(payload.content, undefined); assert.equal(payload.embeds[0].title, "Flying Witch");
  assert.equal(payload.embeds[0].description, "A source synopsis."); assert.equal(payload.embeds[0].image.url, "attachment://cover.jpg");
  assert.equal(payload.embeds[0].fields.find(f => f.name === "Tags").value, "Comedy • Magic");
  assert.deepEqual(payload.components[0].components.map(b => b.url), [event.titleUrl, event.readerUrl]);
  assert.doesNotMatch(JSON.stringify(payload), /Window|digest|Last Read/);
  assert.equal(releaseSynopsis("<b>Hi</b> &amp; bye.\nNotes: no"), "Hi & bye.");
  assert.ok(releaseSynopsis("x".repeat(1000)).length <= 900);
  assert.equal(buildReleaseCard({...event, chapterCount: 1}).embeds[0].fields.find(f => f.name === "Ready to read").value, "1 chapter");
  assert.equal(buildReleaseCard({...event, titleUrl: "http://127.0.0.1:3300/title/manga/title"}).components[0].components[0].url, "http://127.0.0.1:3300/title/manga/title");
});

test("chapter updates use actual reader links, remain compact, and never repeat a title introduction", () => {
  const payload = buildReleaseCard({...event, kind: "chapters"}, "Pax-Kun");
  assert.match(payload.embeds[0].description, /\[Chapter 1\]\(https:\/\/pax-kun.com\/reader/);
  assert.equal(payload.embeds[0].image, undefined); assert.equal(payload.embeds[0].fields, undefined);
  assert.match(payload.embeds[0].title, /^New chapter ·/);
});

test("accepted send survives receipt and ack failures without resending", async () => {
  let phase = "pending", receipt = null, failReceipt = true, failAck = true, sends = 0, artReads = 0;
  const sage = {
    async prepareReleaseNotifications() {return ok({});}, async listReleaseNotifications() {return ok({notifications: [{...event, delivery: {phase, messageId: receipt?.messageId}}]});},
    async getReleaseArtwork() {artReads++; return {buffer: Buffer.from("raster"), contentType: "image/webp"};},
    async beginReleaseDelivery() {if (phase === "pending") phase = "sending"; return ok({delivery: {phase, nonce: "stable", ...receipt}});},
    async recordReleaseDelivery(_id, value) {if (failReceipt) {failReceipt = false; return {ok: false};} receipt = value; phase = "sent"; return ok({delivery: {phase, ...receipt}});},
    async acknowledgeReleaseNotification() {if (failAck) {failAck = false; return {ok: false};} phase = "acknowledged"; return ok({});}
  };
  const discord = {async sendChannelMessage(channelId, payload) {sends++; assert.equal(payload.nonce, "stable"); assert.equal(payload.enforceNonce, true);
    assert.equal(payload.embeds[0].image.url, "attachment://cover.webp"); return {id: "100", channelId};}};
  const delivery = createReleaseFeedDelivery({sage, discord});
  await delivery.poll(); await delivery.poll(); await createReleaseFeedDelivery({sage, discord}).poll();
  assert.equal(sends, 1); assert.equal(artReads, 1); assert.equal(phase, "acknowledged");
});

test("art failure does not claim a send; ambiguous old outcomes reconcile instead of reposting", async () => {
  let begins = 0, sends = 0, artFails = true, ambiguous = false, reconciled = false;
  const sage = {async prepareReleaseNotifications() {return ok({});},
    async listReleaseNotifications() {return ok({notifications: [{...event, delivery: {phase: ambiguous ? "ambiguous" : "pending"}}]});},
    async getReleaseArtwork() {if (artFails) throw Error("missing"); return {buffer: Buffer.from("image"), contentType: "image/jpeg"};},
    async beginReleaseDelivery() {begins++; return ok({delivery: {phase: "ambiguous", nonce: "stable", attemptedAt: "2026-01-01T00:00:00Z"}});},
    async recordReleaseDelivery() {reconciled = true; return ok({delivery: {phase: "sent"}});}, async acknowledgeReleaseNotification() {return ok({});}};
  const discord = {async sendChannelMessage() {sends++;}, async reconcileChannelMessage() {return {id: "123", channelId: "11"};}};
  const delivery = createReleaseFeedDelivery({sage, discord}); await delivery.poll(); assert.equal(begins, 0);
  artFails = false; ambiguous = true; await delivery.poll(); assert.equal(sends, 0); assert.equal(reconciled, true);
});
