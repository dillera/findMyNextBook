#!/usr/bin/env bash
# Start the server. First run imports the Goodreads CSV automatically.
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
if [ ! -f data/books.db ] && ls *.csv >/dev/null 2>&1; then
  .venv/bin/python -m app.importer "$(ls *.csv | head -1)"
fi
exec .venv/bin/uvicorn app.main:app --port "${PORT:-8765}" "$@"
