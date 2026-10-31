#!/usr/bin/env python3
"""Serve findMyNextBook (the web/ folder) as plain static files. Standard library only.

    python3 serve.py                 # http://localhost:8790
    python3 serve.py --port 8080 --host 0.0.0.0

This server has nothing to receive: the app keeps every library in the visitor's own browser. So it
  · answers only GET and HEAD for files under web/ (no directory listings, nothing outside web/),
  · refuses every other method without reading the request body,
  · sends the same Content-Security-Policy as index.html, plus frame-ancestors 'none' (which a <meta> tag can't set),
  · logs method, path and status only: no query strings (the OpenRouter sign-in return carries a one-time code there),
    no request bodies (there are none), no cookies.
Any static host works just as well (nginx, Caddy, GitHub Pages, S3…): the policy travels inside index.html.
"""
import argparse
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def page_csp() -> str:
    """The policy from index.html's <meta> tag, so the header and the page can never disagree."""
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        m = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', f.read())
    if not m:
        sys.exit("web/index.html has no Content-Security-Policy meta tag; refusing to serve without it")
    return m.group(1) + "; frame-ancestors 'none'"


class Handler(SimpleHTTPRequestHandler):
    server_version = "findMyNextBook"
    sys_version = ""
    csp = ""
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Content-Security-Policy", self.csp)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):  # never list folders
        self.send_error(404)
        return None

    def _refuse(self):
        # nothing in the app ever sends data here; don't read whatever body came with this
        self.close_connection = True
        self.send_error(405, "This server only serves files")

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _refuse

    def log_message(self, fmt, *args):
        pass  # replaced by log_request below

    def log_request(self, code="-", size="-"):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        sys.stderr.write(f"{self.log_date_time_string()} {self.command} {path} {code}\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8790)))
    a = ap.parse_args()
    Handler.csp = page_csp()
    httpd = ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=ROOT))
    print(f"findMyNextBook on http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}  (serving {ROOT})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
