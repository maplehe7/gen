from __future__ import annotations

import json
import unittest
from pathlib import Path
from urllib.parse import urlparse

from tools.failure_corpus import ROOT, normalize_search_text, normalize_source_url


def disposition_matches(entry: dict[str, object], query: str, source_url: str) -> bool:
    normalized_query = normalize_search_text(query)
    normalized_source = normalize_source_url(source_url)
    candidate_queries = [normalize_search_text(value) for value in entry.get("queries", [])]
    if candidate_queries and normalized_query not in candidate_queries:
        return False

    normalized_entry_source = normalize_source_url(str(entry.get("source_url", "")))
    if str(entry.get("match_type", "")) == "exact":
        return normalized_entry_source == normalized_source

    if str(entry.get("match_type", "")) == "host":
        entry_host = urlparse(normalized_entry_source).hostname or ""
        source_host = urlparse(normalized_source).hostname or ""
        return source_host == entry_host or source_host.endswith(f".{entry_host}")

    return False


class DispositionAuditTest(unittest.TestCase):
    def test_every_failed_build_entry_has_an_explicit_disposition(self) -> None:
        index = json.loads((ROOT / "reports" / "failed-builds-index.json").read_text(encoding="utf-8"))
        manifest = json.loads((ROOT / "reports" / "failed-build-dispositions.json").read_text(encoding="utf-8"))
        manifest_entries = manifest["entries"]

        missing: list[str] = []
        for entry in index["entries"]:
            source_url = entry["source_url"]
            queries = entry.get("queries") or [""]
            if not any(
                disposition_matches(candidate, query, source_url)
                for query in queries
                for candidate in manifest_entries
            ):
                missing.append(f"{source_url} ({', '.join(queries)})")

        self.assertEqual(missing, [], f"Missing dispositions: {missing}")
