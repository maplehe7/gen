from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, render_template, request, send_from_directory


BASE_DIR = Path(__file__).resolve().parent
EXPORTS_DIR = BASE_DIR / "generated_games"
CATALOG_PATH = BASE_DIR / "game_catalog.json"
EXPORTER_PATH = BASE_DIR / "unity_standalone.py"
MAX_LOG_LINES = 120

app = Flask(__name__, template_folder="templates", static_folder="static")

jobs_lock = threading.Lock()
jobs: dict[str, dict[str, Any]] = {}


def ensure_directories() -> None:
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").strip().lower())
    cleaned = cleaned.strip("-")
    return cleaned or "game"


def looks_like_url(value: str) -> bool:
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def derive_name_from_url(value: str) -> str:
    parsed = urlparse(value)
    tail = Path(parsed.path.rstrip("/")).name
    if tail:
        return tail
    return parsed.netloc or "game"


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def load_catalog_entries() -> list[dict[str, str]]:
    if not CATALOG_PATH.exists():
        return []

    try:
        raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    entries: list[dict[str, str]] = []
    if isinstance(raw, dict):
        for name, url in raw.items():
            if isinstance(name, str) and isinstance(url, str):
                entries.append({"name": name.strip(), "url": url.strip()})
    elif isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            url = str(item.get("url", "")).strip()
            if name and url:
                entries.append({"name": name, "url": url})
    return [entry for entry in entries if entry["name"] and looks_like_url(entry["url"])]


def resolve_source(source: str) -> dict[str, str]:
    value = source.strip()
    if not value:
        raise ValueError("Enter a game URL or a catalog name.")

    if looks_like_url(value):
        return {
            "source_url": value,
            "source_mode": "url",
            "matched_name": "",
            "display_name": derive_name_from_url(value),
        }

    catalog_entries = load_catalog_entries()
    normalized = value.casefold()

    exact_matches = [
        entry for entry in catalog_entries if entry["name"].strip().casefold() == normalized
    ]
    if len(exact_matches) == 1:
        match = exact_matches[0]
        return {
            "source_url": match["url"],
            "source_mode": "catalog",
            "matched_name": match["name"],
            "display_name": match["name"],
        }

    partial_matches = [
        entry for entry in catalog_entries if normalized in entry["name"].strip().casefold()
    ]
    if len(partial_matches) == 1:
        match = partial_matches[0]
        return {
            "source_url": match["url"],
            "source_mode": "catalog",
            "matched_name": match["name"],
            "display_name": match["name"],
        }

    if len(partial_matches) > 1:
        names = ", ".join(entry["name"] for entry in partial_matches[:5])
        raise ValueError(f"Multiple catalog matches found: {names}. Be more specific.")

    raise ValueError(
        "Name mode only works for entries listed in game_catalog.json. Paste a direct game URL or add the game to the catalog first."
    )


def format_eta(seconds: int | None) -> str:
    if seconds is None or seconds < 1:
        return "Calculating..."
    minutes, remainder = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m remaining"
    if minutes:
        return f"{minutes}m {remainder}s remaining"
    return f"{remainder}s remaining"


def append_log(job: dict[str, Any], message: str) -> None:
    trimmed = message.strip()
    if not trimmed:
        return
    job_logs = job.setdefault("logs", [])
    job_logs.append(trimmed)
    if len(job_logs) > MAX_LOG_LINES:
        del job_logs[:-MAX_LOG_LINES]


def apply_log_hints(job: dict[str, Any], message: str) -> None:
    line = message.removeprefix("[unity-standalone] ").strip()

    if line.startswith("Mode:"):
        job["phase"] = "Inspecting source"
    elif line.startswith("Resolved entry URL"):
        job["phase"] = "Resolved entry URL"
    elif line.startswith("Detected entry kind:"):
        entry_kind = line.split(":", 1)[1].strip()
        job["phase"] = f"Preparing {entry_kind} export"
    elif line.startswith("Detected build kind:"):
        job["phase"] = "Scanning build assets"
    elif line.startswith("Mirroring HTML runtime assets:"):
        match = re.search(r"(\d+)/(\d+)", line)
        if match:
            current = int(match.group(1))
            total = int(match.group(2))
            ratio = current / total if total else 0
            job["phase"] = f"Mirroring HTML assets ({current}/{total})"
            job["progress"] = max(job.get("progress", 0.0), 0.35 + (0.45 * ratio))
    elif line.startswith("Custom split Unity data parts:"):
        match = re.search(r"(\d+)/(\d+)", line)
        if match:
            current = int(match.group(1))
            total = int(match.group(2))
            ratio = current / total if total else 0
            job["phase"] = f"Combining split data ({current}/{total})"
            job["progress"] = max(job.get("progress", 0.0), 0.38 + (0.32 * ratio))
    elif line.startswith("support-script: downloaded"):
        job["phase"] = "Downloading support files"
        job["progress"] = max(job.get("progress", 0.0), 0.9)
    elif ": downloaded " in line or ": reusing " in line:
        asset_kind = line.split(":", 1)[0].strip()
        job["phase"] = f"Fetched {asset_kind}"
    elif line == "Done.":
        job["phase"] = "Finalizing output"
        job["progress"] = max(job.get("progress", 0.0), 0.98)


