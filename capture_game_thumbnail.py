from __future__ import annotations

import argparse
import asyncio
import functools
import http.server
import socketserver
import threading
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture a thumbnail for a generated game.")
    parser.add_argument("--site-root", required=True, help="Root directory being served")
    parser.add_argument("--game-path", required=True, help="Game path relative to the site root")
    parser.add_argument("--output-path", required=True, help="Output image path")
    parser.add_argument("--timeout-ms", type=int, default=45000, help="Overall capture timeout")
    parser.add_argument("--settle-ms", type=int, default=12000, help="Extra wait before screenshot")
    return parser.parse_args()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format: str, *args) -> None:
        return


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True


@contextmanager
def serve_directory(directory: Path):
    server = ThreadingTCPServer(
        ("127.0.0.1", 0),
        functools.partial(QuietHandler, directory=str(directory)),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield host, port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


async def capture_thumbnail(
    site_root: Path,
    game_path: str,
    output_path: Path,
    timeout_ms: int,
    settle_ms: int,
) -> None:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright

    cleaned_game_path = "/" + game_path.strip().lstrip("/")
    if not cleaned_game_path.endswith("/"):
        cleaned_game_path += "/"
    screenshot_url_path = cleaned_game_path + "?autostart=1&launchMode=frame"

    with serve_directory(site_root) as (host, port):
        url = f"http://{host}:{port}{quote(screenshot_url_path, safe='/:?=&-_')}"
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
            page = await browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                try:
                    await page.wait_for_selector("#unity-canvas, #game_frame iframe, canvas", timeout=15000)
                except PlaywrightTimeoutError:
                    pass
                try:
                    await page.wait_for_function(
                        """() => {
                          const loading = document.querySelector("#loadingScreen");
                          if (!loading) return true;
                          const style = window.getComputedStyle(loading);
                          return style.display === "none" || style.visibility === "hidden" || loading.style.display === "none";
                        }""",
                        timeout=max(timeout_ms - settle_ms, 5000),
                    )
                except PlaywrightTimeoutError:
                    pass
                await page.wait_for_timeout(settle_ms)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(output_path), type="jpeg", quality=82)
            finally:
                await browser.close()


def main() -> int:
    args = parse_args()
    asyncio.run(
        capture_thumbnail(
            site_root=Path(args.site_root).resolve(),
            game_path=str(args.game_path),
            output_path=Path(args.output_path).resolve(),
            timeout_ms=max(int(args.timeout_ms), 5000),
            settle_ms=max(int(args.settle_ms), 1000),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
