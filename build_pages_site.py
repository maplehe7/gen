from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse


BASE_DIR = Path(__file__).resolve().parent
SITE_SOURCE_DIR = BASE_DIR / "site"
CATALOG_SOURCE_PATH = BASE_DIR / "game_catalog.json"
EXPORTER_PATH = Path(os.environ.get("UNITY_EXPORTER_PATH") or (BASE_DIR / "unity_standalone.py"))
THUMBNAIL_SCRIPT_PATH = BASE_DIR / "capture_game_thumbnail.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a GitHub Pages-compatible site payload and optionally export a new game."
    )
    parser.add_argument("--state-dir", required=True, help="Directory containing the previous Pages state")
    parser.add_argument("--dist-dir", required=True, help="Directory to write the updated Pages site into")
    parser.add_argument("--source-url", default="", help="Game URL to export")
    parser.add_argument("--display-name", default="", help="Human label for the exported game")
    parser.add_argument("--request-id", default="", help="Client request identifier")
    return parser.parse_args()


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def looks_like_url(value: str) -> bool:
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_source_url(value: str) -> str:
    parsed = urlparse(value.strip())
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    return urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            path,
            parsed.params,
            parsed.query,
            "",
        )
    )


def derive_name_from_url(value: str) -> str:
    parsed = urlparse(value)
    tail = Path(parsed.path.rstrip("/")).name
    if tail:
        return tail
    return parsed.netloc or "game"


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").strip().lower())
    cleaned = cleaned.strip("-")
    return cleaned or "game"


def stable_folder_name_for_source(source_url: str) -> str:
    normalized_source = normalize_source_url(source_url)
    parsed = urlparse(normalized_source)
    source_label = derive_name_from_url(normalized_source) or parsed.netloc or "game"
    source_hash = hashlib.sha1(normalized_source.encode("utf-8")).hexdigest()[:10]
    return f"{slugify(source_label)}-{source_hash}"


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def resolve_existing_folder_name(dist_dir: Path, source_url: str) -> str:
    catalog = load_json(dist_dir / "published_games.json")
    games = catalog.get("games")
    if not isinstance(games, list):
        return ""

    normalized_source = normalize_source_url(source_url)
    for game in games:
        if not isinstance(game, dict):
            continue
        existing_source = str(game.get("source_url", "")).strip()
        if not existing_source:
            continue
        if normalize_source_url(existing_source) != normalized_source:
            continue

        folder = str(game.get("folder", "")).strip().replace("\\", "/")
        if folder.startswith("games/") and "/" not in folder[len("games/") :]:
            return folder.split("/", 1)[1]

        entry_id = str(game.get("id", "")).strip()
        if entry_id:
            return entry_id

    return ""


def reset_directory(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True)


def copy_tree_contents(source_dir: Path, target_dir: Path, skip_names: set[str] | None = None) -> None:
    if not source_dir.exists():
        return

    skip = skip_names or set()
    for item in source_dir.iterdir():
        if item.name in skip:
            continue
        destination = target_dir / item.name
        if item.is_dir():
            shutil.copytree(item, destination, dirs_exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, destination)


def prepare_dist(state_dir: Path, dist_dir: Path) -> None:
    reset_directory(dist_dir)
    copy_tree_contents(state_dir, dist_dir, skip_names={".git"})
    copy_tree_contents(SITE_SOURCE_DIR, dist_dir, skip_names={"published_games.json"})
    if CATALOG_SOURCE_PATH.exists():
        shutil.copy2(CATALOG_SOURCE_PATH, dist_dir / "game_catalog.json")
    (dist_dir / ".nojekyll").write_text("", encoding="utf-8")
    published_path = dist_dir / "published_games.json"
    if not published_path.exists():
        write_json(published_path, {"generated_at": "", "games": []})


def capture_thumbnail_for_folder(dist_dir: Path, folder_name: str) -> str:
    if not THUMBNAIL_SCRIPT_PATH.exists():
        return ""

    output_path = dist_dir / "games" / folder_name / "thumbnail.jpg"
    command = [
        sys.executable,
        str(THUMBNAIL_SCRIPT_PATH),
        "--site-root",
        str(dist_dir),
        "--game-path",
        f"games/{folder_name}/",
        "--output-path",
        str(output_path),
    ]
    try:
        subprocess.run(command, cwd=BASE_DIR, check=True)
    except (OSError, subprocess.CalledProcessError):
        return ""

    return f"games/{folder_name}/thumbnail.jpg" if output_path.exists() else ""


