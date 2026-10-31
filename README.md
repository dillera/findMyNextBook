# findMyNextBook

Find your next book from everything you've bought on Amazon and rated on Goodreads, with an AI model (via OpenRouter,
on your own account) reading your whole history.

**It runs entirely in your browser.** Your library, ratings, imports and recommendation history are stored in the
browser's own IndexedDB. Files you import are opened on your machine, never uploaded. The server that hosts the app
only hands out its static files, and the page is *forbidden by its own Content-Security-Policy* from sending anything
back to it. The in-app **Privacy** panel shows the proof live.

## Run it

```bash
python3 serve.py                      # http://localhost:8790 (standard library only, no install)
python3 serve.py --host 0.0.0.0 --port 8080
```

`web/` is the whole app: plain HTML, CSS and ES modules, no build step and no third-party scripts. Any static host
serves it (see *Deploy* below).

## Using it

1. **Import books** (top right) opens a four-step wizard:
   1. **Kindle library.** Drag the *📚 Kindle → findMyNextBook* button to your bookmarks bar, open
      read.amazon.com/kindle-library, and click it. It reads your Kindle library on Amazon's own site, signed in as
      you, and copies it. Paste it into the wizard, or drop the file it offers. No bookmarks bar? The same script can be
      pasted into the browser console.
   2. **Review.** Kindle books are matched to what's already there by ASIN, then title + author. Every Kindle purchase
      counts as read (Amazon reports no reading progress). Optional extras, all opened locally: the finish dates Kindle
      recorded (click the same bookmark on any amazon.com page), a Goodreads export (ratings and read dates), and paper
      books from Amazon's *Request Your Data → Your Orders* zip.
   3. **Rate** the read-but-unrated books with one click each. Strong opinions sharpen the picks most.
   4. **Done.** Connect OpenRouter and find your next book.
2. **Connect OpenRouter** (Settings, or the wizard's last step): *Sign in with OpenRouter* (OAuth PKCE), or paste a key
   from openrouter.ai/keys. The key stays in this browser and goes only to openrouter.ai.
3. **Discover.** Type a steer or pick a chip, and get picks with reasons that cite your history, a blurb and cover, and
   a Kindle-store link. *Options* picks the model(s), reasoning effort and number of picks; *View what gets sent* shows
   the exact request. Mark picks *Bought it*, *Want to read*, *Read it* or *Not for me*; all four feed the next run.
4. **Library** and **Insights** work like a Goodreads you own: shelves, stars, notes, search, stats.
5. **Settings → Your data**: download a backup file, restore one, or delete everything. Backups never include keys.

## Privacy, and how to check it

What the page may contact is fixed by the Content-Security-Policy in `web/index.html` (and repeated as a header by
`serve.py`):

| Directive | Allows | So |
|---|---|---|
| `connect-src` | `openrouter.ai`, `www.googleapis.com`, `openlibrary.org` | fetch/XHR/beacons/WebSockets to the hosting server are refused by the browser |
| `img-src` | Amazon, Google Books and Open Library cover hosts, `data:` | no tracking pixels on the hosting server |
| `script-src` / `style-src` | `'self'` | only the app's own code runs; no CDNs |
| `form-action` | `'none'` | no form posts anywhere |

Every request the app's code makes also goes through `web/js/net.js`, which refuses the hosting origin outright, sends
no cookies and no referrer, and logs host + purpose for the Privacy panel.

To check it yourself:
- **Privacy panel → Try to send data to this server**: the page attempts a `fetch()` POST and a tracking-pixel image to
  its own host, and reports the browser's `securitypolicyviolation` events. Both come back *Blocked by your browser*.
- The same panel lists **every host the page has contacted** since it loaded. The hosting server appears only for the
  app's own files.
- **DevTools → Network**, filtered to the app's host: after the page loads, nothing more goes there.
- Read the code: it isn't minified or bundled, and "View source" on any file shows what runs.

What others do see:
- **OpenRouter**: your reading profile with your key, when you ask for picks.
- **Google Books / Open Library**: one title or ISBN per lookup.
- **Amazon / Google / Open Library image hosts**: which covers your browser loads.
- **The hosting server**: that someone loaded the page (address, time). If you use *Sign in with OpenRouter*, the
  return URL carries a one-time code that expires in 10 minutes and can't be exchanged without a secret kept in your
  tab. `serve.py` doesn't log query strings, and pasting a key avoids even that.

## Deploy

Copy `web/` to any static host. HTTPS is required outside localhost: the OpenRouter sign-in and `crypto.randomUUID`
need a secure context. The CSP travels inside `index.html`, so it holds even on hosts that add no headers. Sending it
as a header too adds `frame-ancestors 'none'`.

**serve.py** behind a TLS proxy: `python3 serve.py --port 8790`, then proxy to it. It serves only `web/`, answers only
GET/HEAD (405 for anything else, body unread), lists no directories, and logs method, path and status only.

**nginx**, serving the files directly:

```nginx
log_format pathonly '$time_iso8601 $request_method $uri $status';   # $uri has no query string

server {
    listen 443 ssl;
    server_name books.example.org;
    root /srv/findMyNextBook/web;
    access_log /var/log/nginx/findmynextbook.log pathonly;           # or: access_log off;

    location / {
        limit_except GET { deny all; }
        try_files $uri =404;
        add_header Cache-Control "no-cache" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "PASTE the content of the meta tag in web/index.html; frame-ancestors 'none'" always;
    }
}
```

**Caddy** writes no access log unless you add a `log` directive:

```caddy
books.example.org {
    root * /srv/findMyNextBook/web
    @write not method GET HEAD
    respond @write 405
    header Content-Security-Policy "PASTE the meta tag's content; frame-ancestors 'none'"
    header Referrer-Policy no-referrer
    file_server
}
```

## Moving from the old server edition

The previous version kept everything in `data/books.db` on a local FastAPI server. To bring that library into the
browser edition:

```bash
python3 tools/export_local_db.py          # writes data/findMyNextBook-backup.json
```

Then **Settings → Restore backup** in the app. Links between Kindle books and library books are kept where the ASIN
proves them; the rest are re-matched by the browser's stricter title matcher, and a *Review* banner offers anything
that should be added.

The old server (`app/`, `static/`, `run.sh`, `requirements.txt`) is still in the repo and still runs (`./run.sh`,
port 8765). It isn't needed for the browser edition.

## Layout

```
web/index.html            the page, with the Content-Security-Policy
web/style.css             light and dark themes
web/js/app.js             UI: Discover, Library, Insights, import wizard, Settings, Privacy panel
web/js/store.js           IndexedDB storage, backup / restore / delete
web/js/importers.js       Goodreads CSV, Kindle export, Amazon orders zip (read in the browser)
web/js/match.js           title/author matching (subtitles, editions, numbered parts)
web/js/kindle-export.js   the bookmarklet / console script that runs on Amazon's pages
web/js/recommend.js       taste profile → prompt → picks; Insights stats
web/js/llm.js             OpenRouter: chat, models, key check, Sign in with OpenRouter (PKCE)
web/js/books-api.js       Google Books + Open Library lookups and background enrichment
web/js/net.js             the one fetch wrapper: no requests to the host, no cookies, logged
web/js/privacy.js         evidence for the Privacy panel
serve.py                  stdlib static server with the security headers
tools/export_local_db.py  old SQLite database → backup file for the browser edition
```
