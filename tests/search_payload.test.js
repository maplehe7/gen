import test from "node:test";
import assert from "node:assert/strict";

import { buildSearchPayload, summarizeSuppressedCandidate } from "../worker/src/search_payload.js";

test("buildSearchPayload keeps ranked candidates and suppressed diagnostics in multi-result mode", () => {
  const payload = buildSearchPayload(
    "geometry dash",
    {
      candidates: [
        {
          query: "geometry dash",
          sourceUrl: "https://geometrydash-lite.io/",
          displayName: "Geometry Dash Lite",
          provider: "override",
          confidence: 91,
          hostedOnline: true,
          reason: "matched verified override",
          buildDisposition: "allow_build",
          historyStatus: "known_cancelled",
          historySummary: "Probe/export verification marked this source buildable.",
        },
      ],
      suppressed: [
        {
          sourceUrl: "https://geometrydashfullversion.io/search?q=term",
          displayName: "Geometry Dash Search",
          provider: "web-search",
          buildDisposition: "reject_search",
          historyStatus: "known_failed",
          historySummary: "Previously seen 3 failed for geometry dash.",
          reason: "known rejected source",
        },
      ],
      alternatives: ["Geometry Dash"],
    },
    3,
  );

  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.suppressed.length, 1);
  assert.equal(payload.suppressed[0].rejectionReason, "known rejected source");
});

test("summarizeSuppressedCandidate produces stable diagnostics fields", () => {
  const summary = summarizeSuppressedCandidate({
    sourceUrl: "https://bad.example/search",
    displayName: "Bad Search Page",
    provider: "web-search",
    buildDisposition: "reject_search",
    historyStatus: "known_failed",
    historySummary: "Previously seen 1 failed.",
    reason: "analytics or search endpoint",
  });

  assert.deepEqual(summary, {
    sourceUrl: "https://bad.example/search",
    displayName: "Bad Search Page",
    provider: "web-search",
    buildDisposition: "reject_search",
    historyStatus: "known_failed",
    historySummary: "Previously seen 1 failed.",
    rejectionReason: "analytics or search endpoint",
  });
});