def compute_progress(job: dict[str, Any], progress_payload: dict[str, Any]) -> tuple[float, str]:
    if job.get("status") == "completed" or progress_payload.get("completed"):
        return 1.0, "Ready to play"

    progress = max(job.get("progress", 0.0), 0.08 if job.get("status") == "running" else 0.0)
    phase = str(job.get("phase") or "Queued")

    if progress_payload:
        progress = max(progress, 0.18)
        entry_kind = str(progress_payload.get("entry_kind") or "").strip()
        if entry_kind:
            phase = f"Preparing {entry_kind} export"

        candidate_urls = progress_payload.get("candidate_urls")
        assets = progress_payload.get("assets")
        if isinstance(candidate_urls, dict):
            total_assets = max(len(candidate_urls), 1)
            completed_assets = len(assets) if isinstance(assets, dict) else 0
            progress = max(progress, 0.24 + (0.58 * (completed_assets / total_assets)))
            phase = f"Downloading assets ({completed_assets}/{total_assets})"
            if completed_assets == total_assets:
                progress = max(progress, 0.88)
                phase = "Packaging launcher"
        elif entry_kind == "html":
            progress = max(progress, 0.56)
            phase = job.get("phase") or "Rebuilding HTML runtime"
        elif entry_kind == "eaglercraft":
            progress = max(progress, 0.48)
            phase = job.get("phase") or "Preparing Eagler package"
        elif entry_kind == "remote_stream":
            progress = max(progress, 0.48)
            phase = job.get("phase") or "Preparing stream launcher"

    output_dir = Path(str(job["output_dir"]))
    if (output_dir / "index.html").exists():
        progress = max(progress, 0.95)
        phase = "Writing launcher files"

    return min(progress, 0.99), phase


def estimate_eta_seconds(job: dict[str, Any]) -> int | None:
    progress = float(job.get("progress") or 0.0)
    started_at = float(job.get("started_at") or 0.0)
    if started_at <= 0 or progress <= 0.08:
        return None

    elapsed = max(time.time() - started_at, 1.0)
    remaining = int(round(elapsed * ((1.0 - progress) / max(progress, 0.01))))
    return max(remaining, 1)


def refresh_job_state(job: dict[str, Any]) -> None:
    progress_path = Path(str(job["progress_file"]))
    progress_payload = load_json(progress_path)

    if job.get("status") == "completed":
        job["progress"] = 1.0
        job["phase"] = "Ready to play"
        job["eta_label"] = "Completed"
        summary = progress_payload.get("summary")
        if isinstance(summary, dict):
            job["summary"] = summary
        return

    if job.get("status") == "error":
        job["eta_label"] = "Stopped"
        summary = progress_payload.get("summary")
        if isinstance(summary, dict):
            job["summary"] = summary
        return

    if job.get("status") == "queued" and not job.get("started_at"):
        job["phase"] = "Queued"
        job["eta_label"] = "Waiting to start"
        summary = progress_payload.get("summary")
        if isinstance(summary, dict):
            job["summary"] = summary
        return

    progress_value, phase = compute_progress(job, progress_payload)
    job["progress"] = max(float(job.get("progress") or 0.0), progress_value)
    job["phase"] = phase
    job["eta_label"] = format_eta(estimate_eta_seconds(job))

    summary = progress_payload.get("summary")
    if isinstance(summary, dict):
        job["summary"] = summary


def build_export_command(source_url: str, output_dir: Path) -> list[str]:
    return [
        sys.executable,
        str(EXPORTER_PATH),
        source_url,
        "--out",
        str(output_dir),
        "--overwrite",
    ]


