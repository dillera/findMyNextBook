"""Import the Kindle library from Amazon: fetch it into the `owned` ledger, then merge the ledger into `books`.

Fetch (run_sync) drives the app's Chrome profile (see browser.py): headless on a saved session, or a visible window the
first time so the user can sign in. Two JSON endpoints, both called with the user's own cookies:
  read.amazon.com/kindle-library/search?libraryType=BOOKS&sortType=acquisition_desc&querySize=50[&paginationToken=N]
    → {"itemsList": [{asin, title, authors: ["Last, First:"], productUrl (cover), percentageRead, resourceType
       (EBOOK | EBOOK_SAMPLE), originType (PURCHASE | PRIME | …)}], "paginationToken": "50"}  newest purchase first
  www.amazon.com/kindle/reading/insights/data
    → {"goal_info": {"titles_read": [{asin, date_read, source_origin}]}}  books marked finished, with dates
percentageRead comes back 0 for everything, so read status can't come from Amazon. The rule instead: every Kindle book
the user bought counts as read. Goodreads (matched by title + author) supplies ratings; Kindle books Goodreads never
saw become read, unrated books dated from Reading Insights where it has them.

Apply (apply_to_library) is separate so the wizard can show what will happen first (preview)."""
import asyncio
import json

from . import browser
from .db import get_conn, get_setting, now, set_setting
from .matching import BookIndex, norm_title
from .owned import clean_title

LIBRARY_URL = "https://read.amazon.com/kindle-library"
INSIGHTS_URL = "https://www.amazon.com/kindle/reading/insights/data"
LOGIN_TIMEOUT_S = 300
SAMPLE = "EBOOK_SAMPLE"

FETCH_ALL_JS = """async () => {
  const out = []; let tok = null;
  for (let page = 0; page < 200; page++) {
    const u = '/kindle-library/search?query=&libraryType=BOOKS&sortType=acquisition_desc&querySize=50'
            + (tok ? '&paginationToken=' + encodeURIComponent(tok) : '');
    const r = await fetch(u, {credentials: 'include'});
    if (!r.ok) throw new Error('kindle-library/search HTTP ' + r.status);
    const j = await r.json();
    out.push(...(j.itemsList || []));
    tok = j.paginationToken;
    if (!tok) break;
  }
  return out;
}"""

# Pasted into the browser console on read.amazon.com when Playwright/Chrome isn't an option. Same endpoint as above.
CONSOLE_SCRIPT = (
    "(async()=>{const o=[];let t=null;for(let i=0;i<200;i++){const r=await fetch('/kindle-library/search?query=&libraryType=BOOKS"
    "&sortType=acquisition_desc&querySize=50'+(t?'&paginationToken='+encodeURIComponent(t):''),{credentials:'include'});"
    "if(!r.ok){console.log('Amazon said HTTP '+r.status+' (are you signed in?)');return}const j=await r.json();"
    "o.push(...(j.itemsList||[]));t=j.paginationToken;if(!t)break}const s=JSON.stringify(o.map(x=>({asin:x.asin,title:x.title,"
    "authors:x.authors,productUrl:x.productUrl,resourceType:x.resourceType,originType:x.originType})));"
    "try{copy(s)}catch(e){await navigator.clipboard.writeText(s)}console.log('Copied '+o.length+' books. Paste them into findMyNextBook.')})()"
)

_state = {"running": False, "phase": "idle", "message": "", "fetched": 0, "added": 0, "updated": 0, "new_titles": []}


def progress() -> dict:
    with get_conn() as conn:
        last = get_setting(conn, "kindle_last_sync")
    return {**_state, "last_sync": last}


def _set(**kw):
    _state.update(kw)


def author_name(raw: str | None) -> str | None:
    """Amazon's 'Salinger, J. D.:' → 'J. D. Salinger'."""
    a = (raw or "").strip().rstrip(":").strip()
    if a.count(",") == 1:
        last, first = (p.strip() for p in a.split(","))
        if first and last:
            return f"{first} {last}"
    return a or None


