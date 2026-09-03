# findMyNextBook

A personal replacement for Goodreads: your library in SQLite, a fast local UI, Google Books metadata,
and an LLM (via OpenRouter) that reads your whole rating history and tells you what to buy next on Kindle.

## Run it

```bash
cp .env.example .env      # add OPENROUTER_API_KEY (and optionally GOOGLE_BOOKS_API_KEY)
./run.sh                  # creates .venv, imports the CSV on first run, serves http://localhost:8765
```

`run.sh` uses `PORT` if set. Re-importing a fresh Goodreads export is safe: it upserts on Goodreads book id and
keeps any rating / shelf / date edits you made locally.

## What's in the UI

- **Library** — grid or list, search (title/author/blurb), filter by shelf/rating/author, sort. Click a book for
  the drawer: star rating, shelf, date read, notes (auto-saved), Kindle-store link, Google Books refresh, remove.
- **Stats** — books per year, rating distribution, top authors, genre affinity.
- **Next Book** — pick an OpenRouter model, optionally steer ("something short and weird"), and get N recommendations
  with reasons that cite your history, cover/blurb from Google Books, and a **Buy on Kindle** link. Mark
  *Bought* / *To-read* / *Not for me*; bought and to-read items are shelved so the next run excludes them.
  *View prompt* shows exactly what the model sees.
- **Add** — search Google Books and shelve a book directly.
- **Enrich from Google** (top right) — fills covers, blurbs, categories and ratings for the whole library in the
  background. If Google's quota is exhausted it falls back to Open Library automatically.

## Keys

| Var | Needed for | Where |
|---|---|---|
| `OPENROUTER_API_KEY` | recommendations, model list | https://openrouter.ai/keys |
| `OPENROUTER_MODEL` | default model slug (changeable in UI) | any slug from https://openrouter.ai/models |
| `GOOGLE_BOOKS_API_KEY` | optional; your own Google Books quota | Google Cloud Console → enable *Books API* → create API key |

Without a Google key you share Google's anonymous per-network quota, which is often already exhausted (429);
the Open Library fallback covers most books but misses some covers for very new titles.

## Owned on Kindle (books Goodreads never saw)

Recommendations are checked against your library **and** an "Owned on Kindle" list (Next Book tab). Fill it by
pasting titles, uploading Amazon's data-export CSV, or running the one-line console script on
read.amazon.com/kindle-library, which copies your whole Kindle library as JSON. Matching is fuzzy: it ignores
series suffixes, subtitles, leading articles and small spelling differences. Any rec that matches is dropped
and listed under the taste summary; "Already own it" on a card adds it to the list for good.

## Amazon

Amazon has no public API for reading your Kindle purchases or buying on your behalf without a Product Advertising
API / Associates account, so this app links into the Kindle store pre-searched (`i=digital-text`) and lets you
mark a rec as bought, which shelves it as to-read. If you later want your Amazon order history in here, export
it from *Your Account → Request your data* and it can be imported the same way as the Goodreads CSV.

## Layout

```
app/main.py         FastAPI routes (library CRUD, import, enrich, google search, recommend)
app/db.py           schema + connection helpers (data/books.db, WAL)
app/importer.py     Goodreads CSV → books table (idempotent upsert)
app/google_books.py Google Books v1 client + background enrichment
app/openlibrary.py  Open Library fallback (same shape as Google meta)
app/openrouter.py   OpenRouter chat/completions + model list
app/recommend.py    reading profile → prompt → JSON recs → enrich → store
static/             index.html, app.js, style.css (no build step)
```

Direct SQL is fine too: `sqlite3 data/books.db`.
