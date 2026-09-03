"""Build a reading profile from the library and ask an LLM (via OpenRouter) what to buy next on Kindle."""
import asyncio
import difflib
import json
import re
from collections import defaultdict
from urllib.parse import quote_plus

import httpx

from . import google_books, openrouter
from .db import get_conn, now


def amazon_kindle_url(title: str, author: str | None) -> str:
    q = f"{title} {author or ''}".strip()
    # i=digital-text restricts the search to the Kindle store
    return f"https://www.amazon.com/s?k={quote_plus(q)}&i=digital-text"


def _norm_title(t: str) -> str:
    t = google_books._strip_series(t or "").lower()
    t = re.split(r"[:(]", t)[0]  # drop subtitles
    t = re.sub(r"^(the|a|an)\s+", "", t)
    t = re.sub(r",\s*(the|a|an)\s*$", "", t)  # "Gone-Away World, The"
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def _surname(a: str | None) -> str:
    """'Peter Watts' -> 'watts'; Amazon's 'Watts, Peter' -> 'watts'; 'Pitre, Boisy G; Loguidice, Bill' -> 'pitre'."""
    a = (a or "").split(";")[0].strip()
    if not a:
        return ""
    if "," in a:
        return a.split(",")[0].strip().lower()
    return a.split()[-1].lower()


def is_known(title: str, author: str | None, known: set[tuple[str, str]]) -> str | None:
    """Return the matching known title if `title` is already in the library / owned list, else None.
    known = {(norm_title, author_surname)}. Exact normalized match, containment, or close fuzzy match by same author."""
    nt = _norm_title(title)
    if not nt:
        return None
    sa = _surname(author)
    for kt, ka in known:
        if nt == kt:
            return kt
        same_author = not sa or not ka or sa == ka
        if same_author and len(nt) >= 8 and len(kt) >= 8 and (nt in kt or kt in nt):
            return kt
        if same_author and difflib.SequenceMatcher(None, nt, kt).ratio() >= 0.9:
            return kt
    return None


def known_set(conn) -> set[tuple[str, str]]:
    known = {(_norm_title(r["title"]), _surname(r["author"])) for r in conn.execute("SELECT title, author FROM books")}
    known |= {(r["norm_title"] or _norm_title(r["title"]), _surname(r["author"])) for r in conn.execute("SELECT title, author, norm_title FROM owned")}
    return {k for k in known if k[0]}


def build_profile(conn) -> dict:
    books = [dict(r) for r in conn.execute("SELECT * FROM books")]
    by_shelf = defaultdict(list)
    for b in books:
        by_shelf[b["exclusive_shelf"]].append(b)

    def line(b):
        yr = b.get("original_year") or b.get("year_published")
        return f"{b['title']} — {b['author']}" + (f" ({yr})" if yr else "")

    read = by_shelf["read"]
    loved = [b for b in read if b["my_rating"] == 5]
    liked = [b for b in read if b["my_rating"] == 4]
    meh = [b for b in read if b["my_rating"] == 3]
    disliked = [b for b in read if 0 < b["my_rating"] <= 2]
    unrated = [b for b in read if b["my_rating"] == 0]

    # author affinity: weighted by count and mean rating
    auth = defaultdict(list)
    for b in read:
        if b["my_rating"]:
            auth[b["author"]].append(b["my_rating"])
    author_stats = sorted(
        ((a, len(r), sum(r) / len(r)) for a, r in auth.items()),
        key=lambda t: (t[1] * t[2]), reverse=True,
    )

    # category affinity from Google Books enrichment
    cat_score = defaultdict(lambda: [0, 0.0])
    for b in read:
        if not b.get("categories") or not b["my_rating"]:
            continue
        try:
            cats = json.loads(b["categories"])
        except ValueError:
            continue
        for c in cats:
            cat_score[c][0] += 1
            cat_score[c][1] += b["my_rating"]
    cats = sorted(((c, n, s / n) for c, (n, s) in cat_score.items()), key=lambda t: t[1], reverse=True)[:15]

    recent = sorted((b for b in read if b["date_read"]), key=lambda b: b["date_read"], reverse=True)[:15]

    return {
        "counts": {k: len(v) for k, v in by_shelf.items()},
        "loved": [line(b) for b in loved],
        "liked": [line(b) for b in liked],
        "meh": [line(b) for b in meh][:60],
        "disliked": [line(b) for b in disliked],
        "unrated_read": len(unrated),
        "top_authors": [f"{a}: {n} books, avg {avg:.1f}★" for a, n, avg in author_stats[:25]],
        "categories": [f"{c}: {n} books, avg {avg:.1f}★" for c, n, avg in cats],
        "recent": [f"{line(b)} [{b['my_rating'] or '-'}★, {b['date_read']}]" for b in recent],
        "currently_reading": [line(b) for b in by_shelf["currently-reading"]][:40],
        "to_read": [line(b) for b in by_shelf["to-read"]],
        "owned": [f"{r['title']}" + (f" — {r['author']}" if r["author"] else "") for r in conn.execute("SELECT title, author FROM owned ORDER BY title")],
        "known": known_set(conn),
    }


