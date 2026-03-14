from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from capture_game_thumbnail import serve_directory


IGNORED_LOCAL_404_PATHS = {"/favicon.ico"}
IGNORABLE_CONSOLE_ERROR_SUBSTRINGS = (
    "Blocked: js/null.js",
    "FS.syncfs operations in flight at once",
)
IGNORABLE_PAGE_ERROR_SUBSTRINGS = (
    "Maximum call stack size exceeded",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify that a generated standalone build runs locally.")
    parser.add_argument("--output-dir", required=True, help="Generated game directory to verify")
    parser.add_argument("--timeout-ms", type=int, default=90000, help="Overall verification timeout")
    parser.add_argument("--ready-timeout-ms", type=int, default=60000, help="Playable-state timeout")
    parser.add_argument("--settle-ms", type=int, default=4000, help="Extra wait after readiness")
    return parser.parse_args()


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


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


def normalize_relative_path(value: str) -> str:
    normalized = str(value or "").strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/")


def normalize_request_path(value: str) -> str:
    normalized = "/" + normalize_relative_path(unquote(value))
    return normalized.rstrip("/") or "/"


def infer_entry_kind(summary: dict[str, Any]) -> str:
    explicit = str(summary.get("entry_kind", "")).strip().lower()
    if explicit:
        return explicit
    if any(str(summary.get(key, "")).strip() for key in ("loader", "framework", "data", "wasm")):
        return "unity"
    if any(str(summary.get(key, "")).strip() for key in ("classes_file", "assets_file")):
        return "eaglercraft"
    if isinstance(summary.get("html_runtime_mirror"), dict):
        return "html"
    return ""


def summary_required_files(summary: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    static_files = ["index.html", "game-root.html", "ocean-launcher.css", "ocean-launcher.js"]
    runtime_paths = ["game-root.html"]
    errors: list[str] = []

    entry_kind = infer_entry_kind(summary)
    if entry_kind == "unity":
        static_files.append("Build")
        for key in ("loader", "framework", "data", "wasm"):
            name = normalize_relative_path(str(summary.get(key, "")).strip())
            if not name:
                errors.append(f"Missing summary field for Unity asset: {key}")
                continue
            relative_path = f"Build/{name}"
            static_files.append(relative_path)
            runtime_paths.append(relative_path)
        for support_file in summary.get("support_script_files") or []:
            normalized = normalize_relative_path(str(support_file))
            if normalized:
                static_files.append(normalized)
                runtime_paths.append(normalized)
    elif entry_kind == "eaglercraft":
        for key in ("classes_file", "assets_file"):
            name = normalize_relative_path(str(summary.get(key, "")).strip())
            if not name:
                errors.append(f"Missing summary field for Eagler asset: {key}")
                continue
            static_files.append(name)
            runtime_paths.append(name)
        locales_file = normalize_relative_path(str(summary.get("locales_file", "")).strip())
        if locales_file:
            static_files.append(locales_file)
            runtime_paths.append(locales_file)
        mobile_script_file = normalize_relative_path(str(summary.get("eagler_mobile_script_file", "")).strip())
        if mobile_script_file:
            static_files.append(mobile_script_file)
        for script_file in summary.get("entry_script_files") or []:
            normalized = normalize_relative_path(str(script_file))
            if normalized:
                static_files.append(normalized)
                runtime_paths.append(normalized)
    elif entry_kind == "html":
        html_mirror = summary.get("html_runtime_mirror")
        mirrored_count = 0
        if isinstance(html_mirror, dict):
            try:
                mirrored_count = max(int(html_mirror.get("mirrored_file_count", 0)), 0)
            except (TypeError, ValueError):
                mirrored_count = 0
        if mirrored_count <= 0:
            errors.append("Mirrored HTML runtime did not record any localized asset files.")

        cached_runtime_file = normalize_relative_path(str(summary.get("cached_runtime_file", "")).strip())
        if cached_runtime_file:
            static_files.append(cached_runtime_file)
            runtime_paths.append(cached_runtime_file)

        mobile_script_file = normalize_relative_path(str(summary.get("eagler_mobile_script_file", "")).strip())
        if mobile_script_file:
            static_files.append(mobile_script_file)

        for key in ("external_script_urls", "external_stylesheet_urls", "external_frame_urls", "external_other_urls"):
            for value in summary.get(key) or []:
                normalized = normalize_relative_path(str(value))
                if not normalized or normalized.startswith(("http://", "https://")):
                    continue
                static_files.append(normalized)
    else:
        errors.append(
            "Unsupported export type for strict standalone verification: "
            f"{entry_kind or '<missing entry_kind>'}"
        )

    deduped_static = list(dict.fromkeys(static_files))
    deduped_runtime = list(dict.fromkeys(runtime_paths))
    return deduped_static, deduped_runtime, errors


def collect_static_issues(output_dir: Path, summary: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    required_files, runtime_paths, initial_errors = summary_required_files(summary)
    issues = list(initial_errors)
    for relative_path in required_files:
        normalized = normalize_relative_path(relative_path)
        if not normalized:
            continue
        target_path = output_dir / normalized
        if normalized == "Build":
            if not target_path.is_dir():
                issues.append("Missing Build directory.")
            continue
        if not target_path.exists():
            issues.append(f"Missing required file: {normalized}")
            continue
        if not target_path.is_file():
            issues.append(f"Expected file but found non-file path: {normalized}")
            continue
        try:
            if target_path.stat().st_size <= 0:
                issues.append(f"Empty required file: {normalized}")
        except OSError as exc:
            issues.append(f"Could not inspect required file {normalized}: {exc}")
    return required_files, runtime_paths, issues


def same_local_origin(url: str, local_origin: str) -> bool:
    parsed = urlparse(url)
    local = urlparse(local_origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.scheme == local.scheme
        and parsed.netloc == local.netloc
    )


def append_unique_event(target: list[dict[str, Any]], seen: set[str], payload: dict[str, Any]) -> None:
    key = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    if key in seen:
        return
    seen.add(key)
    target.append(payload)


def is_ignorable_console_error(text: str) -> bool:
    message = str(text or "")
    return any(snippet in message for snippet in IGNORABLE_CONSOLE_ERROR_SUBSTRINGS)


def is_ignorable_page_error(text: str) -> bool:
    message = str(text or "")
    return any(snippet in message for snippet in IGNORABLE_PAGE_ERROR_SUBSTRINGS)


def ready_state_script() -> str:
    return """() => {
      const docs = [];
      const seenWindows = new Set();
      const collectDocs = (win) => {
        if (!win || seenWindows.has(win)) return;
        seenWindows.add(win);
        try {
          docs.push(win.document);
        } catch (error) {
          return;
        }
        for (let index = 0; index < win.frames.length; index += 1) {
          try {
            collectDocs(win.frames[index]);
          } catch (error) {
          }
        }
      };
      const isVisible = (element) => {
        if (!element) return false;
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 16 && rect.height >= 16;
      };
      const loadingCleared = (doc) => {
        const loading = doc.querySelector("#loadingScreen");
        if (!loading) return true;
        return !isVisible(loading);
      };
      const hasPlayableCanvas = (doc) => {
        const selectors = ["#unity-canvas", "canvas"];
        for (const selector of selectors) {
          const nodes = doc.querySelectorAll(selector);
          for (const node of nodes) {
            if (isVisible(node)) return true;
          }
        }
        return false;
      };
      collectDocs(window);
      if (!docs.length) return false;
      return docs.every(loadingCleared) && docs.some(hasPlayableCanvas);
    }"""


def start_interaction_script() -> str:
    return """() => {
      const seenWindows = new Set();
      let clickCount = 0;
      const clickableSelectors = [
        "#play",
        ".play",
        "[data-action='play']",
        "[data-action='start']",
        "button",
        "a",
        "[role='button']",
      ];
      const collectWindows = (win, callback) => {
        if (!win || seenWindows.has(win)) return;
        seenWindows.add(win);
        callback(win);
        for (let index = 0; index < win.frames.length; index += 1) {
          try {
            collectWindows(win.frames[index], callback);
          } catch (error) {
          }
        }
      };
      const isVisible = (element) => {
        if (!element) return false;
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 16 && rect.height >= 16;
      };
      const maybeClick = (element) => {
        if (!element || !isVisible(element)) return false;
        const text = (element.textContent || "").trim().toLowerCase();
        const id = String(element.id || "").toLowerCase();
        const className = String(element.className || "").toLowerCase();
        if (
          !id.includes("play") &&
          !id.includes("start") &&
          !className.includes("play") &&
          !className.includes("start") &&
          !/^(play|start|tap to play|click to play)$/i.test(text)
        ) {
          return false;
        }
        try {
          element.click();
          return true;
        } catch (error) {
          return false;
        }
      };
      collectWindows(window, (win) => {
        const doc = win.document;
        for (const selector of clickableSelectors) {
          const nodes = doc.querySelectorAll(selector);
          for (const node of nodes) {
            if (maybeClick(node)) {
              clickCount += 1;
            }
          }
        }
      });
      return clickCount;
    }"""


async def verify_runtime(
    output_dir: Path,
    runtime_paths: list[str],
    timeout_ms: int,
    ready_timeout_ms: int,
    settle_ms: int,
) -> dict[str, Any]:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright

    console_errors: list[dict[str, Any]] = []
    page_errors: list[dict[str, Any]] = []
    request_failures: list[dict[str, Any]] = []
    bad_local_responses: list[dict[str, Any]] = []
    external_requests: list[dict[str, Any]] = []
    requested_local_paths: set[str] = set()
    external_seen: set[str] = set()
    console_seen: set[str] = set()
    page_error_seen: set[str] = set()
    request_failure_seen: set[str] = set()
    response_seen: set[str] = set()

    with serve_directory(output_dir) as (host, port):
        local_origin = f"http://{host}:{port}"
        launch_url = f"{local_origin}/?autostart=1&launchMode=frame"
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
            context = await browser.new_context(
                viewport={"width": 1280, "height": 720},
                device_scale_factor=1,
                ignore_https_errors=True,
            )
            try:
                async def route_handler(route) -> None:
                    request = route.request
                    request_url = request.url
                    parsed = urlparse(request_url)
                    if parsed.scheme not in {"http", "https"}:
                        await route.fallback()
                        return
                    if same_local_origin(request_url, local_origin):
                        requested_local_paths.add(normalize_request_path(parsed.path))
                        await route.fallback()
                        return
                    append_unique_event(
                        external_requests,
                        external_seen,
                        {
                            "url": request_url,
                            "method": request.method,
                            "resource_type": request.resource_type,
                            "blocked": True,
                        },
                    )
                    await route.abort()

                await context.route("**/*", route_handler)
                page = await context.new_page()

                def on_console(message) -> None:
                    if message.type != "error":
                        return
                    if is_ignorable_console_error(message.text):
                        return
                    append_unique_event(
                        console_errors,
                        console_seen,
                        {
                            "text": message.text,
                            "location": message.location,
                        },
                    )

                def on_page_error(error: Exception) -> None:
                    if is_ignorable_page_error(str(error)):
                        return
                    append_unique_event(
                        page_errors,
                        page_error_seen,
                        {"text": str(error)},
                    )

                def on_request_failed(request) -> None:
                    request_url = request.url
                    parsed = urlparse(request_url)
                    failure = request.failure or {}
                    if isinstance(failure, str):
                        error_text = failure
                    elif isinstance(failure, dict):
                        error_text = str(failure.get("errorText", ""))
                    else:
                        error_text = str(failure)
                    if parsed.scheme not in {"http", "https"}:
                        return
                    if not same_local_origin(request_url, local_origin):
                        return
                    append_unique_event(
                        request_failures,
                        request_failure_seen,
                        {
                            "url": request_url,
                            "path": normalize_request_path(parsed.path),
                            "method": request.method,
                            "resource_type": request.resource_type,
                            "error_text": error_text,
                        },
                    )

                def on_response(response) -> None:
                    response_url = response.url
                    parsed = urlparse(response_url)
                    if parsed.scheme not in {"http", "https"}:
                        return
                    if not same_local_origin(response_url, local_origin):
                        return
                    path = normalize_request_path(parsed.path)
                    requested_local_paths.add(path)
                    if response.status < 400 or path in IGNORED_LOCAL_404_PATHS:
                        return
                    append_unique_event(
                        bad_local_responses,
                        response_seen,
                        {
                            "url": response_url,
                            "path": path,
                            "status": response.status,
                            "status_text": response.status_text,
                            "resource_type": response.request.resource_type,
                        },
                    )

                def on_websocket(websocket) -> None:
                    if same_local_origin(websocket.url, local_origin):
                        return
                    append_unique_event(
                        external_requests,
                        external_seen,
                        {
                            "url": websocket.url,
                            "method": "GET",
                            "resource_type": "websocket",
                            "blocked": False,
                        },
                    )

                page.on("console", on_console)
                page.on("pageerror", on_page_error)
                page.on("requestfailed", on_request_failed)
                page.on("response", on_response)
                page.on("websocket", on_websocket)

                async def kickstart_runtime(rounds: int = 3, pause_ms: int = 1200) -> None:
                    for _index in range(rounds):
                        try:
                            await page.evaluate(start_interaction_script())
                        except Exception:
                            pass
                        await page.wait_for_timeout(pause_ms)

                await page.goto(launch_url, wait_until="commit", timeout=timeout_ms)
                await kickstart_runtime(rounds=4, pause_ms=1400)

                ready = True
                ready_error = ""
                try:
                    await page.wait_for_function(
                        ready_state_script(),
                        timeout=ready_timeout_ms,
                    )
                except PlaywrightTimeoutError:
                    try:
                        await kickstart_runtime(rounds=3, pause_ms=1600)
                        await page.wait_for_function(
                            ready_state_script(),
                            timeout=8000,
                        )
                    except PlaywrightTimeoutError:
                        ready = False
                        ready_error = "Game did not reach a visible playable canvas state."
                    except Exception:
                        ready = False
                        ready_error = "Game did not reach a visible playable canvas state."

                await page.wait_for_timeout(settle_ms)

                expected_requested_paths = sorted(
                    normalize_request_path(relative_path) for relative_path in runtime_paths if relative_path
                )
                missing_runtime_requests = sorted(
                    path for path in expected_requested_paths if path not in requested_local_paths
                )
                ok = (
                    ready
                    and not console_errors
                    and not page_errors
                    and not request_failures
                    and not bad_local_responses
                    and not external_requests
                    and not missing_runtime_requests
                )

                return {
                    "ok": ok,
                    "verified_at": iso_now(),
                    "local_origin": local_origin,
                    "launch_url": launch_url,
                    "ready": ready,
                    "ready_error": ready_error,
                    "required_runtime_paths": expected_requested_paths,
                    "requested_local_paths": sorted(requested_local_paths),
                    "missing_runtime_requests": missing_runtime_requests,
                    "external_requests": external_requests,
                    "request_failures": request_failures,
                    "bad_local_responses": bad_local_responses,
                    "console_errors": console_errors,
                    "page_errors": page_errors,
                }
            finally:
                await context.close()
                await browser.close()


def update_summary(summary_path: Path, verification_path: Path, verification: dict[str, Any]) -> None:
    summary = load_json(summary_path)
    if not summary:
        return
    summary["verification"] = verification
    summary["verification_path"] = str(verification_path)
    write_json(summary_path, summary)


def build_failure_reason(result: dict[str, Any]) -> str:
    if result.get("static_issues"):
        return "; ".join(str(item) for item in result["static_issues"])
    if result.get("ready_error"):
        return str(result["ready_error"])
    for key in (
        "missing_runtime_requests",
        "external_requests",
        "request_failures",
        "bad_local_responses",
        "console_errors",
        "page_errors",
    ):
        value = result.get(key)
        if value:
            return f"Verification failed due to {key}."
    return "Verification failed."


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    summary_path = output_dir / "standalone-build-info.json"
    verification_path = output_dir / "standalone-verification.json"
    summary = load_json(summary_path)

    result: dict[str, Any] = {
        "ok": False,
        "verified_at": iso_now(),
        "output_dir": str(output_dir),
        "summary_path": str(summary_path),
    }

    try:
        if not summary:
            result["static_issues"] = ["Missing or unreadable standalone-build-info.json."]
            result["error"] = build_failure_reason(result)
            return_code = 1
        else:
            required_files, runtime_paths, static_issues = collect_static_issues(output_dir, summary)
            result.update(
                {
                    "entry_kind": infer_entry_kind(summary),
                    "required_files": required_files,
                    "required_runtime_paths": [
                        normalize_request_path(relative_path) for relative_path in runtime_paths if relative_path
                    ],
                    "static_issues": static_issues,
                }
            )
            if static_issues:
                result["error"] = build_failure_reason(result)
                return_code = 1
            else:
                runtime_result = asyncio.run(
                    verify_runtime(
                        output_dir=output_dir,
                        runtime_paths=runtime_paths,
                        timeout_ms=max(int(args.timeout_ms), 10000),
                        ready_timeout_ms=max(int(args.ready_timeout_ms), 5000),
                        settle_ms=max(int(args.settle_ms), 500),
                    )
                )
                result.update(runtime_result)
                if not result.get("ok"):
                    result["error"] = build_failure_reason(result)
                return_code = 0 if result.get("ok") else 1
    except Exception as exc:
        result["error"] = str(exc)
        return_code = 1
    finally:
        write_json(verification_path, result)
        update_summary(summary_path, verification_path, result)

    if return_code != 0:
        print(result.get("error", "Verification failed."), file=sys.stderr)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
