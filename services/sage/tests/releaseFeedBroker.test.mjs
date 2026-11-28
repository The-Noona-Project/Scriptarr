/** @file Canonical release feed discovery, durable delivery and migration regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import {createReleaseFeedBroker} from "../lib/releaseFeedBroker.mjs";
import {buildReleaseFeedEvent} from "../lib/releaseFeed.mjs";

const chapter = (id, at = "2026-01-01T00:00:00Z") => ({id, chapterNumber: id.replace(/^c/, ""), available: true, pageCount: 2,
  ingestStatus: "ready", ingestRevision: "webp-0123456789abcdef", ingestedPageCount: 2, sourcePageCount: 2,
  expectedSegmentCount: 2, ingestedSegmentCount: 2, segmentsReady: true, ingestedAt: at});
const title = (id, type = "manga", chapters = [chapter("c1")]) => ({id, title: `Title ${id}`, libraryTypeSlug: type,
  libraryTypeLabel: type === "oel" ? "OEL" : type, summary: "Source synopsis", tags: ["Action"], chapterCount: chapters.length,
  ingestStatus: "ready", ingestedChapterCount: chapters.length, updatedAt: "2026-01-01T00:00:00Z", chapters});
const fixture = () => {
  const records = new Map(), titles = new Map(); let time = Date.parse("2026-01-02T00:00:00Z"), badPage = false, writes = 0;
  const vaultClient = {
    async getSetting() {return {value: {notifications: {releaseChannelIdsByLibraryType: {manga: "11", manhwa: "12", manhua: "13", oel: "14"}}}};},
    async getJob(id) {return structuredClone(records.get(id) || null);},
    async listJobs({kind}) {return structuredClone([...records.values()].filter(j => j.kind === kind));},
    async upsertJob(id, value) {writes++; records.set(id, structuredClone(value)); return structuredClone(value);},
    async listRavenTitleCards({cursor, pageSize}) {
      const rows = [...titles.values()].map(({chapters, ...card}) => card), offset = Number(cursor);
      return {titles: rows.slice(offset, offset + pageSize), pageInfo: {hasMore: offset + pageSize < rows.length,
        nextCursor: badPage ? cursor : String(offset + pageSize)}};
    },
    async getRavenTitle(id) {return structuredClone(titles.get(id));}
  };
  const make = () => createReleaseFeedBroker({vaultClient, config: {publicBaseUrl: "https://pax-kun.com"}, clock: () => time});
  return {titles, records, make, advance: () => {time += 180000;}, breakPages: () => {badPage = true;}, writes: () => writes};
};

test("release links retain the configured local HTTP development origin while rejecting unsafe schemes", () => {
  const options = {title: title("local"), chapters: [chapter("c1")], kind: "title", channelId: "11", publicBaseUrl: "http://127.0.0.1:3300"};
  assert.match(buildReleaseFeedEvent(options).readerUrl, /^http:\/\/127.0.0.1:3300\/reader\//);
  assert.throws(() => buildReleaseFeedEvent({...options, publicBaseUrl: "javascript:alert(1)"}), /trusted HTTP/);
  assert.throws(() => buildReleaseFeedEvent({...options, publicBaseUrl: "https://user:secret@example.com"}), /trusted HTTP/);
});

test("cutover baselines existing chapters; exact new titles route to all four feeds without local task history", async () => {
  const f = fixture(), feed = f.make();
  f.titles.set("old", title("old")); await feed.prepare(); assert.deepEqual(await feed.list(), []);
  for (const type of ["manga", "manhwa", "manhua", "oel"]) f.titles.set(type, title(type, type, [chapter("c2", "2026-01-03T00:00:00Z")]));
  await feed.prepare(); const events = await feed.list();
  assert.equal(events.length, 4); assert.deepEqual(events.map(e => e.channelId).sort(), ["11", "12", "13", "14"]);
  assert.equal(events[0].summary, "Source synopsis"); assert.deepEqual(events[0].tags, ["Action"]);
  assert.match(events[0].readerUrl, /\/reader\//); assert.equal(events[0].chapters[0].label, "Chapter 2");
});

test("complete pagination and more than 500 checkpoints do not drop overflow or replay old entries", async () => {
  const f = fixture(), feed = f.make();
  for (let i = 0; i < 520; i++) f.titles.set(`t${i}`, title(`t${i}`));
  await feed.prepare(); assert.equal(f.records.size, 521); assert.deepEqual(await feed.list(), []);
  for (let i = 0; i < 25; i++) f.titles.set(`new${i}`, title(`new${i}`, "manga", [chapter("c1", "2026-01-03T00:00:00Z")]));
  await feed.prepare(); const ids = new Set();
  while ((await feed.list()).length) for (const event of await feed.list()) {
    assert.equal(ids.has(event.id), false); ids.add(event.id);
    await feed.begin(event.id); await feed.record(event.id, {messageId: String(100 + ids.size), channelId: "11"}); await feed.acknowledge(event.id);
  }
  assert.equal(ids.size, 25); await f.make().prepare(); assert.deepEqual(await feed.list(), []);
});

test("incomplete pagination never establishes the baseline", async () => {
  const f = fixture(); for (let i = 0; i < 101; i++) f.titles.set(String(i), title(String(i)));
  f.breakPages(); await assert.rejects(f.make().prepare(), /pagination repeated/); assert.equal(f.writes(), 0);
});

test("read-only polling, concurrent claims and acknowledgement failure preserve the accepted message", async () => {
  const f = fixture(), feed = f.make(); await feed.prepare();
  f.titles.set("new", title("new", "manga", [chapter("c1", "2026-01-03T00:00:00Z")])); await feed.prepare();
  const event = (await feed.list())[0], count = f.writes(); await feed.list(); await feed.list(); assert.equal(f.writes(), count);
  const [a, b] = await Promise.all([feed.begin(event.id), feed.begin(event.id)]); assert.equal(a.nonce, b.nonce); assert.ok(a.nonce.length <= 25);
  await assert.rejects(feed.acknowledge(event.id), /Record the accepted/);
  await assert.rejects(feed.record(event.id, {messageId: "123", channelId: "wrong"}), /match this event/);
  await feed.record(event.id, {messageId: "123", channelId: "11"});
  f.advance(); const recovered = await f.make().begin(event.id); assert.equal(recovered.messageId, "123"); assert.equal(recovered.phase, "sent");
  await f.make().acknowledge(event.id); await feed.acknowledge(event.id); assert.deepEqual(await feed.list(), []);
});

test("new titles wait for complete WebP; append announcements contain only unacknowledged ready chapters", async () => {
  const f = fixture(), feed = f.make(); f.titles.set("old", title("old")); await feed.prepare();
  const added = chapter("c2", "2026-01-03T00:00:00Z");
  f.titles.set("old", {...title("old", "manga", [chapter("c1"), added]), updatedAt: "2026-01-03T00:00:00Z"});
  const pending = {...title("new", "manhua", [added]), ingestStatus: "pending", chapterCount: 2}; f.titles.set("new", pending);
  await feed.prepare(); const event = (await feed.list())[0]; assert.equal(event.kind, "chapters"); assert.deepEqual(event.chapters.map(c => c.id), ["c2"]);
  pending.chapters.push({...chapter("c3", "2026-01-03T00:00:00Z"), segmentsReady: false}); pending.ingestStatus = "ready";
  await feed.prepare(); assert.equal((await feed.list()).length, 1);
  pending.chapters[1].segmentsReady = true; await feed.prepare(); assert.equal((await feed.list()).length, 2);
});

test("an old unknown send is durable and blocked until reconciled", async () => {
  const f = fixture(), feed = f.make(); await feed.prepare(); f.titles.set("new", title("new", "manga", [chapter("c1", "2026-01-03T00:00:00Z")]));
  await feed.prepare(); const {id} = (await feed.list())[0]; await feed.begin(id); f.advance();
  assert.equal((await f.make().begin(id)).phase, "ambiguous"); assert.equal((await feed.list())[0].id, id);
  await feed.record(id, {messageId: "124", channelId: "11"}); await feed.acknowledge(id); assert.deepEqual(await feed.list(), []);
});

test("over 500 receipts survive restarts and stale acknowledgements cannot consume another chapter event", async () => {
  const f = fixture(), feed = f.make(); await feed.prepare();
  const book = title("serial", "manga", []); f.titles.set("serial", book); let first;
  for (let i = 1; i <= 505; i++) {
    book.chapters.push(chapter(`c${i}`, "2026-01-03T00:00:00Z")); book.chapterCount = i; book.ingestedChapterCount = i;
    book.updatedAt = new Date(Date.parse("2026-01-03T00:00:00Z") + i * 1000).toISOString();
    await feed.prepare(); const event = (await feed.list())[0]; first ||= event.id;
    await feed.begin(event.id); await feed.record(event.id, {messageId: String(1000 + i), channelId: "11"});
    if (i === 505) {
      assert.equal((await f.make().begin(first)).phase, "acknowledged"); await feed.acknowledge(first);
      assert.equal((await feed.list())[0].id, event.id); assert.equal((await feed.list())[0].delivery.phase, "sent");
    }
    await feed.acknowledge(event.id);
  }
  assert.equal([...f.records.values()].filter(j => j.kind === "portal-release-receipt").length, 505);
  await f.make().prepare(); assert.deepEqual(await feed.list(), []);
});
