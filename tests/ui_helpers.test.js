import test from "node:test";
import assert from "node:assert/strict";

import { buildCandidateBadges, buildJobErrorSummary, filterGalleryEntries } from "../site/ui_helpers.js";

test("buildCandidateBadges exposes buildability and failure history", () => {
  const badges = buildCandidateBadges({
    buildDisposition: "allow_build",
    historyStatus: "known_cancelled",
    provider: "override",
  });
  assert.deepEqual(
    badges.map((badge) => badge.label),
    ["Buildable", "Known cancelled", "Verified seed"],
  );
});

test("buildJobErrorSummary combines explicit failures with historical guidance", () => {
  const summary = buildJobErrorSummary({
    error: "Workflow finished with conclusion: failure",
    historySummary: "Previously seen 2 failed for geometry dash.",
  });
  assert.match(summary, /Workflow finished/);
  assert.match(summary, /Previously seen 2 failed/);
});

test("filterGalleryEntries matches title, host, folder, and generated date", () => {
  const entries = [
    {
      title: "Geometry Dash Lite",
      id: "geometrydash-lite",
      folder: "games/geometrydash-lite",
      source_url: "https://geometrydash-lite.io/",
      generated_at: "2026-03-14T16:34:20Z",
    },
    {
      title: "Drift Boss",
      id: "drift-boss",
      folder: "games/drift-boss",
      source_url: "https://driftboss.game/drift-boss/",
      generated_at: "2026-03-14T05:00:00Z",
    },
  ];

  assert.equal(filterGalleryEntries(entries, "geometrydash-lite.io").length, 1);
  assert.equal(filterGalleryEntries(entries, "games/drift-boss").length, 1);
  assert.equal(filterGalleryEntries(entries, "2026-03-14").length, 2);
});
