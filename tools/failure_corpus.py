from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
FAILED_BUILDS_FILE = ROOT / "reports" / "failed-builds.txt"
FAILED_BUILD_DETAILS_DIR = ROOT / "reports" / "failed-builds"
INDEX_OUTPUT_FILE = ROOT / "reports" / "failed-builds-index.json"

SUMMARY_PATTERN = re.compile(
    r"^(?P<logged_at>\S+)\s+\|\s+"
    r"request_id=(?P<request_id>[^|]+?)\s+\|\s+"
    r"display_name=(?P<display_name>[^|]+?)\s+\|\s+"
    r"source_url=(?P<source_url>[^|]+?)\s+\|\s+"
    r"run_id=(?P<run_id>[^|]+?)\s+\|\s+"
    r"error=(?P<error>[^|]+?)\s+\|\s+"
    r"detail_path=(?P<detail_path>.+?)\s*$"
)


def collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_search_text(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())
    return collapse_whitespace(normalized)


def normalize_source_url(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if re.match(r"^[a-z][a-z0-9+\-.]*://", raw, re.IGNORECASE) is None:
        raw = f"https://{raw}"

    parts = urlsplit(raw)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return ""

    hostname = parts.hostname.lower() if parts.hostname else ""
    port = parts.port
    if (parts.scheme == "http" and port == 80) or (parts.scheme == "https" and port == 443):
        port = None
    netloc = hostname if not port else f"{hostname}:{port}"

    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if not path.startswith("/"):
        path = f"/{path}"
    if path != "/":
        path = path.rstrip("/")
    if not path:
        path = "/"

    query_pairs = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)]
    query = urlencode(query_pairs, doseq=True)
    return urlunsplit((parts.scheme.lower(), netloc, path, query, ""))


def classify_history_status(error_text: str) -> str:
    lowered = str(error_text or "").lower()
    if "cancelled" in lowered:
        return "known_cancelled"
    if "failure" in lowered:
        return "known_failed"
    return "unknown"


def parse_detail_log(detail_path: Path) -> Dict[str, str]:
    if not detail_path.exists():
        return {}

    data: Dict[str, str] = {}
    for line in detail_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            break
        if ": " not in line:
            continue
        key, value = line.split(": ", 1)
        data[key.strip()] = value.strip()
    return data


@dataclass
class FailureEvent:
    request_id: str
    display_name: str
    source_url: str
    normalized_source_url: str
    query: str
    normalized_query: str
    history_status: str
    error: str
    detail_path: str
    source_mode: str
    candidate_reason: str
    logged_at: str


def parse_summary_line(line: str) -> FailureEvent | None:
    match = SUMMARY_PATTERN.match(line.strip())
    if not match:
        return None

    payload = {key: collapse_whitespace(value) for key, value in match.groupdict().items()}
    detail_path = ROOT / payload["detail_path"]
    detail = parse_detail_log(detail_path)
    source_url = normalize_source_url(payload["source_url"])
    query = detail.get("source_input") or detail.get("batch_label") or payload["display_name"]
    candidate_reason = detail.get("candidate_reason", "")
    source_mode = detail.get("source_mode", "")
    return FailureEvent(
        request_id=payload["request_id"],
        display_name=payload["display_name"],
        source_url=payload["source_url"],
        normalized_source_url=source_url,
        query=query,
        normalized_query=normalize_search_text(query),
        history_status=classify_history_status(payload["error"]),
        error=payload["error"],
        detail_path=payload["detail_path"],
        source_mode=source_mode,
        candidate_reason=candidate_reason,
        logged_at=payload["logged_at"],
    )


def load_failure_events(summary_path: Path = FAILED_BUILDS_FILE) -> List[FailureEvent]:
    if not summary_path.exists():
        return []

    events: List[FailureEvent] = []
    for raw_line in summary_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        event = parse_summary_line(line)
        if event is not None and event.normalized_source_url:
            events.append(event)
    return events


def _compact_counts() -> Dict[str, int]:
    return {
        "known_failed": 0,
        "known_cancelled": 0,
        "unknown": 0,
    }


def build_failure_index(events: Iterable[FailureEvent] | None = None) -> Dict[str, object]:
    rows = list(events if events is not None else load_failure_events())
    grouped: Dict[str, Dict[str, object]] = {}

    for event in rows:
        entry = grouped.setdefault(
            event.normalized_source_url,
            {
                "source_url": event.normalized_source_url,
                "display_names": set(),
                "queries": set(),
                "history_counts": _compact_counts(),
                "source_modes": set(),
                "candidate_reasons": set(),
                "detail_paths": set(),
                "last_seen_at": event.logged_at,
            },
        )
        entry["display_names"].add(event.display_name)
        if event.normalized_query:
            entry["queries"].add(event.normalized_query)
        entry["history_counts"][event.history_status] += 1
        if event.source_mode:
            entry["source_modes"].add(event.source_mode)
        if event.candidate_reason:
            entry["candidate_reasons"].add(event.candidate_reason)
        if event.detail_path:
            entry["detail_paths"].add(event.detail_path)
        if event.logged_at > entry["last_seen_at"]:
            entry["last_seen_at"] = event.logged_at

    entries = []
    for entry in sorted(grouped.values(), key=lambda item: item["source_url"]):
        entries.append(
            {
                "source_url": entry["source_url"],
                "display_names": sorted(entry["display_names"]),
                "queries": sorted(entry["queries"]),
                "history_counts": entry["history_counts"],
                "source_modes": sorted(entry["source_modes"]),
                "candidate_reasons": sorted(entry["candidate_reasons"]),
                "detail_paths": sorted(entry["detail_paths"]),
                "last_seen_at": entry["last_seen_at"],
            }
        )

    totals = defaultdict(int)
    for event in rows:
        totals[event.history_status] += 1

    return {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": str(summary_path_relative(FAILED_BUILDS_FILE)),
        "entry_count": len(entries),
        "event_count": len(rows),
        "totals": dict(sorted(totals.items())),
        "entries": entries,
    }


def summary_path_relative(path: Path) -> Path:
    return path.resolve().relative_to(ROOT)


def write_failure_index(output_path: Path = INDEX_OUTPUT_FILE) -> Dict[str, object]:
    index = build_failure_index()
    output_path.write_text(f"{json.dumps(index, indent=2)}\n", encoding="utf-8")
    return index


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a normalized index for failed standalone builds.")
    parser.add_argument("--write-index", action="store_true", help="Write reports/failed-builds-index.json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.write_index:
        index = write_failure_index()
    else:
        index = build_failure_index()
        print(json.dumps(index, indent=2))
    print(f"Indexed {index['event_count']} events across {index['entry_count']} sources.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
