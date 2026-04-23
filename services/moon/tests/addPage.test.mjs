import test from "node:test";
import assert from "node:assert/strict";

const {renderAddPage} = await import("../apps/admin/assets/pages/addPage.js");

test("admin add-title metadata cards render cover art when coverUrl is present", () => {
  const html = renderAddPage({
    ok: true,
    query: "slime",
    payload: {
      results: [{
        title: "Slime Saint",
        provider: "mangadex",
        providerName: "MangaDex",
        providerSeriesId: "series-1",
        type: "manga",
        summary: "A sample summary.",
        coverUrl: "https://uploads.mangadex.org/covers/series-1/cover.jpg.512.jpg",
        tags: ["Fantasy"],
        aliases: ["Sample Alias"],
        url: "https://mangadex.org/title/series-1"
      }]
    }
  });

  assert.match(html, /<img src="https:\/\/uploads\.mangadex\.org\/covers\/series-1\/cover\.jpg\.512\.jpg"/);
  assert.doesNotMatch(html, /cover-thumb is-empty/);
});
