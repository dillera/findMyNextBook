"""SQLite access layer. One file, one connection per request, WAL mode."""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.environ.get("BOOKS_DB", os.path.join(os.path.dirname(__file__), "..", "data", "books.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goodreads_id INTEGER UNIQUE,
  title TEXT NOT NULL,
  author TEXT,
  additional_authors TEXT,
  isbn TEXT,
  isbn13 TEXT,
  my_rating INTEGER DEFAULT 0,
  publisher TEXT,
  binding TEXT,
  pages INTEGER,
  year_published INTEGER,
  original_year INTEGER,
  date_read TEXT,
  date_added TEXT,
  shelves TEXT,
  exclusive_shelf TEXT DEFAULT 'to-read',
  review TEXT,
  private_notes TEXT,
  read_count INTEGER DEFAULT 0,
  owned INTEGER DEFAULT 0,
  -- Google Books enrichment
  google_id TEXT,
  description TEXT,
  categories TEXT,
  thumbnail TEXT,
  google_rating REAL,
  google_ratings_count INTEGER,
  google_pages INTEGER,
  google_published TEXT,
  enriched_at TEXT,
  enrich_error TEXT,
  -- local edits
  user_notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_shelf ON books(exclusive_shelf);
CREATE INDEX IF NOT EXISTS idx_books_rating ON books(my_rating);

CREATE TABLE IF NOT EXISTS rec_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT,
  model TEXT,
  mood TEXT,
  prompt TEXT,
  raw_response TEXT,
  status TEXT DEFAULT 'running',
  error TEXT
);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES rec_runs(id) ON DELETE CASCADE,
  rank INTEGER,
  title TEXT NOT NULL,
  author TEXT,
  year INTEGER,
  reason TEXT,
  hook TEXT,
  confidence REAL,
  google_id TEXT,
  isbn13 TEXT,
  thumbnail TEXT,
  description TEXT,
  categories TEXT,
  google_rating REAL,
  amazon_url TEXT,
  status TEXT DEFAULT 'new',   -- new | bought | dismissed | added
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recs_run ON recommendations(run_id);

CREATE TABLE IF NOT EXISTS owned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  norm_title TEXT,
  source TEXT,          -- paste | amazon-export | kindle-web | kindle-sync | rec
  added_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_owned_norm ON owned(norm_title);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# columns added after the first release; ALTERed in on startup so existing databases keep working
MIGRATIONS = {
    # source: NULL/goodreads | kindle | amazon-print | manual; asin set = it's in the Kindle library
    "books": {"asin": "TEXT", "source": "TEXT", "kindle_rank": "INTEGER"},
    # owned is the raw Amazon ledger: one row per Kindle item (book_id links it into `books` once imported)
    "owned": {"asin": "TEXT", "cover": "TEXT", "percent_read": "INTEGER", "origin": "TEXT",
              "kindle_rank": "INTEGER", "first_seen_at": "TEXT", "resource_type": "TEXT", "read_at": "TEXT",
              "book_id": "INTEGER"},
    # stage: thinking | checking | enriching | done | error
    "rec_runs": {"profile_mode": "TEXT", "effort": "TEXT", "batch_id": "TEXT", "served_model": "TEXT",
                 "stage": "TEXT", "store_note": "TEXT", "n": "INTEGER", "verify": "INTEGER"},
    # amazon_status: available | owned | not-found | NULL (not checked)
    "recommendations": {"asin": "TEXT", "price": "TEXT", "ku": "INTEGER", "amazon_rating": "REAL",
                        "amazon_reviews": "INTEGER", "amazon_status": "TEXT", "series": "TEXT"},
}


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        for table, cols in MIGRATIONS.items():
            have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for col, typ in cols.items():
                if col not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_owned_asin ON owned(asin) WHERE asin IS NOT NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_asin ON books(asin)")
        # a run that was mid-flight when the server stopped will never finish
        conn.execute("UPDATE rec_runs SET status='error', stage='error', error='Interrupted: the server restarted' "
                     "WHERE status='running'")


@contextmanager
def get_conn():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    if d.get("categories"):
        try:
            d["categories"] = json.loads(d["categories"])
        except (TypeError, ValueError):
            d["categories"] = [d["categories"]]
    else:
        d["categories"] = [] if "categories" in d else d.get("categories")
    return d


def get_setting(conn, key, default=None):
    r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
