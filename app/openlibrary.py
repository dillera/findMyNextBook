"""Open Library fallback used when Google Books is quota-limited. Returns the same meta shape as google_books."""
import json

import httpx

SEARCH = "https://openlibrary.org/search.json"
FIELDS = "key,title,author_name,first_publish_year,cover_i,isbn,subject,ratings_average,ratings_count,number_of_pages_median"


async def lookup(client: httpx.AsyncClient, title: str, author: str | None, isbn13: str | None) -> dict | None:
    params = {"limit": 3, "fields": FIELDS}
    if isbn13:
        params["isbn"] = isbn13
    else:
        params["title"] = title
        if author:
            params["author"] = author.split()[-1]
    r = await client.get(SEARCH, params=params, timeout=20)
    r.raise_for_status()
    docs = r.json().get("docs", [])
    if not docs and isbn13:  # ISBN miss -> retry by title
        return await lookup(client, title, author, None)
    if not docs:
        return None
    d = docs[0]
    desc = None
    try:
        w = await client.get(f"https://openlibrary.org{d['key']}.json", timeout=20)
        if w.status_code == 200:
            dd = w.json().get("description")
            desc = dd.get("value") if isinstance(dd, dict) else dd
    except httpx.HTTPError:
        pass
    isbns = [i for i in d.get("isbn", []) if len(i) == 13]
    return {
        "google_id": None,
        "title": d.get("title"),
        "authors": d.get("author_name") or [],
        "description": desc,
        "categories": json.dumps((d.get("subject") or [])[:6]),
        "thumbnail": f"https://covers.openlibrary.org/b/id/{d['cover_i']}-M.jpg" if d.get("cover_i") else None,
        "google_rating": round(d["ratings_average"], 1) if d.get("ratings_average") else None,
        "google_ratings_count": d.get("ratings_count"),
        "google_pages": d.get("number_of_pages_median"),
        "google_published": str(d["first_publish_year"]) if d.get("first_publish_year") else None,
        "isbn13": isbn13 or (isbns[0] if isbns else None),
        "isbn10": None,
        "source": "openlibrary",
    }
