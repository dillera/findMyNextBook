"""Build a reading profile from the library and ask an LLM (via OpenRouter) what to buy next on Kindle."""
import asyncio
import json
import re
from collections import defaultdict
from datetime import datetime
from urllib.parse import quote_plus

import httpx

from . import amazon_store, google_books, openrouter
from .db import get_conn, now
from .matching import is_known, norm_title, surname


def amazon_kindle_url(title: str, author: str | None) -> str:
    q = f"{title} {author or ''}".strip()
    # i=digital-text restricts the search to the Kindle store
    return f"https://www.amazon.com/s?k={quote_plus(q)}&i=digital-text"


# matching lives in matching.py; these names are kept for the callers that already use them
_norm_title, _surname = norm_title, surname


def known_set(conn) -> set[tuple[str, str]]:
    known = {(_norm_title(r["title"]), _surname(r["author"])) for r in conn.execute("SELECT title, author FROM books")}
    known |= {(r["norm_title"] or _norm_title(r["title"]), _surname(r["author"])) for r in conn.execute("SELECT title, author, norm_title FROM owned")}
    return {k for k in known if k[0]}


def owned_asins(conn) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT asin FROM books WHERE asin IS NOT NULL UNION SELECT asin FROM owned WHERE asin IS NOT NULL")}


