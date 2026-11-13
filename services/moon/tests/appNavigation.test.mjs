/** @file Reader/admin navigation must leave the user application's client router. */
import test from "node:test";
import assert from "node:assert/strict";
import {crossesAppBoundary} from "../apps/user-next/lib/appNavigation.js";

test("reader and admin destinations cross the embedded application boundary", () => {
  for (const href of ["/reader", "/reader/manhua/title/chapter?rev=webp-1", "/reader#resume", "/admin", "/admin/wanted/missing-content"])
    assert.equal(crossesAppBoundary(href), true, href);
  for (const href of ["/library", "/title/manhua/title", "/readerish", "/administrator", "/library?q=/reader/", "//other.example/reader", undefined])
    assert.equal(crossesAppBoundary(href), false, String(href));
});
