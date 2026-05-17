import assert from "node:assert/strict";
import test from "node:test";

import {mergePagedTitleRows} from "../apps/user-next/lib/titleList.js";

test("paged title rows append in server order and drop duplicate ids", () => {
  const merged = mergePagedTitleRows(
    [
      {id: "a", title: "Alpha"},
      {id: "b", title: "Beta"}
    ],
    [
      {id: "b", title: "Beta duplicate"},
      {id: "c", title: "Gamma"}
    ]
  );

  assert.deepEqual(merged.map((row) => row.title), ["Alpha", "Beta", "Gamma"]);
});

test("paged title rows replace old query results without carrying stale ids", () => {
  const merged = mergePagedTitleRows(
    [{id: "old", title: "Old Result"}],
    [
      {id: "new", title: "New Result"},
      {id: "new", title: "New Result Duplicate"}
    ],
    {append: false}
  );

  assert.deepEqual(merged, [{id: "new", title: "New Result"}]);
});

test("paged title rows preserve rows without ids because they cannot be safely de-duped", () => {
  const merged = mergePagedTitleRows([{title: "Unknown"}], [{title: "Unknown"}]);

  assert.equal(merged.length, 2);
});
