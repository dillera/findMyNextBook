"""Paper books from Amazon order history: Amazon → Account → Request Your Data → "Your Orders".

Amazon has renamed the files over the years (Retail.OrderHistory.1.csv, Order History.csv, the old "Items" report), so
this accepts the zip or any CSV in it and looks for the columns rather than the file names: an ASIN column, a title
column ("Product Name" / "Title") and optionally "Order Date" and "Order Status". Order history covers everything you
ever bought, so books are picked out by their ASIN: a physical book's ASIN is its ISBN-10 (digits, maybe a final X),
while everything else, Kindle books included, has a B0… ASIN. Kindle books come from the Kindle sync instead."""
import csv
import io
import re
import zipfile

from .db import get_conn, now
from .matching import BookIndex
from .owned import clean_title

ISBN10 = re.compile(r"^\d{9}[\dX]$")
MAX_MEMBER = 200 * 1024 * 1024  # skip absurd zip members instead of inflating them


def _csv_texts(data: bytes) -> list[str]:
    buf = io.BytesIO(data)
    if not zipfile.is_zipfile(buf):
        return [data.decode("utf-8-sig", errors="replace")]
    out = []
    with zipfile.ZipFile(buf) as z:
        for info in z.infolist():
            if info.filename.lower().endswith(".csv") and info.file_size < MAX_MEMBER:
                out.append(z.read(info).decode("utf-8-sig", errors="replace"))
    return out


def _col(cols: dict, *names: str) -> str | None:
    return next((cols[n] for n in names if n in cols), None)


def parse(data: bytes) -> tuple[list[dict], int]:
    """→ (books, rows_seen). One entry per ISBN, earliest order date wins."""
    books, seen = {}, 0
    for text in _csv_texts(data):
        reader = csv.DictReader(io.StringIO(text))
        cols = {c.strip().lower(): c for c in reader.fieldnames or []}
        acol = _col(cols, "asin", "asin/isbn", "isbn")
        tcol = _col(cols, "product name", "title", "productname", "item title")
        if not acol or not tcol:
            continue
        dcol = _col(cols, "order date", "orderdate", "order_date")
        scol = _col(cols, "order status", "shipment status")
        for r in reader:
            seen += 1
            asin = (r.get(acol) or "").strip().upper()
            if not ISBN10.match(asin):
                continue
            if scol and "cancel" in (r.get(scol) or "").lower():
                continue
            title = clean_title((r.get(tcol) or "").strip())
            if not title:
                continue
            date = (r.get(dcol) or "")[:10] if dcol else None
            if asin not in books or (date and date < (books[asin]["date"] or "9999")):
                books[asin] = {"isbn": asin, "title": title, "date": date or None}
    return list(books.values()), seen


def import_orders(data: bytes) -> dict:
    found, seen = parse(data)
    ts = now()
    added = matched = 0
    with get_conn() as conn:
        idx = BookIndex(conn)
        for b in found:
            hit = idx.find(b["title"], None, isbn=b["isbn"])
            if hit:
                matched += 1
                if hit["id"] > 0:
                    conn.execute("UPDATE books SET isbn=COALESCE(isbn, ?) WHERE id=?", (b["isbn"], hit["id"]))
                continue
            # like Kindle books: bought on Amazon counts as read. No author in order history; enrichment fills it in.
            cur = conn.execute(
                """INSERT INTO books(title, isbn, source, exclusive_shelf, my_rating, date_added, binding, created_at, updated_at)
                   VALUES(?,?,'amazon-print','read',0,?,'Print',?,?)""",
                (b["title"], b["isbn"], b["date"] or ts[:10], ts, ts))
            idx.add({"id": cur.lastrowid, "title": b["title"], "author": None, "asin": None, "isbn": b["isbn"],
                     "goodreads_id": None, "exclusive_shelf": "read", "my_rating": 0, "date_read": None, "thumbnail": None})
            added += 1
    return {"found": len(found), "added": added, "matched": matched, "rows": seen}