def _signed_in(url: str) -> bool:
    # signed out, read.amazon.com bounces to /landing (a page with a Sign in button) or to amazon.com/ap/signin
    return "/kindle-library" in url and "/landing" not in url and "/ap/" not in url


async def _wait_for_login(page) -> None:
    """Poll while the user signs in; Amazon may drop them anywhere on read.amazon.com afterwards."""
    for _ in range(LOGIN_TIMEOUT_S // 2):
        if page.is_closed():
            raise RuntimeError("The Amazon window was closed before sign-in finished")
        url = page.url
        if _signed_in(url):
            return
        if url.startswith("https://read.amazon.com") and "/landing" not in url:
            await page.goto(LIBRARY_URL, wait_until="domcontentloaded")
            continue
        await asyncio.sleep(2)
    raise RuntimeError("Timed out waiting for Amazon sign-in (5 minutes)")


async def _finished(ctx, page) -> list[dict]:
    """Reading Insights' finished titles. Optional: any failure just means no read dates."""
    try:
        r = await ctx.request.get(INSIGHTS_URL, timeout=30000)
        data = await r.json() if r.ok else None
    except Exception:  # noqa: BLE001
        data = None
    if data is None:  # fall back to loading it as a page (Chrome shows JSON in a <pre>)
        try:
            await page.goto(INSIGHTS_URL, wait_until="domcontentloaded", timeout=30000)
            data = json.loads(await page.evaluate("() => (document.querySelector('pre') || document.body).textContent"))
        except Exception:  # noqa: BLE001
            return []
    return [t for t in ((data or {}).get("goal_info") or {}).get("titles_read") or [] if t.get("asin")]


async def _fetch_items() -> tuple[list[dict], list[dict]]:
    if browser.busy():
        _set(phase="queued", message="Waiting for the Kindle-store check to finish…")
    async with browser.session() as launch:
        # headless first, using the saved session; fall back to a visible window for sign-in
        for headless in (True, False):
            _set(phase="launching" if headless else "waiting-login",
                 message="Opening Chrome…" if headless else "Sign in to Amazon in the Chrome window that just opened")
            ctx = await launch(headless)
            try:
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                await page.goto(LIBRARY_URL, wait_until="domcontentloaded")
                if not _signed_in(page.url):
                    if headless:
                        continue
                    await page.bring_to_front()
                    await _wait_for_login(page)
                _set(phase="fetching", message="Reading your Kindle library…")
                try:
                    items = await page.evaluate(FETCH_ALL_JS)
                except Exception:  # noqa: BLE001
                    if headless:  # session cookie present but stale / bot check: retry visibly
                        continue
                    raise
                _set(message=f"Found {len(items)} books · looking up when you finished them…", fetched=len(items))
                return items, await _finished(ctx, page)
            finally:
                await ctx.close()
    raise RuntimeError("Not signed in to Amazon")


def save_items(items: list[dict], reads: list[dict] | tuple = ()) -> dict:
    """Upsert Kindle items into the owned ledger, keyed on ASIN."""
    read_at = {}
    for t in reads:
        d = (t.get("date_read") or "")[:10]
        if d > read_at.get(t["asin"], ""):
            read_at[t["asin"]] = d
    ts = now()
    added = updated = 0
    new_titles = []
    with get_conn() as conn:
        first_sync = not conn.execute("SELECT 1 FROM owned WHERE asin IS NOT NULL LIMIT 1").fetchone()
        for rank, it in enumerate(items):
            asin = it.get("asin")
            title = clean_title((it.get("title") or "").strip())
            if not asin or not title:
                continue
            raw_authors = it.get("authors") or ([it["author"]] if it.get("author") else [])
            authors = [author_name(a) for a in raw_authors]
            author = "; ".join(a for a in authors if a) or None
            nt = norm_title(title)
            fields = dict(title=title, author=author, norm_title=nt, cover=it.get("productUrl"),
                          percent_read=it.get("percentageRead"), origin=it.get("originType"), kindle_rank=rank,
                          resource_type=it.get("resourceType"), read_at=read_at.get(asin))
            row = conn.execute("SELECT id FROM owned WHERE asin=?", (asin,)).fetchone()
            if not row:  # a title pasted in earlier: attach the ASIN instead of duplicating it
                row = conn.execute("SELECT id FROM owned WHERE asin IS NULL AND norm_title=?", (nt,)).fetchone()
            if row:
                sets = ", ".join(f"{k}=?" for k in fields) + ", asin=?"
                conn.execute(f"UPDATE owned SET {sets} WHERE id=?", [*fields.values(), asin, row["id"]])
                updated += 1
            else:
                conn.execute(
                    f"INSERT INTO owned({', '.join(fields)}, asin, source, added_at, first_seen_at) "
                    f"VALUES({', '.join('?' * len(fields))}, ?, 'kindle-sync', ?, ?)",
                    [*fields.values(), asin, ts, ts])
                added += 1
                new_titles.append(title + (f" — {author}" if author else ""))
        set_setting(conn, "kindle_last_sync", ts)
    return {"added": added, "updated": updated, "fetched": len(items), "first_sync": first_sync,
            "new_titles": [] if first_sync else new_titles}


def parse_paste(text: str) -> list[dict]:
    """JSON from the console script: a list of Kindle items, or the raw {"itemsList": [...]} page."""
    text = text.lstrip("﻿").strip()
    start, end = min((i for i in (text.find("["), text.find("{")) if i >= 0), default=-1), max(text.rfind("]"), text.rfind("}"))
    if start < 0 or end < start:
        raise ValueError("That doesn't look like the JSON the console script copies")
    data = json.loads(text[start:end + 1])
    if isinstance(data, dict):
        data = data.get("itemsList") or []
    items = [d for d in data if isinstance(d, dict) and d.get("asin") and d.get("title")]
    if not items:
        raise ValueError("No Kindle books found in the pasted text")
    return items


async def run_sync() -> None:
    if _state["running"]:
        return
    _set(running=True, phase="launching", message="", fetched=0, added=0, updated=0, new_titles=[])
    try:
        items, reads = await _fetch_items()
        _set(phase="saving", fetched=len(items), message=f"Saving {len(items)} books…")
        r = await asyncio.to_thread(save_items, items, reads)
        _set(phase="done", added=r["added"], updated=r["updated"], new_titles=r["new_titles"],
             message=f"{r['fetched']} books on your Kindle" + (f" · {r['added']} new" if not r["first_sync"] else ""))
    except Exception as e:  # noqa: BLE001
        _set(phase="error", message=str(e)[:500])
    finally:
        _set(running=False)


# --- ledger → library -----------------------------------------------------------------------------
def _plan(conn, include_samples: bool, toread_as_read: bool) -> list[tuple[dict, str, dict | None]]:
    """For each Kindle ledger item: ('link', row, book) | ('new', row, None) | ('flip', row, book) | ('skip', row, None).
    'flip' = linked to a book on the to-read shelf, which moves to read (every Kindle purchase counts as read)."""
    idx = BookIndex(conn)
    plan = []
    for r in conn.execute("SELECT * FROM owned WHERE asin IS NOT NULL ORDER BY kindle_rank IS NULL, kindle_rank, id"):
        r = dict(r)
        if r["resource_type"] == SAMPLE and not include_samples:
            plan.append(("skip", r, None))
            continue
        b = idx.by_id.get(r["book_id"]) or idx.find(r["title"], r["author"], asin=r["asin"])
        if b:
            plan.append(("flip" if toread_as_read and b["exclusive_shelf"] == "to-read" else "link", r, b))
            if not b.get("asin"):
                b["asin"] = r["asin"]
        else:
            plan.append(("new", r, None))
            # a second edition of the same book later in the list should link to this one, not duplicate it
            idx.add({"id": -len(plan), "title": r["title"], "author": r["author"], "asin": r["asin"], "isbn": None,
                     "goodreads_id": None, "exclusive_shelf": "read", "my_rating": 0, "date_read": r["read_at"],
                     "thumbnail": r["cover"], "_pending": r})
    return plan


def preview(include_samples: bool = False, toread_as_read: bool = True) -> dict:
    with get_conn() as conn:
        plan = _plan(conn, include_samples, toread_as_read)
        samples = conn.execute("SELECT COUNT(*) FROM owned WHERE asin IS NOT NULL AND resource_type=?", (SAMPLE,)).fetchone()[0]
        legacy = conn.execute("SELECT COUNT(*) FROM owned WHERE asin IS NULL").fetchone()[0]
    count = lambda k: sum(1 for p in plan if p[0] == k)  # noqa: E731
    already = sum(1 for k, r, b in plan if k in ("link", "flip") and r["book_id"] and b and r["book_id"] == b["id"])
    return {
        "total": len(plan), "samples": samples, "legacy": legacy,
        "matched": count("link") + count("flip"), "new": count("new"), "flip": count("flip"), "skipped": count("skip"),
        "already_imported": already, "with_dates": sum(1 for k, r, _ in plan if k == "new" and r["read_at"]),
        "new_books": [{"title": r["title"], "author": r["author"], "cover": r["cover"]} for k, r, _ in plan if k == "new"][:36],
        "flip_books": [{"title": b["title"], "author": b["author"]} for k, _, b in plan if k == "flip"][:20],
    }


def apply_to_library(include_samples: bool = False, toread_as_read: bool = True) -> dict:
    ts = now()
    added = linked = flipped = 0
    with get_conn() as conn:
        plan = _plan(conn, include_samples, toread_as_read)
        conn.execute("UPDATE books SET kindle_rank=NULL")  # ranks shift with every purchase; recomputed below
        created = {}  # ledger id of the first edition → new book id
        for kind, r, b in plan:
            if kind == "skip":
                continue
            if kind == "new":
                cur = conn.execute(
                    """INSERT INTO books(title, author, asin, source, kindle_rank, exclusive_shelf, my_rating, date_read,
                       date_added, thumbnail, binding, created_at, updated_at)
                       VALUES(?,?,?,'kindle',?,'read',0,?,?,?,'Kindle Edition',?,?)""",
                    (r["title"], r["author"], r["asin"], r["kindle_rank"], r["read_at"], ts[:10], r["cover"], ts, ts))
                book_id = cur.lastrowid
                created[r["id"]] = book_id
                added += 1
            else:
                book_id = b["id"] if b["id"] > 0 else created[b["_pending"]["id"]]
                if b["id"] > 0:
                    # Amazon's covers are sharper than Google's thumbnails; keep a cover that is already Amazon's
                    conn.execute(
                        """UPDATE books SET asin=COALESCE(asin, ?), kindle_rank=MIN(COALESCE(kindle_rank, ?), ?),
                           thumbnail=CASE WHEN thumbnail LIKE '%media-amazon.com%' THEN thumbnail ELSE COALESCE(?, thumbnail) END,
                           date_read=CASE WHEN exclusive_shelf='read' THEN COALESCE(date_read, ?) ELSE date_read END
                           WHERE id=?""",
                        (r["asin"], r["kindle_rank"], r["kindle_rank"], r["cover"], r["read_at"], book_id))
                    if kind == "flip":
                        # updated_at > created_at marks a local edit, so a later Goodreads re-import won't undo it
                        conn.execute("UPDATE books SET exclusive_shelf='read', date_read=COALESCE(date_read, ?), "
                                     "updated_at=? WHERE id=?", (r["read_at"], ts, book_id))
                        flipped += 1
                linked += 1
            conn.execute("UPDATE owned SET book_id=? WHERE id=?", (book_id, r["id"]))
        set_setting(conn, "kindle_last_apply", ts)
    return {"added": added, "linked": linked, "flipped": flipped}
