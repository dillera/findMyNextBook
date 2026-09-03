"""findMyNextBook — FastAPI server: library API + Google Books + OpenRouter recommendations + static UI."""
import asyncio
import json
import os
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import google_books, openrouter, owned, recommend
from .db import get_conn, init_db, now, row_to_dict, get_setting, set_setting
from .importer import import_csv_text

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
ROOT = os.path.join(os.path.dirname(__file__), "..")
STATIC = os.path.join(ROOT, "static")

app = FastAPI(title="findMyNextBook")
init_db()

SHELVES = ("read", "currently-reading", "to-read", "abandoned")


# --- library --------------------------------------------------------------------------------------
@app.get("/api/books")
def list_books(q: str = "", shelf: str = "", rating: str = "", author: str = "", sort: str = "date_added",
               dir: str = "desc", limit: int = 2000, offset: int = 0):
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
    sql = "SELECT * FROM books" + (" WHERE " + " AND ".join(where) if where else "")
    sql += f" ORDER BY {sort} {dir} NULLS LAST, title ASC LIMIT ? OFFSET ?"
    with get_conn() as conn:
        rows = [row_to_dict(r) for r in conn.execute(sql, params + [limit, offset])]
        total = conn.execute("SELECT COUNT(*) FROM books" + (" WHERE " + " AND ".join(where) if where else ""), params).fetchone()[0]
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
               google_rating,google_id,binding,date_added,enriched_at,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,'Kindle Edition',?,?,?,?)""",
            (b.title, b.author, b.isbn13, b.exclusive_shelf, b.description, b.thumbnail,
             json.dumps(b.categories or []), b.year, b.pages, b.google_rating, b.google_id, ts[:10],
             ts if b.google_id else None, ts, ts),
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
            "categories": categories}


@app.get("/api/authors")
def authors():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT author, COUNT(*) n FROM books GROUP BY author ORDER BY n DESC, author")]


# --- import ---------------------------------------------------------------------------------------
@app.post("/api/import")
async def import_csv(file: UploadFile):
    text = (await file.read()).decode("utf-8-sig")
    return import_csv_text(text)


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
    mood: Optional[str] = None
    n: int = 10


@app.post("/api/recommend")
async def make_recs(req: RecRequest):
    try:
        run_id = await recommend.run_recommendation(req.model, req.mood, max(3, min(req.n, 25)))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))
    with get_conn() as conn:
        set_setting(conn, "last_model", req.model or openrouter.DEFAULT_MODEL)
    return get_run(run_id)


@app.get("/api/recommend/runs")
def list_runs():
    with get_conn() as conn:
        runs = [dict(r) for r in conn.execute(
            "SELECT r.id, r.created_at, r.model, r.mood, r.status, r.error, "
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
    return run


@app.get("/api/recommend/prompt")
def preview_prompt(n: int = 10):
    with get_conn() as conn:
        p = recommend.build_profile(conn)
    return {"system": recommend.SYSTEM, "user": recommend._profile_text(p, n)}


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
    if p.status == "owned":
        owned.import_text(f"{rec['title']} — {rec['author'] or ''}", "rec")
    # "bought" / "added" both put the book on the to-read shelf so the next run excludes it
    if p.status in ("bought", "added"):
        rec = row_to_dict(rec)
        try:
            add_book(NewBook(title=rec["title"], author=rec["author"], google_id=rec["google_id"], isbn13=rec["isbn13"],
                             description=rec["description"], thumbnail=rec["thumbnail"], categories=rec["categories"],
                             year=rec["year"], google_rating=rec["google_rating"], exclusive_shelf="to-read"))
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
        rows = [dict(r) for r in conn.execute("SELECT id,title,author,source,added_at FROM owned ORDER BY title")]
    return {"owned": rows, "total": len(rows)}


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
async def models():
    try:
        return await openrouter.list_models()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))


@app.get("/api/config")
def config():
    with get_conn() as conn:
        last = get_setting(conn, "last_model")
    return {"openrouter_key": bool(os.environ.get("OPENROUTER_API_KEY")),
            "google_key": bool(os.environ.get("GOOGLE_BOOKS_API_KEY")),
            "default_model": last or os.environ.get("OPENROUTER_MODEL", openrouter.DEFAULT_MODEL)}


# --- static UI ------------------------------------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC), name="static")
