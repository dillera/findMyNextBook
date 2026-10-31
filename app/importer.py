"""Import a Goodreads library export CSV into the books table (idempotent)."""
import csv
import io
from typing import Iterable

from .db import get_conn, now


def _clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    # Goodreads wraps ISBNs as ="1234" to stop Excel mangling them.
    if v.startswith('="') and v.endswith('"'):
        v = v[2:-1]
    return v or None


def _int(v) -> int | None:
    v = _clean(v)
    if not v:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _date(v) -> str | None:
    v = _clean(v)
    return v.replace("/", "-") if v else None


def parse_rows(text: str) -> Iterable[dict]:
    reader = csv.DictReader(io.StringIO(text))
    for r in reader:
        yield {
            "goodreads_id": _int(r.get("Book Id")),
            "title": _clean(r.get("Title")) or "(untitled)",
            "author": _clean(r.get("Author")),
            "additional_authors": _clean(r.get("Additional Authors")),
            "isbn": _clean(r.get("ISBN")),
            "isbn13": _clean(r.get("ISBN13")),
            "my_rating": _int(r.get("My Rating")) or 0,
            "publisher": _clean(r.get("Publisher")),
            "binding": _clean(r.get("Binding")),
            "pages": _int(r.get("Number of Pages")),
            "year_published": _int(r.get("Year Published")),
            "original_year": _int(r.get("Original Publication Year")),
            "date_read": _date(r.get("Date Read")),
            "date_added": _date(r.get("Date Added")),
            "shelves": _clean(r.get("Bookshelves")),
            "exclusive_shelf": _clean(r.get("Exclusive Shelf")) or "to-read",
            "review": _clean(r.get("My Review")),
            "private_notes": _clean(r.get("Private Notes")),
            "read_count": _int(r.get("Read Count")) or 0,
            "owned": _int(r.get("Owned Copies")) or 0,
        }


UPSERT = """
INSERT INTO books (goodreads_id,title,author,additional_authors,isbn,isbn13,my_rating,publisher,binding,pages,
  year_published,original_year,date_read,date_added,shelves,exclusive_shelf,review,private_notes,read_count,owned,
  created_at,updated_at)
VALUES (:goodreads_id,:title,:author,:additional_authors,:isbn,:isbn13,:my_rating,:publisher,:binding,:pages,
  :year_published,:original_year,:date_read,:date_added,:shelves,:exclusive_shelf,:review,:private_notes,:read_count,:owned,
  :ts,:ts)
ON CONFLICT(goodreads_id) DO UPDATE SET
  title=excluded.title, author=excluded.author, additional_authors=excluded.additional_authors,
  isbn=COALESCE(excluded.isbn, books.isbn), isbn13=COALESCE(excluded.isbn13, books.isbn13),
  publisher=COALESCE(excluded.publisher, books.publisher), binding=COALESCE(excluded.binding, books.binding),
  pages=COALESCE(excluded.pages, books.pages), year_published=COALESCE(excluded.year_published, books.year_published),
  original_year=COALESCE(excluded.original_year, books.original_year),
  -- local edits win over a re-import for rating / shelf / dates
  my_rating=CASE WHEN books.updated_at > books.created_at THEN books.my_rating ELSE excluded.my_rating END,
  exclusive_shelf=CASE WHEN books.updated_at > books.created_at THEN books.exclusive_shelf ELSE excluded.exclusive_shelf END,
  date_read=CASE WHEN books.updated_at > books.created_at THEN books.date_read ELSE excluded.date_read END,
  shelves=excluded.shelves, review=COALESCE(excluded.review, books.review),
  private_notes=COALESCE(excluded.private_notes, books.private_notes),
  read_count=excluded.read_count, owned=excluded.owned
"""


def import_csv_text(text: str) -> dict:
    from .matching import BookIndex  # lazy: matching imports google_books, which `python -m app.importer` doesn't need

    inserted = updated = merged = 0
    ts = now()
    with get_conn() as conn:
        # books that came from Amazon (no Goodreads id yet): a Goodreads row for the same book adopts that row, so
        # importing Kindle first and Goodreads second doesn't create duplicates
        orphans = BookIndex(conn, "WHERE goodreads_id IS NULL")
        for row in parse_rows(text):
            row["ts"] = ts
            exists = row["goodreads_id"] and conn.execute(
                "SELECT 1 FROM books WHERE goodreads_id=?", (row["goodreads_id"],)
            ).fetchone()
            if not exists and row["goodreads_id"]:
                hit = orphans.find(row["title"], row["author"], isbn=row["isbn"])
                if hit:
                    conn.execute("UPDATE books SET goodreads_id=? WHERE id=?", (row["goodreads_id"], hit["id"]))
                    orphans.remove(hit)
                    merged += 1
                    exists = True
            conn.execute(UPSERT, row)
            if exists:
                updated += 1
            else:
                inserted += 1
    return {"inserted": inserted, "updated": updated, "merged": merged}


def import_csv_file(path: str) -> dict:
    with open(path, encoding="utf-8-sig") as f:
        return import_csv_text(f.read())


if __name__ == "__main__":
    import sys
    from .db import init_db

    init_db()
    print(import_csv_file(sys.argv[1]))
