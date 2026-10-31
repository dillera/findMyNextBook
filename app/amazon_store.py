"""Check recommendations against the Kindle store: is there a Kindle edition, what does it cost, does the user own it?

Runs a Kindle-store search per book in the app's Chrome profile (headless). When that profile is signed in to Amazon,
results the user already owns say "You own this item" and show $0.00, with the buy price as "Or $9.99 to buy".
Search result markup (verified 2026-10): div[data-component-type="s-search-result"][data-asin]; title in the h2
aria-label; a row like "Book 2 of 4: Children of Time | by Adrian Tchaikovsky | Sold by: Hachette Book Group";
star rating in [aria-label="4.3 out of 5 stars, rating details"]; count in [aria-label="19,495 ratings"]."""
import asyncio
import difflib
from urllib.parse import quote_plus

from . import browser
from .matching import norm_title, surname

SEARCH = "https://www.amazon.com/s?k={q}&i=digital-text"
RESULT = 'div[data-component-type="s-search-result"]'

EXTRACT_JS = """() => [...document.querySelectorAll('div[data-component-type="s-search-result"][data-asin]')]
  .filter(el => el.dataset.asin).slice(0, 8).map(el => {
    const text = el.innerText.replace(/\\s+/g, ' ');
    const by = [...el.querySelectorAll('.a-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())
      .find(t => /(^|\\| )by /.test(t)) || '';
    const h2 = el.querySelector('h2');
    const label = (sel) => { const e = el.querySelector(sel); return (e && e.getAttribute('aria-label')) || ''; };
    const stars = label('[aria-label*="out of 5 stars"]');
    const count = label('[aria-label$=" ratings"], [aria-label$=" rating"]');
    const buy = text.match(/Or \\$([\\d,.]+) to buy/);
    const price = (el.querySelector('.a-price .a-offscreen') || {}).textContent || '';
    return {
      asin: el.dataset.asin,
      title: (h2 && (h2.getAttribute('aria-label') || h2.textContent) || '').trim(),
      authors: ((by.match(/(?:^|\\| )by (.+?)(?: \\| |$)/) || [])[1] || '').trim(),
      series: ((by.match(/Book \\d+ of \\d+: [^|]+/) || [])[0] || '').trim(),
      sponsored: !!el.querySelector('.puis-sponsored-label-text') || /^Sponsored\\b/.test(text),
      owned: /You own this item/i.test(text),
      kindle: /Kindle Edition/i.test(text),
      ku: /Kindle Unlimited/i.test(text),
      price: buy ? '$' + buy[1] : price.trim(),
      stars: parseFloat((stars.match(/[\\d.]+/) || [])[0]) || null,
      ratings: parseInt(count.replace(/[^\\d]/g, ''), 10) || null,
      cover: (el.querySelector('img.s-image') || {}).src || null,
    };
  })"""


class RobotCheck(RuntimeError):
    pass


def best_match(title: str, author: str | None, results: list[dict]) -> dict | None:
    """The first organic result that is this book: close title, and the author's surname in the byline."""
    nt, sa = norm_title(title), surname(author)
    best, best_score = None, 0.0
    for i, x in enumerate(results):
        if x.get("sponsored"):
            continue
        xt = norm_title(x.get("title"))
        if not xt or (sa and sa not in (x.get("authors") or "").lower()):
            continue
        ratio = 1.0 if xt == nt else difflib.SequenceMatcher(None, nt, xt).ratio()
        if len(nt) >= 6 and (xt.startswith(nt) or nt.startswith(xt)):
            ratio = max(ratio, 0.85)
        score = ratio + (0.05 if x.get("kindle") else 0) - i * 0.01
        if ratio >= 0.8 and score > best_score:
            best, best_score = x, score
    return best


async def _search(ctx, title: str, author: str | None) -> list[dict]:
    page = await ctx.new_page()
    try:
        await page.goto(SEARCH.format(q=quote_plus(f"{title} {author or ''}".strip())),
                        wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_selector(RESULT, timeout=8000)
        except Exception:  # noqa: BLE001
            if await page.query_selector('form[action*="validateCaptcha"]'):
                raise RobotCheck("Amazon asked for a robot check, so the Kindle store couldn't be checked") from None
            return []  # a search with no results
        return await page.evaluate(EXTRACT_JS)
    finally:
        await page.close()


async def check(books: list[dict], owned_asins: set[str], on_progress=None) -> list[dict | None]:
    """books: [{title, author}] → per book {status: available|owned|not-found, asin, price, ku, stars, ratings, cover,
    series, url} or None when the search itself failed. Raises RuntimeError when Chrome can't run at all."""
    out: list[dict | None] = [None] * len(books)
    done = 0
    async with browser.session() as launch:
        ctx = await launch(True)
        try:
            sem = asyncio.Semaphore(3)

            async def one(i, b):
                nonlocal done
                async with sem:
                    try:
                        results = await _search(ctx, b["title"], b.get("author"))
                    except RobotCheck:
                        raise
                    except Exception:  # noqa: BLE001
                        results = None
                done += 1
                if on_progress:
                    on_progress(done, len(books))
                if results is None:
                    return
                hit = best_match(b["title"], b.get("author"), results)
                if not hit:
                    out[i] = {"status": "not-found"}
                    return
                owned = hit["owned"] or hit["asin"] in owned_asins
                out[i] = {**hit, "status": "owned" if owned else "available",
                          "url": f"https://www.amazon.com/dp/{hit['asin']}"}

            await asyncio.gather(*(one(i, b) for i, b in enumerate(books)))
        finally:
            await ctx.close()
    return out
