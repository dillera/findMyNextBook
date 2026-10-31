#!/usr/bin/env python3
"""Turn the old server edition's SQLite database into a backup file for the browser edition.

    python3 tools/export_local_db.py [data/books.db] [-o data/findMyNextBook-backup.json]

Then open the app → Settings → Restore backup → pick the file. The file holds your library, the Kindle ledger and
your recommendation history, nothing else: no API keys (the browser edition asks for your own OpenRouter key).
Standard library only.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(HERE, "..", "data", "books.db")
BOOK_FIELDS = (
    "id goodreads_id title author additional_authors isbn isbn13 my_rating publisher binding pages year_published "
    "original_year date_read date_added shelves exclusive_shelf review private_notes read_count description categories "
    "thumbnail google_id google_rating google_ratings_count google_pages google_published enriched_at enrich_error "
    "user_notes asin source kindle_rank created_at updated_at"
).split()
REC_FIELDS = "rank title author year reason hook confidence thumbnail description categories google_rating google_id isbn13 amazon_url status".split()


def cols(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def as_list(v):
    try:
        out = json.loads(v) if v else []
    except ValueError:
        out = [v]
    return out if isinstance(out, list) else [out]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("db", nargs="?", default=DEFAULT_DB)
    ap.add_argument("-o", "--out", default=os.path.join(HERE, "..", "data", "findMyNextBook-backup.json"))
    a = ap.parse_args()
    if not os.path.exists(a.db):
        sys.exit(f"No database at {a.db}")
    conn = sqlite3.connect(f"file:{os.path.abspath(a.db)}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    have = cols(conn, "books")
    books = []
    for r in conn.execute("SELECT * FROM books ORDER BY id"):
        b = {k: r[k] for k in BOOK_FIELDS if k in have and r[k] is not None}
        b["categories"] = as_list(r["categories"]) if "categories" in have else []
        b["my_rating"] = r["my_rating"] or 0
        b["source"] = b.get("source") or ("goodreads" if b.get("goodreads_id") else "manual")
        b["edited"] = bool(r["updated_at"] and r["created_at"] and r["updated_at"] > r["created_at"])
        books.append(b)

    kindle, skipped_legacy, relink = [], 0, 0
    ocols = cols(conn, "owned")
    asin_of = {r["id"]: r["asin"] for r in conn.execute("SELECT id, asin FROM books")} if "asin" in have else {}
    if "asin" in ocols:
        for r in conn.execute("SELECT * FROM owned ORDER BY kindle_rank IS NULL, kindle_rank, id"):
            if not r["asin"]:
                skipped_legacy += 1
                continue
            g = lambda k: r[k] if k in ocols else None  # noqa: E731
            # keep a Kindle→book link only when the ASIN proves it; title-based links are re-made in the browser,
            # whose matcher no longer merges "Exodus: The Archimedes Engine" with "Exodus: The Helium Sea"
            book_id = g("book_id") if g("book_id") is not None and asin_of.get(g("book_id")) == r["asin"] else None
            relink += g("book_id") is not None and book_id is None
            kindle.append({"asin": r["asin"], "title": r["title"], "author": r["author"], "cover": g("cover"),
                           "resource_type": g("resource_type"), "origin": g("origin"), "kindle_rank": g("kindle_rank"),
                           "read_at": g("read_at"), "book_id": book_id, "first_seen_at": g("first_seen_at") or r["added_at"]})

    runs = []
    rcols, xcols = cols(conn, "rec_runs"), cols(conn, "recommendations")
    for r in conn.execute("SELECT * FROM rec_runs ORDER BY id"):
        g = lambda k: r[k] if k in rcols else None  # noqa: E731
        try:
            raw = json.loads(r["raw_response"] or "{}")
        except ValueError:
            raw = {}
        dropped = [d if isinstance(d, dict) else {"title": str(d).split(" ~ ")[0], "why": "already in your library"} for d in raw.get("dropped", [])]
        recs = []
        for x in conn.execute("SELECT * FROM recommendations WHERE run_id=? ORDER BY rank", (r["id"],)):
            rec = {k: x[k] for k in REC_FIELDS if k in xcols}
            rec["categories"] = as_list(x["categories"])
            rec["id"] = f"{r['id']}-{x['rank']}"
            recs.append(rec)
        status = r["status"] if r["status"] in ("done", "error") else "error"
        runs.append({"id": r["id"], "created_at": r["created_at"], "model": r["model"], "served_model": g("served_model"),
                     "mood": r["mood"], "effort": g("effort"), "batch_id": g("batch_id"), "n": g("n") or len(recs),
                     "status": status, "stage": status, "error": r["error"], "taste_summary": raw.get("taste_summary"),
                     "dropped": dropped, "recs": recs})

    settings = []
    for k, v in conn.execute("SELECT key, value FROM settings"):
        if k == "last_models":
            settings.append({"key": k, "value": as_list(v)})
        elif k in ("last_effort", "kindle_last_sync", "kindle_last_apply"):
            settings.append({"key": k, "value": v})
        elif k == "last_n":
            settings.append({"key": k, "value": int(v)})

    out = {"app": "findMyNextBook", "version": 1, "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "books": books, "kindle": kindle, "runs": runs, "settings": settings}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"Wrote {a.out}: {len(books)} books, {len(kindle)} Kindle items, {len(runs)} runs"
          + (f" ({skipped_legacy} old Kindle titles without an ASIN left out)" if skipped_legacy else ""))
    if relink:
        print(f"{relink} Kindle books matched by title will be re-checked: the app shows a Review banner after the restore.")
    print("Open the app → Settings → Restore backup, and pick this file.")


if __name__ == "__main__":
    main()