SYSTEM = """You are a sharp, well-read book recommender for a single reader who reads exclusively on Kindle and buys from Amazon US.
You will be given their full reading history with ratings (1-5 stars; 0 = unrated). Infer their taste precisely: favourite sub-genres,
tone, pacing, authors they binge, and what they bounce off. Recommend books they have NOT already read or shelved.
Rules:
- Only recommend real, published books that exist on the Kindle store. No made-up titles.
- Do not recommend anything in the reader's library (read, currently-reading, or to-read lists) — including other editions of the same book.
- Mix: ~half from authors they already love (unread titles), ~half new-to-them authors that fit. Include at most one wildcard.
- Prefer standalone books or the first book of a series unless the reader is clearly mid-series.
- Be specific in the reason: name the books in their history that make this a match.
Respond ONLY with JSON: {"taste_summary": "<2-3 sentence portrait of the reader>", "recommendations": [
  {"title": "...", "author": "...", "year": 2020, "reason": "<why this fits, citing their history>", "hook": "<one-line pitch>", "confidence": 0.0-1.0}
]}"""


def _profile_text(p: dict, n: int) -> str:
    def block(name, items):
        return f"\n## {name} ({len(items)})\n" + ("\n".join(f"- {i}" for i in items) if items else "- (none)")

    return (
        f"Library counts: {json.dumps(p['counts'])}\n"
        + block("LOVED (5★)", p["loved"])
        + block("LIKED (4★)", p["liked"])
        + block("FINE (3★, sample)", p["meh"])
        + block("DISLIKED (1-2★)", p["disliked"])
        + block("Top authors by affinity", p["top_authors"])
        + block("Genre affinity (from Google Books categories)", p["categories"])
        + block("Most recently read", p["recent"])
        + block("Currently reading / stalled (exclude)", p["currently_reading"])
        + block("To-read shelf (exclude)", p["to_read"])
        + block("Also owned on Kindle, not yet read (exclude)", p["owned"])
        + f"\n\nGive exactly {n} recommendations."
    )


def _parse(raw: str) -> dict:
    raw = raw.strip()
    m = re.search(r"\{.*\}", raw, re.S)
    if m:
        raw = m.group(0)
    return json.loads(raw)


async def run_recommendation(model: str | None, mood: str | None, n: int = 10) -> int:
    with get_conn() as conn:
        profile = build_profile(conn)
        user_msg = _profile_text(profile, n + 6)  # over-ask; a few always duplicate the library
        if mood:
            user_msg += f"\n\nReader's note for this batch: {mood}"
        cur = conn.execute(
            "INSERT INTO rec_runs(created_at, model, mood, prompt, status) VALUES(?,?,?,?, 'running')",
            (now(), model or openrouter.DEFAULT_MODEL, mood, user_msg),
        )
        run_id = cur.lastrowid

    try:
        raw = await openrouter.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_msg}], model=model)
        data = _parse(raw)
        recs = data.get("recommendations", [])
        # drop anything already in the library or owned list (defensive; the model is told not to)
        kept, dropped = [], []
        for r in recs:
            hit = is_known(r.get("title", ""), r.get("author"), profile["known"])
            (dropped if hit else kept).append(r if not hit else f"{r.get('title')} ~ {hit}")
        recs = kept[:n]

        async with httpx.AsyncClient(headers={"User-Agent": "findMyNextBook/1.0"}) as client:
            async def enrich(r):
                try:
                    return await google_books.lookup(client, r["title"], r.get("author"), None, None)
                except Exception:  # noqa: BLE001
                    return None
            metas = await asyncio.gather(*(enrich(r) for r in recs))

        with get_conn() as conn:
            for i, (r, meta) in enumerate(zip(recs, metas), 1):
                meta = meta or {}
                conn.execute(
                    """INSERT INTO recommendations(run_id,rank,title,author,year,reason,hook,confidence,google_id,isbn13,
                       thumbnail,description,categories,google_rating,amazon_url,status,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?)""",
                    (run_id, i, r.get("title"), r.get("author"), r.get("year"), r.get("reason"), r.get("hook"),
                     r.get("confidence"), meta.get("google_id"), meta.get("isbn13"), meta.get("thumbnail"),
                     meta.get("description"), meta.get("categories"), meta.get("google_rating"),
                     amazon_kindle_url(r.get("title", ""), r.get("author")), now()),
                )
            conn.execute("UPDATE rec_runs SET raw_response=?, status='done' WHERE id=?",
                         (json.dumps({"taste_summary": data.get("taste_summary"), "dropped": dropped, "raw": raw}), run_id))
    except Exception as e:  # noqa: BLE001
        with get_conn() as conn:
            conn.execute("UPDATE rec_runs SET status='error', error=? WHERE id=?", (str(e)[:1000], run_id))
        raise
    return run_id
