import asyncio
from pathlib import Path

from capture_game_thumbnail import serve_directory
from playwright.async_api import async_playwright


OUTPUT = Path(r"C:\Users\hello\Downloads\gen\generated_games\probe-geometrydash-lite-io-localized")
LOG_PATH = Path(r"C:\Users\hello\Downloads\gen\generated_games\probe-geometrydash-lite-io-localized\_probe.log")


def log(message: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(message + "\n")


async def main() -> None:
    LOG_PATH.write_text("", encoding="utf-8")
    log("probe:start")
    with serve_directory(OUTPUT) as (host, port):
        base_url = f"http://{host}:{port}"
        log(f"probe:serve {base_url}")
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
            context = await browser.new_context(viewport={"width": 1280, "height": 720})
            page = await context.new_page()
            page.on("console", lambda msg: log(f"console:{msg.type}: {msg.text}"))
            page.on(
                "pageerror",
                lambda exc: print(
                    f"pageerror:{exc!r} {getattr(exc, 'stack', None)}",
                    flush=True,
                ),
            )
            url = f"{base_url}/game-root.html?autostart=1"
            log(f"probe:url {url}")
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            log("probe:goto-done")
            await page.wait_for_timeout(20000)
            await page.screenshot(path=str(OUTPUT / "_probe.png"), full_page=True)
            log("probe:screenshot")
            await context.close()
            await browser.close()
            log("probe:closed")


if __name__ == "__main__":
    try:
        asyncio.run(asyncio.wait_for(main(), timeout=60))
    except TimeoutError:
        log("probe:timeout")
