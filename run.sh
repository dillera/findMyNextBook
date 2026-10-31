#!/usr/bin/env bash
# Start the server. First run imports the Goodreads CSV automatically.
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
# (re)install when requirements.txt changes
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/pip install -q -r requirements.txt && touch .venv/.installed
fi
if [ ! -f data/books.db ] && ls *.csv >/dev/null 2>&1; then
  .venv/bin/python -m app.importer "$(ls *.csv | head -1)"
fi
exec .venv/bin/uvicorn app.main:app --port "${PORT:-8765}" "$@"