def build_export(
    dist_dir: Path,
    source_url: str,
    display_name: str,
    request_id: str,
) -> dict[str, Any]:
    if not source_url:
        return {}

    if not looks_like_url(source_url):
        raise ValueError(f"Invalid source URL: {source_url}")

    resolved_name = display_name.strip() or derive_name_from_url(source_url)
    folder_name = resolve_existing_folder_name(dist_dir, source_url) or stable_folder_name_for_source(
        source_url
    )
    target_dir = dist_dir / "games" / folder_name

    command = [
        sys.executable,
        str(EXPORTER_PATH),
        source_url,
        "--out",
        str(target_dir),
        "--overwrite",
    ]
    subprocess.run(command, cwd=BASE_DIR, check=True)

    summary_path = target_dir / "standalone-build-info.json"
    summary = load_json(summary_path)
    thumbnail_path = capture_thumbnail_for_folder(dist_dir, folder_name)
    generated_at = iso_now()
    return {
        "id": folder_name,
        "request_id": request_id,
        "title": resolved_name,
        "source_url": source_url,
        "folder": f"games/{folder_name}",
        "play_path": f"games/{folder_name}/",
        "thumbnail_path": thumbnail_path,
        "summary_path": f"games/{folder_name}/standalone-build-info.json",
        "generated_at": generated_at,
        "summary": summary,
    }


def update_catalog(dist_dir: Path, new_entry: dict[str, Any]) -> None:
    catalog_path = dist_dir / "published_games.json"
    catalog = load_json(catalog_path)
    games = catalog.get("games")
    if not isinstance(games, list):
        games = []

    new_source_url = str(new_entry.get("source_url", "")).strip()
    normalized_new_source = normalize_source_url(new_source_url) if new_source_url else ""
    normalized_games = [
        game
        for game in games
        if isinstance(game, dict)
        and str(game.get("id", "")).strip() != str(new_entry.get("id", "")).strip()
        and (
            not normalized_new_source
            or not str(game.get("source_url", "")).strip()
            or normalize_source_url(str(game.get("source_url", "")).strip()) != normalized_new_source
        )
    ]
    if new_entry:
        normalized_games.insert(0, new_entry)

    normalized_games.sort(key=lambda item: str(item.get("generated_at", "")), reverse=True)
    write_json(
        catalog_path,
        {
            "generated_at": iso_now(),
            "games": normalized_games,
        },
    )


def backfill_catalog_thumbnails(dist_dir: Path, limit: int = 6) -> None:
    catalog_path = dist_dir / "published_games.json"
    catalog = load_json(catalog_path)
    games = catalog.get("games")
    if not isinstance(games, list):
        return

    updated = False
    remaining = max(limit, 0)
    for game in games:
        if remaining <= 0 or not isinstance(game, dict):
            continue
        if str(game.get("thumbnail_path", "")).strip():
            continue

        folder = str(game.get("folder", "")).strip().replace("\\", "/")
        if not folder.startswith("games/"):
            continue
        folder_name = folder.split("/", 1)[1]
        if not folder_name:
            continue

        thumbnail_path = capture_thumbnail_for_folder(dist_dir, folder_name)
        if not thumbnail_path:
            continue

        game["thumbnail_path"] = thumbnail_path
        updated = True
        remaining -= 1

    if updated:
        write_json(
            catalog_path,
            {
                "generated_at": iso_now(),
                "games": games,
            },
        )


def main() -> int:
    args = parse_args()
    state_dir = Path(args.state_dir).resolve()
    dist_dir = Path(args.dist_dir).resolve()
    source_url = str(args.source_url or "").strip()
    display_name = str(args.display_name or "").strip()
    request_id = str(args.request_id or "").strip()

    prepare_dist(state_dir, dist_dir)

    if source_url:
        new_entry = build_export(
            dist_dir=dist_dir,
            source_url=source_url,
            display_name=display_name,
            request_id=request_id,
        )
        update_catalog(dist_dir, new_entry)
        backfill_catalog_thumbnails(dist_dir)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