def get_job(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        refresh_job_state(job)
        return dict(job)


def job_snapshot(job: dict[str, Any]) -> dict[str, Any]:
    output_dir = Path(str(job["output_dir"]))
    play_url = f"/play/{job['id']}/" if (output_dir / "index.html").exists() else ""
    build_path = output_dir / "Build"

    return {
        "id": job["id"],
        "source_input": job["source_input"],
        "source_url": job["source_url"],
        "source_mode": job["source_mode"],
        "matched_name": job.get("matched_name", ""),
        "display_name": job["display_name"],
        "output_name": job["output_name"],
        "output_dir": str(output_dir),
        "build_dir": str(build_path),
        "status": job["status"],
        "phase": job.get("phase", "Queued"),
        "progress": round(float(job.get("progress") or 0.0), 4),
        "progress_percent": int(round((float(job.get("progress") or 0.0)) * 100)),
        "eta_label": job.get("eta_label") or "Calculating...",
        "play_url": play_url,
        "summary": job.get("summary") or {},
        "error": job.get("error", ""),
        "logs": list(job.get("logs") or []),
        "created_at": job["created_at"],
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
    }


def run_export_job(job_id: str) -> None:
    with jobs_lock:
        job = jobs[job_id]
        job["status"] = "running"
        job["started_at"] = time.time()
        job["phase"] = "Starting exporter"
        refresh_job_state(job)
        command = build_export_command(job["source_url"], Path(str(job["output_dir"])))
        job["command"] = command

    try:
        process = subprocess.Popen(
            command,
            cwd=BASE_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        with jobs_lock:
            job = jobs[job_id]
            job["status"] = "error"
            job["finished_at"] = time.time()
            job["error"] = f"Failed to start exporter: {exc}"
            job["phase"] = "Failed to start"
            append_log(job, job["error"])
        return

    with process.stdout:
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            with jobs_lock:
                job = jobs[job_id]
                append_log(job, line)
                apply_log_hints(job, line)
                refresh_job_state(job)

    return_code = process.wait()
    with jobs_lock:
        output_dir = Path(str(jobs[job_id]["output_dir"]))
    summary_path = output_dir / "standalone-build-info.json"
    summary_payload = load_json(summary_path)

    with jobs_lock:
        job = jobs[job_id]
        refresh_job_state(job)
        job["finished_at"] = time.time()
        if return_code == 0:
            job["status"] = "completed"
            job["progress"] = 1.0
            job["phase"] = "Ready to play"
            job["eta_label"] = "Completed"
            if summary_payload:
                job["summary"] = summary_payload
        else:
            job["status"] = "error"
            job["phase"] = "Export failed"
            job["eta_label"] = "Stopped"
            job["error"] = job.get("error") or (
                job.get("logs", [])[-1] if job.get("logs") else "Exporter failed."
            )


def create_job(source_input: str, output_name: str = "") -> dict[str, Any]:
    resolution = resolve_source(source_input)
    job_id = uuid.uuid4().hex[:10]
    display_name = output_name.strip() or resolution["display_name"]
    stamped_name = f"{slugify(display_name)}-{time.strftime('%Y%m%d-%H%M%S')}-{job_id}"
    output_dir = EXPORTS_DIR / stamped_name

    job = {
        "id": job_id,
        "source_input": source_input.strip(),
        "source_url": resolution["source_url"],
        "source_mode": resolution["source_mode"],
        "matched_name": resolution["matched_name"],
        "display_name": resolution["display_name"],
        "output_name": stamped_name,
        "output_dir": str(output_dir),
        "progress_file": str(output_dir / ".standalone-progress.json"),
        "status": "queued",
        "phase": "Queued",
        "progress": 0.0,
        "eta_label": "Waiting to start",
        "logs": [],
        "summary": {},
        "error": "",
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
    }

    with jobs_lock:
        jobs[job_id] = job

    worker = threading.Thread(target=run_export_job, args=(job_id,), daemon=True)
    worker.start()
    return job


@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/jobs")
def list_jobs() -> Any:
    with jobs_lock:
        current_jobs = list(jobs.values())

    current_jobs.sort(key=lambda item: item["created_at"], reverse=True)
    snapshots: list[dict[str, Any]] = []
    for job in current_jobs:
        with jobs_lock:
            refresh_job_state(job)
            snapshots.append(job_snapshot(job))
    return jsonify({"jobs": snapshots})


@app.post("/api/jobs")
def enqueue_job() -> Any:
    payload = request.get_json(silent=True) or {}
    source_input = str(payload.get("source", "")).strip()
    output_name = str(payload.get("outputName", "")).strip()

    try:
        job = create_job(source_input, output_name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    with jobs_lock:
        refresh_job_state(job)
        snapshot = job_snapshot(job)
    return jsonify(snapshot), 201


@app.get("/api/jobs/<job_id>")
def fetch_job(job_id: str) -> Any:
    try:
        snapshot = job_snapshot(get_job(job_id))
    except KeyError:
        abort(404)
    return jsonify(snapshot)


@app.get("/play/<job_id>/")
def play_index(job_id: str) -> Any:
    try:
        job = get_job(job_id)
    except KeyError:
        abort(404)

    output_dir = Path(str(job["output_dir"]))
    index_path = output_dir / "index.html"
    if not index_path.exists():
        abort(404)
    return send_from_directory(output_dir, "index.html")


@app.get("/play/<job_id>/<path:asset_path>")
def play_asset(job_id: str, asset_path: str) -> Any:
    try:
        job = get_job(job_id)
    except KeyError:
        abort(404)

    output_dir = Path(str(job["output_dir"]))
    target_path = output_dir / asset_path
    if not target_path.exists():
        abort(404)
    return send_from_directory(output_dir, asset_path)


ensure_directories()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
