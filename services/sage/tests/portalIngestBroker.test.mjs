/**
 * @file Tests for Portal-facing library ingest broker helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {buildPortalIngestRunPayload} from "../lib/portalIngestBroker.mjs";

test("portal ingest run payload defaults missing requesters to owner Discord id", () => {
  assert.deepEqual(
    buildPortalIngestRunPayload({source: "discord-appa-slash"}, {
      libraryTypeSlug: "Manhwa",
      fallbackRequestedBy: "owner-1"
    }),
    {
      source: "discord-appa-slash",
      type: "manhwa",
      libraryTypeSlug: "manhwa",
      requestedBy: "owner-1"
    }
  );
});

test("portal ingest run payload preserves explicit Discord requester", () => {
  assert.equal(
    buildPortalIngestRunPayload({requestedBy: "admin-1"}, {
      libraryTypeSlug: "oel",
      fallbackRequestedBy: "owner-1"
    }).requestedBy,
    "admin-1"
  );
});
