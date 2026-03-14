from __future__ import annotations

import unittest

from tools.failure_corpus import FailureEvent, build_failure_index, normalize_search_text, normalize_source_url


class FailureCorpusTest(unittest.TestCase):
    def test_normalize_source_url_trims_trailing_slashes_and_fragments(self) -> None:
        self.assertEqual(
            normalize_source_url("https://Example.com/game///?a=1#fragment"),
            "https://example.com/game?a=1",
        )

    def test_build_failure_index_groups_events_by_normalized_source(self) -> None:
        events = [
            FailureEvent(
                request_id="one",
                display_name="Geometry Dash Lite",
                source_url="https://geometrydash-lite.io/",
                normalized_source_url="https://geometrydash-lite.io/",
                query="Geometry Dash",
                normalized_query=normalize_search_text("Geometry Dash"),
                history_status="known_cancelled",
                error="cancelled",
                detail_path="reports/failed-builds/one.txt",
                source_mode="verified-search",
                candidate_reason="matched verified override",
                logged_at="2026-03-14T00:00:00Z",
            ),
            FailureEvent(
                request_id="two",
                display_name="Geometry Dash Lite",
                source_url="https://geometrydash-lite.io",
                normalized_source_url="https://geometrydash-lite.io/",
                query="Geometry Dash Lite",
                normalized_query=normalize_search_text("Geometry Dash Lite"),
                history_status="known_failed",
                error="failure",
                detail_path="reports/failed-builds/two.txt",
                source_mode="verified-search",
                candidate_reason="matched verified override",
                logged_at="2026-03-14T01:00:00Z",
            ),
        ]

        index = build_failure_index(events)
        self.assertEqual(index["entry_count"], 1)
        self.assertEqual(index["event_count"], 2)
        entry = index["entries"][0]
        self.assertEqual(entry["source_url"], "https://geometrydash-lite.io/")
        self.assertEqual(entry["history_counts"]["known_cancelled"], 1)
        self.assertEqual(entry["history_counts"]["known_failed"], 1)
        self.assertEqual(entry["queries"], ["geometry dash", "geometry dash lite"])
