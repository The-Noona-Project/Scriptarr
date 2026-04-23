import test from "node:test";
import assert from "node:assert/strict";

const {renderRequestsPage} = await import("../apps/admin/assets/pages/requestsPage.js");

test("admin requests page embeds parseable JSON for client enhancement", () => {
  const html = renderRequestsPage({
    ok: true,
    payload: {
      requests: [{
        id: "request-1",
        title: "Naruto",
        status: "pending",
        requestType: "manga",
        availability: "review",
        updatedAt: "2026-04-22T12:00:00.000Z",
        notes: "Check the exact metadata match.",
        requestedBy: {
          username: "CaptainPax",
          discordUserId: "1234"
        },
        details: {
          selectedMetadata: {
            title: "Naruto",
            providerName: "AniList",
            tags: ["Shonen", "Ninja"],
            aliases: ["NARUTO"]
          }
        }
      }]
    }
  });

  const jsonMatch = html.match(/<script type="application\/json" id="admin-requests-data">([\s\S]*?)<\/script>/i);
  assert.ok(jsonMatch, "expected admin request payload script tag");

  const embedded = jsonMatch[1];
  assert.doesNotMatch(embedded, /&quot;/, "embedded request payload should not HTML-escape quotes");

  const parsed = JSON.parse(embedded);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "Naruto");
  assert.deepEqual(parsed[0].details.selectedMetadata.tags, ["Shonen", "Ninja"]);
});
