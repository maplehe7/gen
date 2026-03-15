import test from "node:test";
import assert from "node:assert/strict";

import {
  bucketReviewCandidates,
  dashboardSnapshot,
  initialDispatchSubset,
  initialSelectedCandidateKeys,
  isCancelableJob,
  normalizeSelectedCandidateKeys,
  splitBatchCancellationJobs,
} from "../site/dashboard_helpers.js";

test("initialSelectedCandidateKeys preselects the highest ranked selectable candidates", () => {
  const keys = initialSelectedCandidateKeys(
    [
      { sourceUrl: "https://one.example/", buildDisposition: "allow_build" },
      { sourceUrl: "https://two.example/", buildDisposition: "unknown" },
      { sourceUrl: "https://bad.example/", buildDisposition: "reject_search" },
    ],
    2,
  );
  assert.deepEqual(keys, ["one.example/", "two.example/"]);
});

test("normalizeSelectedCandidateKeys falls back to top candidates when selection is missing", () => {
  const selection = {
    desiredSuccessCount: 2,
    candidatePool: [
      { sourceUrl: "https://one.example/", buildDisposition: "allow_build" },
      { sourceUrl: "https://two.example/", buildDisposition: "unknown" },
    ],
  };
  assert.deepEqual(normalizeSelectedCandidateKeys(selection), ["one.example/", "two.example/"]);
});

test("bucketReviewCandidates separates recommended, buildable, and risky candidates", () => {
  const buckets = bucketReviewCandidates([
    { sourceUrl: "https://one.example/", confidence: 92, historyStatus: "unknown", buildDisposition: "allow_build" },
    { sourceUrl: "https://two.example/", confidence: 88, historyStatus: "unknown", buildDisposition: "unknown" },
    { sourceUrl: "https://three.example/", confidence: 52, historyStatus: "known_cancelled", buildDisposition: "unknown" },
  ]);

  assert.equal(buckets.recommended.length, 1);
  assert.equal(buckets.buildable.length, 1);
  assert.equal(buckets.risky.length, 1);
});

test("isCancelableJob keeps cancel visible for non-terminal jobs until cancellation begins", () => {
  assert.equal(isCancelableJob({ status: "queued" }), true);
  assert.equal(isCancelableJob({ status: "in_progress" }), true);
  assert.equal(isCancelableJob({ status: "queued", cancelPending: true }), false);
  assert.equal(isCancelableJob({ status: "completed", conclusion: "cancelled" }), false);
});

test("splitBatchCancellationJobs separates remote and local-only jobs", () => {
  const result = splitBatchCancellationJobs([
    { requestId: "1", status: "queued", runId: "" },
    { requestId: "2", status: "in_progress", runId: "123" },
    { requestId: "3", status: "completed", conclusion: "success", runId: "456" },
  ]);

  assert.equal(result.local.length, 1);
  assert.equal(result.remote.length, 1);
  assert.equal(result.remote[0].requestId, "2");
});

test("dashboardSnapshot reports review counts alongside active jobs", () => {
  const snapshot = dashboardSnapshot(
    [{ status: "queued" }, { status: "completed", conclusion: "success" }],
    {
      first: {
        state: "review",
        candidatePool: [{ sourceUrl: "https://one.example/" }],
        selectedCandidateKeys: ["one.example/"],
      },
    },
    Date.parse("2026-03-14T10:15:00Z"),
  );

  assert.equal(snapshot.activeJobCount, 1);
  assert.equal(snapshot.reviewBatchCount, 1);
  assert.equal(snapshot.selectedCandidateCount, 1);
  assert.match(snapshot.refreshText, /Refreshed/);
});

test("initialDispatchSubset throttles selected candidates to the active runner limit", () => {
  const initial = initialDispatchSubset(
    [
      { sourceUrl: "https://one.example/" },
      { sourceUrl: "https://two.example/" },
      { sourceUrl: "https://three.example/" },
    ],
    1,
  );

  assert.equal(initial.length, 1);
  assert.equal(initial[0].sourceUrl, "https://one.example/");
});
