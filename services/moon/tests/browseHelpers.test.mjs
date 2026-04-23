import test from "node:test";
import assert from "node:assert/strict";

import {
  BROWSE_LETTERS,
  buildBrowseLetterState,
  buildBrowseSections,
  filterBrowseTitles
} from "../apps/user-next/lib/browse.js";

test("filterBrowseTitles sorts alphabetically and matches across title metadata", () => {
  const titles = [
    {id: "3", title: "Zom 100", summary: "Apocalypse comedy", tags: ["zombies"], libraryTypeSlug: "manga"},
    {id: "1", title: "Bleach", summary: "Soul reaper action", aliases: ["Burichi"]},
    {id: "2", title: "Akane-banashi", summary: "Rakugo drama", libraryTypeLabel: "Manga"}
  ];

  assert.deepEqual(
    filterBrowseTitles(titles, "").map((title) => title.title),
    ["Akane-banashi", "Bleach", "Zom 100"]
  );

  assert.deepEqual(
    filterBrowseTitles(titles, "burichi").map((title) => title.title),
    ["Bleach"]
  );

  assert.deepEqual(
    filterBrowseTitles(titles, "zombies").map((title) => title.title),
    ["Zom 100"]
  );

  assert.deepEqual(
    filterBrowseTitles(titles, "manga").map((title) => title.title),
    ["Akane-banashi", "Zom 100"]
  );
});

test("filterBrowseTitles ignores summary-only matches", () => {
  const titles = [
    {id: "1", title: "Bleach", summary: "Soul reaper action"},
    {id: "2", title: "Akane-banashi", summary: "Rakugo drama"}
  ];

  assert.deepEqual(
    filterBrowseTitles(titles, "reaper").map((title) => title.title),
    []
  );
});

test("buildBrowseSections returns a flat alphabetical set of visible sections", () => {
  const sections = buildBrowseSections([
    {id: "1", title: "Bleach"},
    {id: "2", title: "Akane-banashi"},
    {id: "3", title: "20th Century Boys"},
    {id: "4", title: "Dandadan"}
  ]);

  assert.deepEqual(
    sections.map((section) => section.letter),
    ["A", "B", "D", "T"]
  );

  assert.deepEqual(
    sections.find((section) => section.letter === "A")?.titles.map((title) => title.title),
    ["Akane-banashi"]
  );
});

test("buildBrowseLetterState keeps the full A-Z rail stable while disabling empty letters", () => {
  const state = buildBrowseLetterState([
    {id: "1", title: "Bleach"},
    {id: "2", title: "Dandadan"}
  ]);

  assert.equal(state.length, BROWSE_LETTERS.length);
  assert.equal(state.find((entry) => entry.letter === "B")?.disabled, false);
  assert.equal(state.find((entry) => entry.letter === "D")?.disabled, false);
  assert.equal(state.find((entry) => entry.letter === "A")?.disabled, true);
  assert.equal(state.find((entry) => entry.letter === "Z")?.disabled, true);
});
