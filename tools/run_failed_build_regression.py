from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
EXPORTER = ROOT / "unity_standalone.py"
VERIFIER = ROOT / "verify_generated_game.py"
INDEX_PATH = ROOT / "reports" / "failed-builds-index.json"
DISPOSITIONS_PATH = ROOT / "reports" / "failed-build-dispositions.json"


def normalize_query(value: str) -> str:
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in str(value or "")).split())


def normalize_source_url(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = urlparse(text if "://" in text else f"https://{text}")
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    return parsed._replace(scheme=parsed.scheme.lower(), netloc=parsed.netloc.lower(), path=path, fragment="").geturl()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def matches_disposition(entry: dict, query: str, source_url: str) -> bool:
    queries = [normalize_query(item) for item in entry.get("queries", [])]
    if queries and normalize_query(query) not in queries:
        return False

    match_type = str(entry.get("match_type", ""))
    entry_source = normalize_source_url(entry.get("source_url", ""))
    source = normalize_source_url(source_url)
    if match_type == "exact":
        return entry_source == source
    if match_type == "host":
        entry_host = urlparse(entry_source).hostname or ""
        source_host = urlparse(source).hostname or ""
        return source_host == entry_host or source_host.endswith(f".{entry_host}")
    return False


def find_disposition(dispositions: list[dict], query: str, source_url: str) -> dict | None:
    for match_type in ("exact", "host"):
        for entry in dispositions:
            if str(entry.get("match_type", "")) != match_type:
                continue
            if matches_disposition(entry, query, source_url):
                return entry
    return None


def run_probe(source_url: str) -> dict:
    completed = subprocess.run(
        [sys.executable, str(EXPORTER), source_url, "--probe-only"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    stdout = (completed.stdout or "").strip()
    if stdout.startswith("{"):
        payload = json.loads(stdout)
        if isinstance(payload, dict):
            return payload
    return {
        "ok": False,
        "buildable": False,
        "reason": (completed.stderr or stdout or f"probe exited with status {completed.returncode}").strip(),
    }


def verify_allow_build(source_url: str) -> None:
    with tempfile.TemporaryDirectory(prefix="failed-build-regression-", dir=str(ROOT)) as temp_dir:
        output_dir = Path(temp_dir) / "export"
        subprocess.run(
            [sys.executable, str(EXPORTER), source_url, "--out", str(output_dir), "--overwrite"],
            cwd=ROOT,
            check=True,
        )
        if not (output_dir / "Build").exists():
            raise RuntimeError(f"{source_url}: export completed without a Build directory")
        subprocess.run(
            [sys.executable, str(VERIFIER), "--output-dir", str(output_dir)],
            cwd=ROOT,
            check=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Re-run the failed/cancelled build corpus against current probe/export logic.")
    parser.add_argument("--limit", type=int, default=0, help="Optional limit for quick sampling.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    index = load_json(INDEX_PATH)
    dispositions = load_json(DISPOSITIONS_PATH)["entries"]

    checked = 0
    failures: list[str] = []
    for entry in index["entries"]:
        source_url = entry["source_url"]
        query = (entry.get("queries") or [""])[0]
        disposition = find_disposition(dispositions, query, source_url)
        if disposition is None:
            failures.append(f"{source_url}: missing disposition")
            continue

        try:
            probe = run_probe(source_url)
            action = str(disposition.get("action", ""))
            if action == "allow_build":
                if not probe.get("ok") or not probe.get("buildable"):
                    failures.append(f"{source_url}: probe rejected allow_build target ({probe.get('reason', 'no reason')})")
                else:
                    verify_allow_build(source_url)
            else:
                replacement = str(disposition.get("replacement_source_url", "")).strip()
                if replacement:
                    replacement_probe = run_probe(replacement)
                    if not replacement_probe.get("ok") or not replacement_probe.get("buildable"):
                        failures.append(
                            f"{source_url}: replacement target {replacement} did not probe as buildable "
                            f"({replacement_probe.get('reason', 'no reason')})"
                        )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{source_url}: {exc}")

        checked += 1
        if args.limit and checked >= args.limit:
            break

    if failures:
        raise SystemExit("\n".join(failures))

    print(f"Checked {checked} failed-build corpus entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
