import assert from "node:assert/strict";
import test from "node:test";

import {
  chapterCoveragePercent,
  filterMetadataRows,
  filterMissingChapterRows,
  metadataGapText,
  missingChapterCount,
  resolveExistingTitleSelection
} from "../apps/admin-next/lib/adminWanted.js";

test("wanted metadata helpers filter by gap and query", () => {
  const titles = [
    {id: "a", title: "Dandadan", gaps: ["summary", "tags"], tags: [], aliases: ["Dan Da Dan"]},
    {id: "b", title: "One Piece", gaps: ["provider"], metadataProvider: ""}
  ];

  assert.equal(metadataGapText(["summary", "tags"]), "Summary, Tags");
  assert.deepEqual(filterMetadataRows(titles, {gap: "summary"}).map((entry) => entry.id), ["a"]);
  assert.deepEqual(filterMetadataRows(titles, {query: "piece"}).map((entry) => entry.id), ["b"]);
});

test("wanted missing chapter helpers calculate coverage and filters", () => {
  const titles = [
    {id: "a", title: "Gap", chapterCount: 10, chaptersDownloaded: 4},
    {id: "b", title: "Complete", chapterCount: 2, chaptersDownloaded: 2}
  ];

  assert.equal(missingChapterCount(titles[0]), 6);
  assert.equal(chapterCoveragePercent(titles[0]), 40);
  assert.deepEqual(filterMissingChapterRows(titles, {query: "gap"}).map((entry) => entry.id), ["a"]);
});

test("wanted title selection helper never auto-opens first title", () => {
  const titles = [{id: "first"}, {id: "second"}];

  assert.equal(resolveExistingTitleSelection(titles, ""), "");
  assert.equal(resolveExistingTitleSelection(titles, "second"), "second");
  assert.equal(resolveExistingTitleSelection(titles, "missing"), "");
});
