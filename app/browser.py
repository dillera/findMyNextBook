"""The app's own Google Chrome profile (data/amazon-profile), driven through Playwright.

The Kindle sync and the Kindle-store check both use it. Chrome allows one process per profile, so `session()` holds a
lock for as long as a context is open; callers queue instead of failing on a locked profile."""
import asyncio
import os
from contextlib import asynccontextmanager

PROFILE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "amazon-profile")
_lock = asyncio.Lock()


def busy() -> bool:
    return _lock.locked()


@asynccontextmanager
async def session():
    """Hold the profile lock and a Playwright driver. Yields a `launch(headless)` coroutine for opening contexts."""
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:
        raise RuntimeError("Playwright is not installed: run `.venv/bin/pip install -r requirements.txt`") from e
    os.makedirs(PROFILE_DIR, exist_ok=True)
    async with _lock, async_playwright() as pw:
        async def launch(headless: bool = True):
            try:
                ctx = await pw.chromium.launch_persistent_context(
                    PROFILE_DIR, channel="chrome", headless=headless, viewport={"width": 1100, "height": 800})
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(f"Could not start Google Chrome via Playwright: {e}") from e
            if headless:
                # headless Chrome announces itself as "HeadlessChrome", which Amazon answers with a robot check;
                # send the normal Chrome user agent instead
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                ua = await page.evaluate("navigator.userAgent")
                if "HeadlessChrome" in ua:
                    await ctx.set_extra_http_headers({"User-Agent": ua.replace("HeadlessChrome", "Chrome")})
            return ctx
        yield launch