# --- shared helpers ---------------------------------------------------------------------------------
def _ws(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _line(b: dict) -> str:
    yr = b.get("original_year") or b.get("year_published")
    return f"{_ws(b['title'])} — {_ws(b['author'])}" + (f" ({yr})" if yr else "")


def _cats(b: dict) -> list[str]:
    try:
        return [_ws(c).capitalize() for c in json.loads(b.get("categories") or "[]")]
    except ValueError:
        return []


def _age_years(b: dict) -> float | None:
    d = b.get("date_read") or b.get("date_added")
    if not d:
        return None
    try:
        return max(0.0, (datetime.now() - datetime.fromisoformat(d[:10])).days / 365.25)
    except ValueError:
        return None


def _feedback(conn) -> dict:
    rows = [dict(r) for r in conn.execute("SELECT title, author, status FROM recommendations WHERE status != 'new' ORDER BY id DESC")]
    fmt = lambda r: f"{r['title']} — {r['author']}"  # noqa: E731
    return {"rejected": [fmt(r) for r in rows if r["status"] == "dismissed"][:40],
            "accepted": [fmt(r) for r in rows if r["status"] in ("bought", "added")][:40]}


def _dedup_block(conn) -> list[str]:
    """Every title already read/shelved/owned, grouped by author so ~1,000 titles stay compact."""
    by_author, seen = defaultdict(list), set()
    rows = [(r["title"], r["author"]) for r in conn.execute("SELECT title, author FROM books")]
    rows += [(r["title"], r["author"]) for r in conn.execute("SELECT title, author FROM owned")]
    for title, author in rows:
        key = (_norm_title(title), _surname(author))
        if not key[0] or key in seen:
            continue
        seen.add(key)
        name = _ws((author or "").split(";")[0]) or "(unknown)"
        if "," in name:  # 'Watts, Peter' → 'Peter Watts' so both sources group together
            last, first = (p.strip() for p in name.split(",", 1))
            name = f"{first} {last}".strip()
        by_author[name].append(google_books._strip_series(title).split(":")[0].strip())
    return [f"{a}: {'; '.join(sorted(set(ts)))}" for a, ts in sorted(by_author.items(), key=lambda kv: kv[0].split()[-1].lower())]


# --- "full" profile: every rated book, bucketed by stars (the original approach) ---------------------
def build_profile(conn) -> dict:
    books = [dict(r) for r in conn.execute("SELECT * FROM books")]
    by_shelf = defaultdict(list)
    for b in books:
        by_shelf[b["exclusive_shelf"]].append(b)
    read = by_shelf["read"]

    auth = defaultdict(list)
    for b in read:
        if b["my_rating"]:
            auth[b["author"]].append(b["my_rating"])
    author_stats = sorted(((a, len(r), sum(r) / len(r)) for a, r in auth.items()), key=lambda t: (t[1] * t[2]), reverse=True)

    cat_score = defaultdict(lambda: [0, 0.0])
    for b in read:
        if b["my_rating"]:
            for c in _cats(b):
                cat_score[c][0] += 1
                cat_score[c][1] += b["my_rating"]
    cats = sorted(((c, n, s / n) for c, (n, s) in cat_score.items()), key=lambda t: t[1], reverse=True)[:15]
    recent = sorted((b for b in read if b["date_read"]), key=lambda b: b["date_read"], reverse=True)[:15]

    return {
        "counts": {k: len(v) for k, v in by_shelf.items()},
        "loved": [_line(b) for b in read if b["my_rating"] == 5],
        "liked": [_line(b) for b in read if b["my_rating"] == 4],
        "meh": [_line(b) for b in read if b["my_rating"] == 3][:60],
        "disliked": [_line(b) for b in read if 0 < b["my_rating"] <= 2],
        "top_authors": [f"{a}: {n} books, avg {avg:.1f}★" for a, n, avg in author_stats[:25]],
        "categories": [f"{c}: {n} books, avg {avg:.1f}★" for c, n, avg in cats],
        "recent": [f"{_line(b)} [{b['my_rating'] or '-'}★, {b['date_read']}]" for b in recent],
        "currently_reading": [_line(b) for b in by_shelf["currently-reading"]][:40],
        "to_read": [_line(b) for b in by_shelf["to-read"]],
        "owned": [f"{r['title']}" + (f" — {r['author']}" if r["author"] else "") for r in conn.execute("SELECT title, author FROM owned ORDER BY title")],
        "known": known_set(conn),
    }


def _profile_text_full(p: dict, n: int) -> str:
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


# --- "distilled" profile: ranked taste signals instead of a title dump -------------------------------
# A flat list of 400 titles buries the signal: 3★ and 5★ lines look identical to the model, famous books say
# little about taste, and stale reads weigh as much as last month's. The distilled profile instead gives:
#   · signature books  — 5★ reads ranked by (recency + how far the reader out-rated the crowd), capped at 2 per
#                        author for breadth. No blurbs: Google's are marketing copy, and the model knows the books.
#   · author record    — one line per author (count, avg, best, worst) instead of 20 lines of Neal Asher
#   · anti-signal      — 1-2★ reads plus books the crowd loved and the reader didn't
#   · genre lift       — category avg minus the reader's own mean, so a harsh rater's 4★ still reads as praise
#   · trajectory, recent Kindle purchases, finished-but-unlogged Kindle books, and past rec feedback
#   · a compact dedup list, marked as NOT a taste signal
def build_distilled(conn) -> dict:
    read = [dict(r) for r in conn.execute("SELECT * FROM books WHERE exclusive_shelf='read'")]
    rated = [b for b in read if b["my_rating"]]
    mean = sum(b["my_rating"] for b in rated) / len(rated) if rated else 3.0
    dist = {s: sum(1 for b in rated if b["my_rating"] == s) for s in range(1, 6)}

    def score(b):
        s = 1.0
        age = _age_years(b)
        s += 0.5 ** ((age if age is not None else 8) / 4)       # half-life of 4 years
        if b.get("google_rating"):
            # out-rated the crowd → distinctive taste. Centred on a typical 4★ crowd score so books
            # without a crowd rating (most of them) aren't penalised relative to ones with it.
            s += max(-0.5, min(0.75, (b["my_rating"] - b["google_rating"] - 1) / 2))
        return s

    def pick(pool, limit, per_author=2):
        out, per = [], defaultdict(int)
        for b in sorted(pool, key=score, reverse=True):
            if per[b["author"]] < per_author:
                out.append(b)
                per[b["author"]] += 1
            if len(out) >= limit:
                break
        return out

    def rich(b):
        bits = [_line(b)]
        cats = [c for c in _cats(b) if c != "Fiction"][:2]
        if cats:
            bits.append("/".join(cats))
        if b.get("google_rating"):
            bits.append(f"crowd {b['google_rating']:.1f}★ → theirs {b['my_rating']}★")
        yr = (b.get("date_read") or "")[:4]
        if yr:
            bits.append(f"read {yr}")
        return " · ".join(bits)

    signature = pick([b for b in rated if b["my_rating"] == 5], 30)
    if len(signature) < 30:
        signature += pick([b for b in rated if b["my_rating"] == 4], 30 - len(signature), per_author=1)

    by_author = defaultdict(list)
    for b in rated:
        by_author[b["author"]].append(b)
    authors = []
    for a, bs in sorted(((_ws(a), bs) for a, bs in by_author.items()), key=lambda kv: -(len(kv[1]) * sum(x["my_rating"] for x in kv[1]) / len(kv[1]))):
        if len(bs) < 2:
            continue
        avg = sum(x["my_rating"] for x in bs) / len(bs)
        best = max(bs, key=lambda x: (x["my_rating"], score(x)))
        worst = min(bs, key=lambda x: (x["my_rating"], -score(x)))
        tail = f" — best: {best['title']} ({best['my_rating']}★)"
        if worst["my_rating"] < best["my_rating"]:
            tail += f", weakest: {worst['title']} ({worst['my_rating']}★)"
        authors.append(f"{a}: {len(bs)} rated, avg {avg:.1f}★{tail}")

    anti_pool = [b for b in rated if b["my_rating"] <= 2
                 or (b["my_rating"] <= 3 and b.get("google_rating") and b["google_rating"] - b["my_rating"] >= 1.0)]
    anti = [rich(b) + ("" if b.get("google_rating") else f" · theirs {b['my_rating']}★")
            for b in sorted(anti_pool, key=lambda b: b["my_rating"])[:20]]

    cat = defaultdict(list)
    for b in rated:
        for c in _cats(b):
            cat[c].append(b["my_rating"])
    lifts = sorted(((c, len(r), sum(r) / len(r) - mean) for c, r in cat.items() if len(r) >= 4 and c != "Fiction"),
                   key=lambda t: t[2], reverse=True)
    genre = [f"{c}: {n} rated, {d:+.2f}★ vs their mean" for c, n, d in lifts[:10]]
    if len(lifts) > 10:
        genre += [f"{c}: {n} rated, {d:+.2f}★ vs their mean" for c, n, d in lifts[-5:] if d < 0]

    recent = sorted((b for b in read if b["date_read"]), key=lambda b: b["date_read"], reverse=True)[:15]

    fmt = lambda r: r["title"] + (f" — {r['author']}" if r["author"] else "")  # noqa: E731
    kindle = [dict(r) for r in conn.execute(
        "SELECT title, author FROM owned WHERE kindle_rank IS NOT NULL AND COALESCE(resource_type, '') != 'EBOOK_SAMPLE' "
        "ORDER BY kindle_rank")]
    recent_buys = [fmt(r) for r in kindle[:15]]
    # Amazon reports 0% read for everything, so the rule is: a Kindle purchase is a read book. The ones never rated
    # (Kindle-only, or unrated in Goodreads) still show what they chose to buy and finish.
    unrated_kindle = [fmt(r) for r in conn.execute(
        "SELECT title, author FROM books WHERE exclusive_shelf='read' AND my_rating=0 AND asin IS NOT NULL "
        "ORDER BY kindle_rank IS NULL, kindle_rank LIMIT 40")]

    return {
        "summary": (f"{len(read)} books read, {len(rated)} rated, mean {mean:.2f}★ "
                    f"(5★ {dist[5]}, 4★ {dist[4]}, 3★ {dist[3]}, 2★ {dist[2]}, 1★ {dist[1]})."
                    + (f" Kindle library: {len(kindle)} books." if kindle else "")),
        "signature": [rich(b) for b in signature],
        "authors": authors[:35],
        "anti": anti,
        "genre": genre,
        "recent": [f"{_line(b)} [{b['my_rating'] or '-'}★, {b['date_read']}]" for b in recent],
        "recent_buys": recent_buys,
        "unrated_kindle": unrated_kindle,
        "feedback": _feedback(conn),
        "dedup": _dedup_block(conn),
        "known": known_set(conn),
    }


def _profile_text_distilled(p: dict, n: int) -> str:
    def block(name, items, note=""):
        head = f"\n## {name}" + (f"\n{note}" if note else "")
        return head + "\n" + ("\n".join(f"- {i}" for i in items) if items else "- (none)")

    fb = p["feedback"]
    return (
        f"# Reader profile\n{p['summary']}\n"
        + block("Signature books", p["signature"],
                "Their most telling 5★ reads, ranked by recency and by how far they out-rated the crowd.")
        + block("Author record", p["authors"], "Authors with 2+ rated books.")
        + block("What they bounce off", p["anti"], "1–2★ reads, and books the crowd rated a full star higher than they did.")
        + block("Genre lift", p["genre"], "Average rating per Google Books category relative to their own mean.")
        + block("Reading trajectory (most recent first)", p["recent"])
        + block("Recent Kindle purchases (newest first)", p["recent_buys"],
                "Show what they're in the mood for right now. Already owned, so never recommend these.")
        + block("Read on Kindle, never rated (newest purchase first)", p["unrated_kindle"],
                "They bought and read these but left no rating. A weak signal: count them as finished, not as loved.")
        + block("Past recommendations they rejected", fb["rejected"])
        + block("Past recommendations they accepted", fb["accepted"])
        + block("Already read, shelved, or owned (for de-duplication only, not a taste signal)", p["dedup"],
                "Author: title; title; … Never recommend any of these, or another edition of one.")
        + f"\n\nGive exactly {n} recommendations."
    )


PROFILE_MODES = {"distilled": (build_distilled, _profile_text_distilled), "full": (build_profile, _profile_text_full)}


def profile_prompt(conn, mode: str, n: int) -> tuple[dict, str]:
    build, text = PROFILE_MODES.get(mode, PROFILE_MODES["distilled"])
    p = build(conn)
    return p, text(p, n)


SYSTEM = """You are a sharp, well-read book recommender for one reader who reads only on Kindle and buys from Amazon US.
You get a profile of their reading: ratings run from 1 to 5 stars, and 0 means unrated. Before you choose anything, work out
what actually drives their taste: themes, scale, tone, prose style, pacing, and structure. Genre labels alone are not enough.
Weigh books they rated above the crowd most heavily, because those reveal taste that popularity doesn't explain. Learn from
what they bounce off and from recommendations they rejected. Recent reads and purchases show their current direction.
Rules:
- Recommend only real, published books that are sold on the Kindle store. Never invent a title.
- Never recommend anything they have already read, shelved, or bought, including other editions. Check each pick against the
  de-duplication list before you include it. The most famous books by their favourite authors are probably already on that list.
- Mix them: about half should be unread books by authors they already love, and about half by authors new to them. Include at most one wildcard.
- Prefer a standalone book or the first book of a series, unless the reader is clearly partway through that series.
- Make each reason specific: name the books in their history that make this a match, and say what the shared quality is.
- Set confidence to a value from 0 to 1."""

REC_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["taste_summary", "recommendations"],
    "properties": {
        "taste_summary": {"type": "string", "description": "2-3 sentence portrait of the reader"},
        "recommendations": {"type": "array", "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["title", "author", "year", "reason", "hook", "confidence"],
            "properties": {
                "title": {"type": "string"},
                "author": {"type": "string"},
                "year": {"type": "integer"},
                "reason": {"type": "string", "description": "why this fits, citing their history"},
                "hook": {"type": "string", "description": "one-line pitch"},
                "confidence": {"type": "number"},
            },
        }},
    },
}


