from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
SITE_SOURCE_DIR = BASE_DIR / "site"
CATALOG_SOURCE_PATH = BASE_DIR / "game_catalog.json"
EXPORTER_PATH = Path(os.environ.get("UNITY_EXPORTER_PATH") or (BASE_DIR / "unity_standalone.py"))
THUMBNAIL_SCRIPT_PATH = BASE_DIR / "capture_game_thumbnail.py"
VERIFIER_SCRIPT_PATH = BASE_DIR / "verify_generated_game.py"
VERIFIER_TIMEOUT_SECONDS = 180


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


def sort_games_newest_first(games: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def sort_key(item: dict[str, Any]) -> float:
        try:
            return datetime.fromisoformat(str(item.get("generated_at", "")).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            return 0.0

    return sorted(games, key=sort_key, reverse=True)


def fetch_url_bytes(url: str, timeout: int = 20) -> tuple[bytes, str]:
    request = Request(url, headers={"User-Agent": "standalone-forge-builder"})
    with urlopen(request, timeout=timeout) as response:
        return response.read(), str(response.headers.get("Content-Type") or "")


def fetch_url_text(url: str, timeout: int = 20) -> str:
    payload, content_type = fetch_url_bytes(url, timeout=timeout)
    charset_match = re.search(r"charset=([a-zA-Z0-9._-]+)", content_type, re.IGNORECASE)
    encoding = charset_match.group(1) if charset_match else "utf-8"
    return payload.decode(encoding, errors="ignore")


def extract_meta_content(html: str, key: str) -> str:
    patterns = [
        rf'<meta[^>]+(?:property|name)=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{re.escape(key)}["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match and match.group(1):
            return match.group(1).strip()
    return ""


def guess_image_extension(image_url: str, content_type: str) -> str:
    normalized_type = str(content_type or "").split(";", 1)[0].strip().lower()
    guessed = mimetypes.guess_extension(normalized_type) if normalized_type else ""
    if guessed == ".jpe":
        guessed = ".jpg"
    if guessed:
        return guessed

    suffix = Path(urlparse(image_url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def thumbnail_candidates_from_summary(source_url: str, summary: dict[str, Any]) -> list[str]:
    candidates = []
    if source_url:
        candidates.append(source_url)
    for key in ("source_page_url", "input_url", "resolved_entry_url", "root_url"):
        value = str(summary.get(key, "")).strip()
        if value:
            candidates.append(value)

    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not looks_like_url(candidate):
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        normalized.append(candidate)
    return normalized


def fallback_thumbnail_for_folder(
    dist_dir: Path,
    folder_name: str,
    source_url: str,
    summary: dict[str, Any],
) -> str:
    for candidate_page_url in thumbnail_candidates_from_summary(source_url, summary):
        try:
            html = fetch_url_text(candidate_page_url)
        except OSError:
            continue

        image_url = (
            extract_meta_content(html, "og:image")
            or extract_meta_content(html, "twitter:image")
        ).strip()
        if not image_url:
            continue

        absolute_image_url = urljoin(candidate_page_url, image_url)
        if not looks_like_url(absolute_image_url):
            continue

        try:
            image_bytes, content_type = fetch_url_bytes(absolute_image_url)
        except OSError:
            return absolute_image_url

        extension = guess_image_extension(absolute_image_url, content_type)
        output_path = dist_dir / "games" / folder_name / f"thumbnail{extension}"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(image_bytes)
        return f"games/{folder_name}/thumbnail{extension}"

    return ""


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


def capture_thumbnail_for_folder(
    dist_dir: Path,
    folder_name: str,
    source_url: str,
    summary: dict[str, Any],
) -> str:
    output_path = dist_dir / "games" / folder_name / "thumbnail.jpg"
    if THUMBNAIL_SCRIPT_PATH.exists():
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
            pass

    if output_path.exists() and output_path.stat().st_size > 1024:
        return f"games/{folder_name}/thumbnail.jpg"

    return fallback_thumbnail_for_folder(
        dist_dir=dist_dir,
        folder_name=folder_name,
        source_url=source_url,
        summary=summary,
    )


def verify_export_output(output_dir: Path) -> dict[str, Any]:
    command = [
        sys.executable,
        str(VERIFIER_SCRIPT_PATH),
        "--output-dir",
        str(output_dir),
        "--timeout-ms",
        "120000",
        "--ready-timeout-ms",
        "45000",
        "--settle-ms",
        "3000",
    ]
    subprocess.run(command, cwd=BASE_DIR, check=True, timeout=VERIFIER_TIMEOUT_SECONDS)
    return load_json(output_dir / "standalone-verification.json")


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
    staging_root = dist_dir / ".build-staging"
    staging_root.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=f"{folder_name}-", dir=str(staging_root)))

    command = [
        sys.executable,
        str(EXPORTER_PATH),
        source_url,
        "--out",
        str(staging_dir),
        "--overwrite",
    ]
    try:
        subprocess.run(command, cwd=BASE_DIR, check=True)
        verification = verify_export_output(staging_dir)

        target_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(target_dir, ignore_errors=True)
        shutil.move(str(staging_dir), str(target_dir))
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    summary_path = target_dir / "standalone-build-info.json"
    summary = load_json(summary_path)
    verification = load_json(target_dir / "standalone-verification.json")
    thumbnail_path = capture_thumbnail_for_folder(
        dist_dir=dist_dir,
        folder_name=folder_name,
        source_url=source_url,
        summary=summary,
    )
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
        "verification_path": f"games/{folder_name}/standalone-verification.json",
        "generated_at": generated_at,
        "summary": summary,
        "verification": verification,
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

    normalized_games = sort_games_newest_first(normalized_games)
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

        summary_path = str(game.get("summary_path", "")).strip().replace("\\", "/")
        summary = {}
        if summary_path:
            summary = load_json(dist_dir / summary_path)

        thumbnail_path = capture_thumbnail_for_folder(
            dist_dir=dist_dir,
            folder_name=folder_name,
            source_url=str(game.get("source_url", "")).strip(),
            summary=summary,
        )
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
                "games": sort_games_newest_first(games),
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

    backfill_catalog_thumbnails(dist_dir, limit=12)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
