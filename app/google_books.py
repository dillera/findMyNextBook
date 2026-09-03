"""Google Books API v1 client. https://developers.google.com/books/docs/v1/using"""
import asyncio
import json
import os
import re

import httpx

from . import openlibrary
from .db import get_conn, now

quota_exhausted = {"google": False}

API = "https://www.googleapis.com/books/v1/volumes"


def _key() -> dict:
    k = os.environ.get("GOOGLE_BOOKS_API_KEY")
    return {"key": k} if k else {}


def _strip_series(title: str) -> str:
    """'Dark Diamond (A Time's Shadow #1)' -> 'Dark Diamond'"""
    return re.sub(r"\s*\((?:[^()]*#\d+[^()]*|[^()]*(?:Book|Trilogy|Series)[^()]*)\)\s*$", "", title, flags=re.I).strip()


def volume_to_meta(v: dict) -> dict:
    info = v.get("volumeInfo", {})
    ids = {i.get("type"): i.get("identifier") for i in info.get("industryIdentifiers", [])}
    thumb = (info.get("imageLinks") or {}).get("thumbnail") or (info.get("imageLinks") or {}).get("smallThumbnail")
    if thumb:
        thumb = thumb.replace("http://", "https://").replace("&edge=curl", "")
    return {
        "google_id": v.get("id"),
        "title": info.get("title"),
        "authors": info.get("authors") or [],
        "description": info.get("description"),
        "categories": json.dumps(info.get("categories") or []),
        "thumbnail": thumb,
        "google_rating": info.get("averageRating"),
        "google_ratings_count": info.get("ratingsCount"),
        "google_pages": info.get("pageCount"),
        "google_published": info.get("publishedDate"),
        "isbn13": ids.get("ISBN_13"),
        "isbn10": ids.get("ISBN_10"),
    }


async def search(client: httpx.AsyncClient, q: str, max_results: int = 5) -> list[dict]:
    # Google Books enforces a per-minute rate limit as well as a daily quota; back off on 429 before giving up.
    for attempt in range(4):
        r = await client.get(API, params={"q": q, "maxResults": max_results, "printType": "books", **_key()}, timeout=20)
        if r.status_code != 429:
            break
        if "per day" in r.text:
            quota_exhausted["google"] = True
            raise RuntimeError("Google Books daily quota exceeded (429). Set GOOGLE_BOOKS_API_KEY in .env for your own quota.")
        await asyncio.sleep(5 * (attempt + 1))
    else:
        quota_exhausted["google"] = True
        raise RuntimeError("Google Books rate limit (429) persisted after retries")
    quota_exhausted["google"] = False
    r.raise_for_status()
    return [volume_to_meta(v) for v in r.json().get("items", [])]


async def lookup(client: httpx.AsyncClient, title: str, author: str | None, isbn13: str | None, isbn: str | None) -> dict | None:
    """Try ISBN first (exact), then title+author, then bare title."""
    queries = []
    if isbn13:
        queries.append(f"isbn:{isbn13}")
    if isbn:
        queries.append(f"isbn:{isbn}")
    short = _strip_series(title)
    if author:
        surname = author.split()[-1]
        queries.append(f'intitle:"{short}" inauthor:{surname}')
    queries.append(f'intitle:"{short}"')
    google_failed = False
    for q in queries:
        try:
            hits = await search(client, q, 5)
        except (httpx.HTTPError, RuntimeError):
            google_failed = True
            break
        if not hits:
            continue
        # prefer a hit that has a description and a cover
        hits.sort(key=lambda h: (bool(h["description"]), bool(h["thumbnail"]), h["google_ratings_count"] or 0), reverse=True)
        hits[0]["source"] = "google"
        return hits[0]
    # Google quota-limited or errored -> fall back to Open Library so covers/blurbs still fill in
    if google_failed:
        try:
            return await openlibrary.lookup(client, title, author, isbn13)
        except (httpx.HTTPError, ValueError):
            return None
    return None


# --- background enrichment of the whole library -------------------------------------------------
_progress = {"running": False, "done": 0, "total": 0, "failed": 0, "current": ""}


def progress() -> dict:
    return {**_progress, "google_quota_exhausted": quota_exhausted["google"]}


async def enrich_book(client: httpx.AsyncClient, book: dict) -> bool:
    meta = await lookup(client, book["title"], book["author"], book["isbn13"], book["isbn"])
    with get_conn() as conn:
        if not meta:
            conn.execute("UPDATE books SET enriched_at=?, enrich_error='not found' WHERE id=?", (now(), book["id"]))
            return False
        google_id = meta["google_id"]  # None when the hit came from Open Library
        conn.execute(
            """UPDATE books SET google_id=?, description=?, categories=?, thumbnail=?, google_rating=?,
               google_ratings_count=?, google_pages=?, google_published=?, isbn13=COALESCE(isbn13,?),
               enriched_at=?, enrich_error=NULL WHERE id=?""",
            (google_id, meta["description"], meta["categories"], meta["thumbnail"], meta["google_rating"],
             meta["google_ratings_count"], meta["google_pages"], meta["google_published"], meta["isbn13"],
             now(), book["id"]),
        )
    return True


async def enrich_all(only_missing: bool = True, concurrency: int = 2) -> None:
    if _progress["running"]:
        return
    with get_conn() as conn:
        # "missing" = never enriched OR only has Open Library data (no Google volume id)
        where = "WHERE google_id IS NULL" if only_missing else ""
        books = [dict(r) for r in conn.execute(f"SELECT id,title,author,isbn,isbn13 FROM books {where} ORDER BY id")]
    _progress.update(running=True, done=0, failed=0, total=len(books), current="")
    sem = asyncio.Semaphore(concurrency)
    try:
        async with httpx.AsyncClient(headers={"User-Agent": "findMyNextBook/1.0"}) as client:
            async def one(b):
                async with sem:
                    _progress["current"] = b["title"]
                    try:
                        ok = await enrich_book(client, b)
                    except Exception as e:  # noqa: BLE001
                        ok = False
                        with get_conn() as conn:
                            conn.execute("UPDATE books SET enrich_error=? WHERE id=?", (str(e)[:200], b["id"]))
                    _progress["done"] += 1
                    if not ok:
                        _progress["failed"] += 1
                    await asyncio.sleep(0.6)  # stay under Google's per-minute limit
            await asyncio.gather(*(one(b) for b in books))
    finally:
        _progress["running"] = False
        _progress["current"] = ""
