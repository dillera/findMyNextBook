"""findMyNextBook — FastAPI server: library API + Google Books + OpenRouter recommendations + static UI."""
import asyncio
import json
import os
import uuid
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import amazon_orders, google_books, kindle_sync, openrouter, owned, recommend
from .db import get_conn, init_db, now, row_to_dict, get_setting, set_setting
from .importer import import_csv_text

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
ROOT = os.path.join(os.path.dirname(__file__), "..")
STATIC = os.path.join(ROOT, "static")

app = FastAPI(title="findMyNextBook")
init_db()


@app.middleware("http")
async def revalidate_ui(request, call_next):
    """The UI files change with the code; make the browser check for a newer copy (a 304 when unchanged)."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

SHELVES = ("read", "currently-reading", "to-read", "abandoned")


# --- library --------------------------------------------------------------------------------------
@app.get("/api/books")
def list_books(q: str = "", shelf: str = "", rating: str = "", author: str = "", sort: str = "date_added",
               dir: str = "desc", kindle: bool = False, unrated: bool = False, limit: int = 2000, offset: int = 0):
    sort_cols = {"title", "author", "my_rating", "date_read", "date_added", "original_year", "pages", "google_rating"}
    if sort not in sort_cols:
        sort = "date_added"
    dir = "ASC" if dir.lower() == "asc" else "DESC"
    where, params = [], []
    if q:
        where.append("(title LIKE ? OR author LIKE ? OR additional_authors LIKE ? OR description LIKE ?)")
        params += [f"%{q}%"] * 4
    if shelf:
        where.append("exclusive_shelf=?")
        params.append(shelf)
    if rating:
        where.append("my_rating=?")
        params.append(int(rating))
    if author:
        where.append("author=?")
        params.append(author)
    if kindle:
        where.append("asin IS NOT NULL")
    if unrated:
        where.append("exclusive_shelf='read' AND my_rating=0")
    sql = "SELECT * FROM books" + (" WHERE " + " AND ".join(where) if where else "")
    sql += f" ORDER BY {sort} {dir} NULLS LAST, title ASC LIMIT ? OFFSET ?"
    with get_conn() as conn:
        rows = [row_to_dict(r) for r in conn.execute(sql, params + [limit, offset])]
        total = conn.execute("SELECT COUNT(*) FROM books" + (" WHERE " + " AND ".join(where) if where else ""), params).fetchone()[0]
    return {"books": rows, "total": total}


@app.get("/api/status")
def status():
    """Everything the header, the onboarding banner and the library chips need, in one call."""
    with get_conn() as conn:
        c = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
        out = {
            "books": c("SELECT COUNT(*) FROM books"),
            "shelves": {r[0]: r[1] for r in conn.execute("SELECT exclusive_shelf, COUNT(*) FROM books GROUP BY 1")},
            "rated": c("SELECT COUNT(*) FROM books WHERE my_rating > 0"),
            "unrated_read": c("SELECT COUNT(*) FROM books WHERE exclusive_shelf='read' AND my_rating=0"),
            "on_kindle": c("SELECT COUNT(*) FROM books WHERE asin IS NOT NULL"),
            "goodreads": c("SELECT COUNT(*) FROM books WHERE goodreads_id IS NOT NULL"),
            "kindle_ledger": c("SELECT COUNT(*) FROM owned WHERE asin IS NOT NULL"),
            "kindle_pending": c("SELECT COUNT(*) FROM owned WHERE asin IS NOT NULL AND book_id IS NULL "
                                "AND COALESCE(resource_type, '') != 'EBOOK_SAMPLE'"),
            "kindle_last_sync": get_setting(conn, "kindle_last_sync"),
            "kindle_last_apply": get_setting(conn, "kindle_last_apply"),
            "runs": c("SELECT COUNT(*) FROM rec_runs"),
            "enriched": c("SELECT COUNT(*) FROM books WHERE enriched_at IS NOT NULL AND enrich_error IS NULL"),
        }
    out.update(openrouter_key=bool(os.environ.get("OPENROUTER_API_KEY")), google_key=bool(os.environ.get("GOOGLE_BOOKS_API_KEY")),
               kindle_sync=kindle_sync.progress(), enrich=google_books.progress())
    return out


@app.get("/api/books/to-rate")
def books_to_rate(limit: int = 24, offset: int = 0):
    """Read but unrated, newest Kindle purchase first: the books the wizard asks about."""
    where = "WHERE exclusive_shelf='read' AND my_rating=0"
    with get_conn() as conn:
        rows = [row_to_dict(r) for r in conn.execute(
            f"SELECT * FROM books {where} ORDER BY kindle_rank IS NULL, kindle_rank, date_read DESC, id DESC LIMIT ? OFFSET ?",
            (limit, offset))]
        total = conn.execute(f"SELECT COUNT(*) FROM books {where}").fetchone()[0]
    return {"books": rows, "total": total}


@app.get("/api/books/{book_id}")
def get_book(book_id: int):
    with get_conn() as conn:
        r = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    return row_to_dict(r)


class BookPatch(BaseModel):
    my_rating: Optional[int] = None
    exclusive_shelf: Optional[str] = None
    date_read: Optional[str] = None
    user_notes: Optional[str] = None
    review: Optional[str] = None


@app.patch("/api/books/{book_id}")
def patch_book(book_id: int, patch: BookPatch):
    fields = {k: v for k, v in patch.model_dump().items() if v is not None}
    if "exclusive_shelf" in fields and fields["exclusive_shelf"] not in SHELVES:
        raise HTTPException(400, f"shelf must be one of {SHELVES}")
    if "my_rating" in fields and not 0 <= fields["my_rating"] <= 5:
        raise HTTPException(400, "rating 0-5")
    if fields.get("exclusive_shelf") == "read" and "date_read" not in fields:
        with get_conn() as conn:
            cur = conn.execute("SELECT date_read FROM books WHERE id=?", (book_id,)).fetchone()
        if cur and not cur["date_read"]:
            fields["date_read"] = now()[:10]
    if not fields:
        return get_book(book_id)
    sets = ", ".join(f"{k}=?" for k in fields) + ", updated_at=?"
    with get_conn() as conn:
        conn.execute(f"UPDATE books SET {sets} WHERE id=?", [*fields.values(), now(), book_id])
    return get_book(book_id)


@app.delete("/api/books/{book_id}")
def delete_book(book_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM books WHERE id=?", (book_id,))
    return {"ok": True}


class NewBook(BaseModel):
    title: str
    author: Optional[str] = None
    google_id: Optional[str] = None
    isbn13: Optional[str] = None
    exclusive_shelf: str = "to-read"
    description: Optional[str] = None
    thumbnail: Optional[str] = None
    categories: Optional[list[str]] = None
    year: Optional[int] = None
    pages: Optional[int] = None
    google_rating: Optional[float] = None
    asin: Optional[str] = None
    source: str = "manual"


@app.post("/api/books")
def add_book(b: NewBook):
    if b.exclusive_shelf not in SHELVES:
        raise HTTPException(400, "bad shelf")
    ts = now()
    with get_conn() as conn:
        dup = conn.execute("SELECT id FROM books WHERE lower(title)=lower(?) AND lower(COALESCE(author,''))=lower(?)",
                           (b.title, b.author or "")).fetchone()
        if dup:
            raise HTTPException(409, "already in library")
        cur = conn.execute(
            """INSERT INTO books(title,author,isbn13,exclusive_shelf,description,thumbnail,categories,original_year,pages,
               google_rating,google_id,binding,date_added,enriched_at,asin,source,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,'Kindle Edition',?,?,?,?,?,?)""",
            (b.title, b.author, b.isbn13, b.exclusive_shelf, b.description, b.thumbnail,
             json.dumps(b.categories or []), b.year, b.pages, b.google_rating, b.google_id, ts[:10],
             ts if b.google_id else None, b.asin, b.source, ts, ts),
        )
        book_id = cur.lastrowid
    return get_book(book_id)


@app.get("/api/stats")
def stats():
    with get_conn() as conn:
        c = conn.execute
        shelves = {r[0]: r[1] for r in c("SELECT exclusive_shelf, COUNT(*) FROM books GROUP BY 1")}
        ratings = {r[0]: r[1] for r in c("SELECT my_rating, COUNT(*) FROM books WHERE exclusive_shelf='read' GROUP BY 1")}
        by_year = [dict(r) for r in c(
            "SELECT substr(date_read,1,4) AS year, COUNT(*) AS n, SUM(COALESCE(pages,0)) AS pages FROM books "
            "WHERE exclusive_shelf='read' AND date_read IS NOT NULL GROUP BY 1 ORDER BY 1")]
        by_month = [dict(r) for r in c(
            "SELECT substr(date_read,1,7) AS month, COUNT(*) AS n FROM books WHERE exclusive_shelf='read' "
            "AND date_read >= date('now','-24 months') GROUP BY 1 ORDER BY 1")]
        authors = [dict(r) for r in c(
            "SELECT author, COUNT(*) AS n, ROUND(AVG(NULLIF(my_rating,0)),2) AS avg_rating FROM books "
            "WHERE exclusive_shelf='read' GROUP BY author ORDER BY n DESC, avg_rating DESC LIMIT 20")]
        pages = c("SELECT SUM(pages) FROM books WHERE exclusive_shelf='read'").fetchone()[0]
        avg = c("SELECT AVG(my_rating) FROM books WHERE exclusive_shelf='read' AND my_rating>0").fetchone()[0]
        enriched = c("SELECT COUNT(*) FROM books WHERE enriched_at IS NOT NULL AND enrich_error IS NULL").fetchone()[0]
        total = c("SELECT COUNT(*) FROM books").fetchone()[0]
        on_kindle = c("SELECT COUNT(*) FROM books WHERE asin IS NOT NULL").fetchone()[0]
        cats = {}
        for (cj, rating) in c("SELECT categories, my_rating FROM books WHERE categories IS NOT NULL AND exclusive_shelf='read'"):
            try:
                for cat in json.loads(cj):
                    cats.setdefault(cat, [0, 0])
                    cats[cat][0] += 1
                    cats[cat][1] += rating or 0
            except ValueError:
                pass
        categories = sorted(({"name": k, "n": v[0], "avg": round(v[1] / v[0], 2) if v[0] else 0} for k, v in cats.items()),
                            key=lambda d: d["n"], reverse=True)[:15]
    return {"shelves": shelves, "ratings": ratings, "by_year": by_year, "by_month": by_month, "authors": authors,
            "total_pages": pages or 0, "avg_rating": round(avg or 0, 2), "enriched": enriched, "total": total,
            "on_kindle": on_kindle, "categories": categories}


@app.get("/api/authors")
def authors():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT author, COUNT(*) n FROM books GROUP BY author ORDER BY n DESC, author")]


# --- import ---------------------------------------------------------------------------------------
@app.post("/api/import")
async def import_csv(file: UploadFile, background: BackgroundTasks):
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    if "Book Id" not in text.split("\n", 1)[0]:
        raise HTTPException(400, "That isn't a Goodreads library export (no “Book Id” column)")
    r = import_csv_text(text)
    if r["inserted"] and not google_books.progress()["running"]:
        background.add_task(google_books.enrich_all, True)
    return r


# --- Google Books ---------------------------------------------------------------------------------
@app.post("/api/enrich")
async def enrich(background: BackgroundTasks, all: bool = False):
    if google_books.progress()["running"]:
        return google_books.progress()
    background.add_task(google_books.enrich_all, not all)
    await asyncio.sleep(0.1)
    return google_books.progress()


@app.get("/api/enrich/progress")
def enrich_progress():
    return google_books.progress()


@app.post("/api/books/{book_id}/enrich")
async def enrich_one(book_id: int):
    with get_conn() as conn:
        b = conn.execute("SELECT id,title,author,isbn,isbn13 FROM books WHERE id=?", (book_id,)).fetchone()
    if not b:
        raise HTTPException(404)
    async with httpx.AsyncClient(headers={"User-Agent": "findMyNextBook/1.0"}) as client:
        try:
            ok = await google_books.enrich_book(client, dict(b))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, str(e))
    return {"ok": ok, "book": get_book(book_id)}


@app.get("/api/google/search")
async def google_search(q: str):
    async with httpx.AsyncClient() as client:
        try:
            hits = await google_books.search(client, q, 10)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, str(e))
    for h in hits:
        h["categories"] = json.loads(h["categories"])
        h["amazon_url"] = recommend.amazon_kindle_url(h["title"] or "", (h["authors"] or [None])[0])
    return hits


# --- recommendations ------------------------------------------------------------------------------
class RecRequest(BaseModel):
    model: Optional[str] = None
    models: Optional[list[str]] = None   # several → one run each, in parallel, grouped by batch_id
    mood: Optional[str] = None
    n: int = 10
    effort: Optional[str] = None         # low | medium | high | xhigh; None = model default
    profile: str = "distilled"           # distilled | full
    verify: bool = True                  # check each pick on the Kindle store (price, already owned)


@app.post("/api/recommend")
async def make_recs(req: RecRequest):
    """Starts one background run per model and returns their ids; poll /api/recommend/runs/{id} for the stage."""
    models = [m for m in (req.models or [req.model or openrouter.DEFAULT_MODEL]) if m][:6]
    if req.profile not in recommend.PROFILE_MODES:
        raise HTTPException(400, f"profile must be one of {list(recommend.PROFILE_MODES)}")
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise HTTPException(400, "OPENROUTER_API_KEY is not set: add it to .env and restart")
    batch_id = uuid.uuid4().hex[:12] if len(models) > 1 else None
    n = max(3, min(req.n, 25))
    run_ids = [recommend.start_run(m, req.mood, n, req.effort, req.profile, batch_id, req.verify) for m in models]
    with get_conn() as conn:
        set_setting(conn, "last_models", json.dumps(models))
        set_setting(conn, "last_effort", req.effort or "")
        set_setting(conn, "last_profile", req.profile)
        set_setting(conn, "last_verify", "1" if req.verify else "0")
        set_setting(conn, "last_n", str(n))
    return {"run_ids": run_ids, "batch_id": batch_id}


@app.get("/api/recommend/runs")
def list_runs():
    with get_conn() as conn:
        runs = [dict(r) for r in conn.execute(
            "SELECT r.id, r.created_at, r.model, r.mood, r.status, r.stage, r.error, r.effort, r.profile_mode, r.batch_id, r.served_model, "
            "(SELECT COUNT(*) FROM recommendations x WHERE x.run_id=r.id) AS n FROM rec_runs r ORDER BY id DESC")]
    return runs


@app.get("/api/recommend/runs/{run_id}")
def get_run(run_id: int):
    with get_conn() as conn:
        run = conn.execute("SELECT * FROM rec_runs WHERE id=?", (run_id,)).fetchone()
        if not run:
            raise HTTPException(404)
        run = dict(run)
        try:
            rr = json.loads(run.pop("raw_response") or "{}")
            run["taste_summary"], run["dropped"] = rr.get("taste_summary"), rr.get("dropped", [])
        except ValueError:
            run["taste_summary"], run["dropped"] = None, []
        run.pop("prompt", None)
        run["recommendations"] = [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM recommendations WHERE run_id=? ORDER BY rank", (run_id,))]
        # multi-model batch: mark picks that other models in the same batch also made
        if run.get("batch_id"):
            siblings = conn.execute("SELECT id, model FROM rec_runs WHERE batch_id=? AND id!=?", (run["batch_id"], run_id)).fetchall()
            others = [(s["model"], {(recommend._norm_title(r["title"]), recommend._surname(r["author"])) for r in conn.execute(
                "SELECT title, author FROM recommendations WHERE run_id=?", (s["id"],))}) for s in siblings]
            for rec in run["recommendations"]:
                rec["also_by"] = [m for m, known in others if recommend.is_known(rec["title"], rec["author"], known)]
            run["batch_models"] = [s["model"] for s in siblings]
    return run


@app.get("/api/recommend/prompt")
def preview_prompt(n: int = 10, profile: str = "distilled"):
    with get_conn() as conn:
        _, user = recommend.profile_prompt(conn, profile, n)
    return {"system": recommend.SYSTEM, "user": user, "chars": len(recommend.SYSTEM) + len(user)}


class RecPatch(BaseModel):
    status: str


@app.patch("/api/recommendations/{rec_id}")
def patch_rec(rec_id: int, p: RecPatch):
    if p.status not in ("new", "bought", "dismissed", "added", "owned"):
        raise HTTPException(400)
    with get_conn() as conn:
        rec = conn.execute("SELECT * FROM recommendations WHERE id=?", (rec_id,)).fetchone()
        if not rec:
            raise HTTPException(404)
        conn.execute("UPDATE recommendations SET status=? WHERE id=?", (p.status, rec_id))
    # every outcome but "not for me" shelves the book, so the next run excludes it. Bought / want-to-read go to
    # to-read; "already own it" goes to read, because a book you own counts as read (the Kindle import's rule too).
    shelf = {"bought": "to-read", "added": "to-read", "owned": "read"}.get(p.status)
    if shelf:
        rec = row_to_dict(rec)
        try:
            add_book(NewBook(title=rec["title"], author=rec["author"], google_id=rec["google_id"], isbn13=rec["isbn13"],
                             description=rec["description"], thumbnail=rec["thumbnail"], categories=rec["categories"],
                             year=rec["year"], google_rating=rec["google_rating"], exclusive_shelf=shelf,
                             asin=rec["asin"] if p.status != "added" else None, source="rec"))
        except HTTPException as e:
            if e.status_code != 409:
                raise
    return {"ok": True}


# --- owned-on-Kindle list -------------------------------------------------------------------------
class OwnedText(BaseModel):
    text: str
    source: str = "paste"


@app.get("/api/owned")
def list_owned():
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT id,title,author,source,added_at,asin,cover,percent_read,kindle_rank,first_seen_at FROM owned "
            "ORDER BY kindle_rank IS NULL, kindle_rank, title")]
    return {"owned": rows, "total": len(rows)}


# --- Amazon import: Kindle library (Playwright + the app's Chrome) and order history ----------------------
class KindleApply(BaseModel):
    include_samples: bool = False
    toread_as_read: bool = True


class KindlePaste(BaseModel):
    text: str


@app.post("/api/kindle/sync")
async def kindle_sync_start(background: BackgroundTasks):
    if not kindle_sync.progress()["running"]:
        background.add_task(kindle_sync.run_sync)
        await asyncio.sleep(0.1)
    return kindle_sync.progress()


@app.get("/api/kindle/sync")
def kindle_sync_progress():
    return kindle_sync.progress()


@app.get("/api/kindle/script")
def kindle_console_script():
    return {"script": kindle_sync.CONSOLE_SCRIPT, "url": kindle_sync.LIBRARY_URL}


@app.post("/api/kindle/paste")
def kindle_paste(body: KindlePaste):
    try:
        items = kindle_sync.parse_paste(body.text)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return kindle_sync.save_items(items)


@app.get("/api/kindle/preview")
def kindle_preview(include_samples: bool = False, toread_as_read: bool = True):
    return kindle_sync.preview(include_samples, toread_as_read)


@app.post("/api/kindle/apply")
async def kindle_apply(body: KindleApply, background: BackgroundTasks):
    r = kindle_sync.apply_to_library(body.include_samples, body.toread_as_read)
    # new books only have an Amazon cover; fetch blurbs and genres (the taste profile uses genres) in the background
    if r["added"] and not google_books.progress()["running"]:
        background.add_task(google_books.enrich_all, True)
    return r


@app.post("/api/amazon/orders")
async def amazon_orders_import(file: UploadFile, background: BackgroundTasks):
    data = await file.read()
    try:
        r = amazon_orders.import_orders(data)
    except Exception as e:  # noqa: BLE001  (a corrupt zip, a CSV in some other encoding…)
        raise HTTPException(400, f"Couldn't read that file: {e}")
    if r["added"] and not google_books.progress()["running"]:
        background.add_task(google_books.enrich_all, True)
    return r


@app.post("/api/owned")
def add_owned(body: OwnedText):
    return owned.import_text(body.text, body.source)


@app.post("/api/owned/import")
async def import_owned(file: UploadFile):
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    return owned.import_text(text, "amazon-export", file.filename or "")


@app.delete("/api/owned/{owned_id}")
def delete_owned(owned_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM owned WHERE id=?", (owned_id,))
    return {"ok": True}


@app.delete("/api/owned")
def clear_owned():
    with get_conn() as conn:
        conn.execute("DELETE FROM owned")
    return {"ok": True}


@app.get("/api/models")
async def models(provider: str = ""):
    try:
        return await openrouter.list_models(provider or None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))


@app.get("/api/config")
def config():
    with get_conn() as conn:
        last_models = json.loads(get_setting(conn, "last_models") or "null") or [get_setting(conn, "last_model")]
        effort = get_setting(conn, "last_effort") or ""
        profile = get_setting(conn, "last_profile") or "distilled"
        verify = get_setting(conn, "last_verify") != "0"
        last_n = int(get_setting(conn, "last_n") or 10)
    default = os.environ.get("OPENROUTER_MODEL", openrouter.DEFAULT_MODEL)
    return {"openrouter_key": bool(os.environ.get("OPENROUTER_API_KEY")),
            "google_key": bool(os.environ.get("GOOGLE_BOOKS_API_KEY")),
            "default_model": default, "last_models": [m for m in last_models if m] or [default],
            "last_effort": effort, "last_profile": profile, "last_verify": verify, "last_n": last_n}


# --- static UI ------------------------------------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC), name="static")