def _parse(raw: str) -> dict:
    raw = raw.strip()
    m = re.search(r"\{.*\}", raw, re.S)
    if m:
        raw = m.group(0)
    return json.loads(raw)


# --- a run: think → check the Kindle store → enrich → store ----------------------------------------------
# Runs execute as background tasks so the UI can show each stage; the stage lives in rec_runs.stage.
_tasks: set[asyncio.Task] = set()
OVERASK = 6  # ask for n+6: a few always turn out to be owned already or missing from the Kindle store


def start_run(model: str | None, mood: str | None, n: int = 10, effort: str | None = None,
              profile_mode: str = "distilled", batch_id: str | None = None, verify: bool = True) -> int:
    model = model or openrouter.DEFAULT_MODEL
    with get_conn() as conn:
        _, user_msg = profile_prompt(conn, profile_mode, n + OVERASK)
        if mood:
            user_msg += f"\n\nReader's note for this batch: {mood}"
        cur = conn.execute(
            "INSERT INTO rec_runs(created_at, model, mood, prompt, status, stage, profile_mode, effort, batch_id, n, verify) "
            "VALUES(?,?,?,?, 'running', 'thinking', ?,?,?,?,?)",
            (now(), model, mood, user_msg, profile_mode, effort, batch_id, n, int(verify)))
        run_id = cur.lastrowid
    task = asyncio.create_task(execute_run(run_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return run_id


def _set_stage(run_id: int, stage: str, note: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE rec_runs SET stage=?, store_note=COALESCE(?, store_note) WHERE id=?", (stage, note, run_id))


def _big_cover(url: str | None) -> str | None:
    # search thumbnails are 218px tall ("._AC_UY218_.jpg"); the same image at 450px reads better on a card
    return re.sub(r"\._[A-Z0-9_,]+_\.(jpg|png)$", r"._SY450_.\1", url) if url else None


def _remember_owned(conn, rec: dict, store: dict) -> None:
    """The store says they own it but the ledger didn't know: record it so later runs exclude it up front."""
    if not conn.execute("SELECT 1 FROM owned WHERE asin=?", (store["asin"],)).fetchone():
        conn.execute("INSERT INTO owned(title, author, norm_title, asin, cover, source, added_at) VALUES(?,?,?,?,?,'store-check',?)",
                     (rec.get("title"), rec.get("author"), _norm_title(rec.get("title")), store["asin"], store.get("cover"), now()))


async def execute_run(run_id: int) -> None:
    with get_conn() as conn:
        run = dict(conn.execute("SELECT * FROM rec_runs WHERE id=?", (run_id,)).fetchone())
    n = run["n"] or 10
    try:
        raw, served = await openrouter.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": run["prompt"]}],
                                            model=run["model"], effort=run["effort"], schema=REC_SCHEMA)
        data = _parse(raw)
        with get_conn() as conn:
            known, asins = known_set(conn), owned_asins(conn)
        # drop anything already in the library or owned list (defensive; the model is told not to)
        kept, dropped = [], []
        for r in data.get("recommendations", []):
            hit = is_known(r.get("title", ""), r.get("author"), known)
            if hit:
                dropped.append({"title": r.get("title"), "author": r.get("author"), "why": "already in your library"})
            else:
                kept.append(r)

        stores: list[dict | None] = [None] * len(kept)
        note = None
        if run["verify"] and kept:
            _set_stage(run_id, "checking")
            try:
                stores = await amazon_store.check(kept, asins)
                misses = sum(1 for s in stores if s is None)
                if misses == len(stores):
                    note = "Couldn't reach the Kindle store; links go to an Amazon search instead"
            except Exception as e:  # noqa: BLE001
                note = f"Kindle store check skipped: {str(e)[:240]}"

        # the model's order, books for sale on Kindle first; owned ones never; unconfirmed ones only to fill up
        final, filler = [], []
        with get_conn() as conn:
            for r, s in zip(kept, stores):
                if s and s["status"] == "owned":
                    dropped.append({"title": r.get("title"), "author": r.get("author"), "why": "you own it on Kindle"})
                    _remember_owned(conn, r, s)
                elif s and s["status"] == "not-found":
                    filler.append((r, s))
                else:
                    final.append((r, s))
        final = (final + filler)[:n]

        _set_stage(run_id, "enriching", note)
        async with httpx.AsyncClient(headers={"User-Agent": "findMyNextBook/1.0"}) as client:
            async def enrich(r):
                try:
                    return await google_books.lookup(client, r["title"], r.get("author"), None, None)
                except Exception:  # noqa: BLE001
                    return None
            metas = await asyncio.gather(*(enrich(r) for r, _ in final))

        with get_conn() as conn:
            for i, ((r, s), meta) in enumerate(zip(final, metas), 1):
                meta, s = meta or {}, s or {}
                conn.execute(
                    """INSERT INTO recommendations(run_id,rank,title,author,year,reason,hook,confidence,google_id,isbn13,
                       thumbnail,description,categories,google_rating,amazon_url,status,created_at,
                       asin,price,ku,amazon_rating,amazon_reviews,amazon_status,series)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?,?,?,?,?,?)""",
                    (run_id, i, r.get("title"), r.get("author"), r.get("year"), r.get("reason"), r.get("hook"),
                     r.get("confidence"), meta.get("google_id"), meta.get("isbn13"),
                     _big_cover(s.get("cover")) or meta.get("thumbnail"), meta.get("description"), meta.get("categories"),
                     meta.get("google_rating"), s.get("url") or amazon_kindle_url(r.get("title", ""), r.get("author")), now(),
                     s.get("asin"), s.get("price"), int(bool(s.get("ku"))) if s else None, s.get("stars"), s.get("ratings"),
                     s.get("status"), s.get("series")),
                )
            conn.execute("UPDATE rec_runs SET raw_response=?, status='done', stage='done', served_model=? WHERE id=?",
                         (json.dumps({"taste_summary": data.get("taste_summary"), "dropped": dropped, "raw": raw}), served, run_id))
    except Exception as e:  # noqa: BLE001
        with get_conn() as conn:
            conn.execute("UPDATE rec_runs SET status='error', stage='error', error=? WHERE id=?", (str(e)[:1000], run_id))
