import test from "node:test";
import assert from "node:assert/strict";

import {
  describeFailureRecord,
  findDisposition,
  penaltyForCandidate,
  searchOverridesForQuery,
} from "../worker/src/failure_corpus.js";

test("exact reject_search disposition wins over broader allow_build host match", () => {
  const disposition = findDisposition(
    "Geometry Dash",
    "https://geometrydashfullversion.io/search?q=%7Bsearch_term_string%7D",
  );
  assert.ok(disposition);
  assert.equal(disposition.action, "reject_search");
  assert.equal(disposition.match_type, "exact");
});

test("allow_build Geometry Dash seed stays searchable with history metadata", () => {
  const description = describeFailureRecord("Geometry Dash", "https://geometrydash-lite.io/");
  assert.equal(description.buildDisposition, "allow_build");
  assert.equal(description.historyStatus, "known_cancelled");
  assert.match(description.historySummary, /localized runtime assets/i);
  assert.equal(penaltyForCandidate("Geometry Dash", "https://geometrydash-lite.io/"), 0);
});

test("known failed sources are penalized when not explicitly allowed", () => {
  const description = describeFailureRecord("starblast", "https://www.google-analytics.com/");
  assert.equal(description.buildDisposition, "reject_search");
  assert.equal(description.historyStatus, "known_failed");
  assert.ok(penaltyForCandidate("starblast", "https://www.google-analytics.com/") >= 160);
});

test("preferred search seeds come from the disposition manifest", () => {
  const overrides = searchOverridesForQuery("realistic car simulator");
  assert.deepEqual(
    overrides.map((entry) => entry.url),
    [
      "https://www.madkidgames.com/game/car-racing-realistic-car-simulator",
      "https://www.madkidgames.com/game/ultimate-car-driving-simulator",
      "https://www.madkidgames.com/game/carquest-open-world-racing",
    ],
  );
});
