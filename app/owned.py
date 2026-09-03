"""'Owned on Kindle' list: books bought on Amazon that never made it into Goodreads.
Accepts pasted text (one title per line, optional ' by ' / ' — ' author), Amazon data-export CSVs, or JSON from the
Kindle web library script. Everything is normalized so the recommender can drop matches."""
import csv
import io
import json
import re

from .db import get_conn, now

TITLE_COLS = ("title", "product name", "productname", "item title", "name", "asin title", "book title")
AUTHOR_COLS = ("author", "authors", "author name", "creator", "by")


def _split_line(line: str) -> tuple[str, str | None]:
    line = line.strip().strip("-•*").strip()
    for sep in (" — ", " – ", " by ", "\t", " | "):
        if sep in line:
            t, a = line.rsplit(sep, 1) if sep != " by " else line.split(sep, 1)
            return t.strip(), a.strip() or None
    return line, None


def parse(text: str, filename: str = "") -> list[tuple[str, str | None]]:
    text = text.lstrip("﻿").strip()
    if not text:
        return []
    # JSON array from the kindle-web script: [{"title":..,"author":..}, ...] or ["title", ...]
    if text.startswith("["):
        # Firefox appends "debugger eval code:1:558" after console output; cut at the closing bracket
        text_json = text[: text.rfind("]") + 1]
        try:
            data = json.loads(text_json)
            out = []
            for item in data:
                if isinstance(item, str):
                    out.append(_split_line(item))
                elif isinstance(item, dict):
                    out.append((item.get("title", "").strip(), (item.get("author") or None)))
            return [o for o in out if o[0]]
        except ValueError:
            pass
    # CSV with a header that has a title-ish column (Amazon exports, spreadsheets)
    first = text.splitlines()[0].lower()
    if ("," in first or "\t" in first) and any(c in first for c in TITLE_COLS):
        dialect = csv.excel_tab if "\t" in first else csv.excel
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        cols = {c.lower().strip(): c for c in reader.fieldnames or []}
        tcol = next((cols[c] for c in TITLE_COLS if c in cols), None)
        acol = next((cols[c] for c in AUTHOR_COLS if c in cols), None)
        if tcol:
            return [((r.get(tcol) or "").strip(), (r.get(acol) or "").strip() or None) for r in reader if (r.get(tcol) or "").strip()]
    # plain lines
    return [_split_line(l) for l in text.splitlines() if l.strip()]


def clean_title(t: str) -> str:
    # Amazon titles carry marketing suffixes: "Foo: A Novel (Bar Series Book 2) (English Edition)"
    t = re.sub(r"\s*\((?:[^()]*(?:Book|Series|Edition|Trilogy|Saga|Novel)[^()]*)\)", "", t, flags=re.I)
    t = re.sub(r"\s*\[[^\]]*\]", "", t)
    return t.strip(" :-")


def import_text(text: str, source: str, filename: str = "") -> dict:
    from .recommend import _norm_title  # lazy: avoids circular import
    rows = parse(text, filename)
    added = skipped = 0
    with get_conn() as conn:
        existing = {r[0] for r in conn.execute("SELECT norm_title FROM owned")}
        for title, author in rows:
            title = clean_title(title)
            nt = _norm_title(title)
            if not nt or nt in existing:
                skipped += 1
                continue
            conn.execute("INSERT INTO owned(title,author,norm_title,source,added_at) VALUES(?,?,?,?,?)",
                         (title, author, nt, source, now()))
            existing.add(nt)
            added += 1
    return {"added": added, "skipped": skipped, "parsed": len(rows)}
