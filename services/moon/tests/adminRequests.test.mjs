import assert from "node:assert/strict";
import test from "node:test";

import {
  bulkDenyCandidates,
  bulkRefreshCandidates,
  buildRequestCounts,
  filterRequests,
  requestActionMessage,
  requestActionState,
  requestNextActionLabel,
  requestNeedsReview,
  resolveExistingRequestSelection,
  selectSingleDownloadOption,
  withEffectiveRequestSelection
} from "../apps/admin-next/lib/adminRequests.js";

test("admin request helpers classify review and status counts", () => {
  const requests = [
    {id: "1", status: "pending", details: {selectedDownload: null}, tab: "active"},
    {id: "2", status: "pending", details: {selectedDownload: {titleUrl: "https://source"}}, tab: "active"},
    {id: "3", status: "unavailable", details: {waitlist: [{discordUserId: "reader"}]}, waitlistCount: 1, tab: "active"},
    {id: "4", status: "completed", tab: "completed"},
    {id: "5", status: "denied", tab: "closed"}
  ];

  const counts = buildRequestCounts(requests);

  assert.equal(requestNeedsReview(requests[0]), true);
  assert.equal(requestNeedsReview(requests[1]), false);
  assert.equal(counts.needsReview, 2);
  assert.equal(counts.active, 3);
  assert.equal(counts.completed, 1);
  assert.equal(counts.closed, 1);
  assert.equal(counts.waitlisted, 1);
});

test("admin request helpers filter by tab and query", () => {
  const requests = [
    {id: "1", title: "Dandadan", status: "pending", requestedBy: {username: "Pax"}, details: {selectedDownload: null}},
    {id: "2", title: "One Piece", status: "completed", requestedBy: {username: "Reader"}, details: {selectedDownload: {providerId: "weebcentral"}}}
  ];

  assert.deepEqual(filterRequests(requests, {tab: "needsReview", query: "pax"}).map((entry) => entry.id), ["1"]);
  assert.deepEqual(filterRequests(requests, {tab: "completed", query: "weeb"}).map((entry) => entry.id), ["2"]);
});

test("admin request action state follows grants and request status", () => {
  const request = {
    status: "pending",
    details: {
      selectedMetadata: {provider: "mangadex"},
      selectedDownload: {titleUrl: "https://source"}
    }
  };

  assert.equal(requestActionState(request, {canWrite: true}).canApprove, true);
  assert.equal(requestActionState(request, {canWrite: false}).canApprove, false);
  assert.equal(requestActionState(request, {canRoot: true}).canOverride, true);
});

test("admin request action state honors local resolver source picks", () => {
  const request = {
    status: "pending",
    details: {
      selectedMetadata: {provider: "mangadex"},
      selectedDownload: null
    }
  };
  const pickedDownload = {providerId: "weebcentral", titleUrl: "https://source"};
  const effective = withEffectiveRequestSelection(request, {selectedDownload: pickedDownload});
  const actions = requestActionState(request, {canWrite: true, selectedDownload: pickedDownload});

  assert.equal(effective.details.selectedDownload.titleUrl, "https://source");
  assert.equal(actions.canApprove, true);
  assert.equal(requestNextActionLabel(effective, actions), "Ready to approve and queue");
});

test("admin request helpers auto-select exactly one concrete source", () => {
  const first = {providerId: "weebcentral", titleUrl: "https://source/1"};
  const second = {providerId: "weebcentral", titleUrl: "https://source/2"};

  assert.equal(selectSingleDownloadOption([first]), first);
  assert.equal(selectSingleDownloadOption([first, second]), null);
  assert.equal(selectSingleDownloadOption([{providerId: "empty"}]), null);
  assert.equal(selectSingleDownloadOption([first, second], second), second);
});

test("admin request helper formats conflict action failures", () => {
  assert.match(
    requestActionMessage("Approve", {status: 409, payload: {code: "REQUEST_REVISION_CONFLICT"}}),
    /changed while you were reviewing/i
  );
  assert.match(
    requestActionMessage("Resolve", {status: 409, payload: {code: "REQUEST_WORK_KEY_CONFLICT", requestId: "42"}}),
    /Matching request: 42/
  );
});

test("admin request selection helper never auto-opens first request", () => {
  const requests = [{id: "first"}, {id: "second"}];

  assert.equal(resolveExistingRequestSelection(requests, ""), "");
  assert.equal(resolveExistingRequestSelection(requests, "second"), "second");
  assert.equal(resolveExistingRequestSelection(requests, "missing"), "");
});

test("admin request bulk helpers only include safe eligible rows", () => {
  const requests = [
    {id: "1", status: "pending", details: {selectedMetadata: {provider: "mangadex"}, selectedDownload: null}},
    {id: "2", status: "pending", details: {selectedMetadata: {}, selectedDownload: {titleUrl: "https://source"}}},
    {id: "3", status: "completed", details: {selectedMetadata: {provider: "mangadex"}}}
  ];

  assert.deepEqual(bulkRefreshCandidates(requests, {canWrite: true}).map((entry) => entry.id), ["1"]);
  assert.deepEqual(bulkDenyCandidates(requests, {canWrite: true}).map((entry) => entry.id), ["1", "2"]);
  assert.deepEqual(bulkRefreshCandidates(requests, {canWrite: false}).map((entry) => entry.id), []);
});
