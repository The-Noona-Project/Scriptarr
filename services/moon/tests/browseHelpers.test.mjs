import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSE_LETTERS,
  BROWSE_PAGE_SIZE,
  buildBrowseApiUrl,
  buildBrowseLetterState,
  buildBrowsePageUrl,
  buildBrowseSections,
  normalizeBrowseSearchParams,
  resolveBrowseLetter,
  sortBrowseTitles
} from "../apps/user-next/lib/browse.js";

test("sortBrowseTitles sorts alphabetically without client-side filtering", () => {
  const titles = [
    {id: "3", title: "Zom 100", summary: "Apocalypse comedy", tags: ["zombies"], libraryTypeSlug: "manga"},
    {id: "1", title: "Bleach", summary: "Soul reaper action", aliases: ["Burichi"]},
    {id: "2", title: "Akane-banashi", summary: "Rakugo drama", libraryTypeLabel: "Manga"}
  ];

  assert.deepEqual(
    sortBrowseTitles(titles).map((title) => title.title),
    ["Akane-banashi", "Bleach", "Zom 100"]
  );
});

test("buildBrowseSections returns a flat alphabetical set with a # bucket", () => {
  const sections = buildBrowseSections([
    {id: "1", title: "Bleach"},
    {id: "2", title: "Akane-banashi"},
    {id: "3", title: "20th Century Boys"},
    {id: "4", title: "Dandadan"}
  ]);

  assert.deepEqual(
    sections.map((section) => section.letter),
    ["#", "A", "B", "D"]
  );

  assert.equal(resolveBrowseLetter({title: "20th Century Boys"}), "#");
  assert.deepEqual(
    sections.find((section) => section.letter === "A")?.titles.map((title) => title.title),
    ["Akane-banashi"]
  );
});

test("buildBrowseLetterState keeps the full # plus A-Z rail stable while disabling empty letters", () => {
  const state = buildBrowseLetterState([
    {id: "1", title: "Bleach"},
    {id: "2", title: "20th Century Boys"},
    {id: "2", title: "Dandadan"}
  ]);

  assert.equal(state.length, BROWSE_LETTERS.length);
  assert.equal(state.find((entry) => entry.letter === "#")?.disabled, false);
  assert.equal(state.find((entry) => entry.letter === "B")?.disabled, false);
  assert.equal(state.find((entry) => entry.letter === "D")?.disabled, false);
  assert.equal(state.find((entry) => entry.letter === "A")?.disabled, true);
  assert.equal(state.find((entry) => entry.letter === "Z")?.disabled, true);
});

test("browse URLs preserve global search, explicit filters, and compact card API params", () => {
  const parsed = normalizeBrowseSearchParams(new URLSearchParams("q=solo&type=Manhwa&letter=%23"));
  assert.deepEqual(parsed, {query: "solo", type: "manhwa", letter: "#"});
  assert.equal(buildBrowsePageUrl(parsed), "/browse?q=solo&type=manhwa&letter=%23");
  assert.equal(
    buildBrowseApiUrl(parsed),
    `/api/moon-v3/user/library?view=card&pageSize=${BROWSE_PAGE_SIZE}&q=solo&type=manhwa&letter=%23`
  );
  assert.equal(
    buildBrowseApiUrl({query: "bleach", type: "all", letter: ""}),
    `/api/moon-v3/user/library?view=card&pageSize=${BROWSE_PAGE_SIZE}&q=bleach`
  );
});
