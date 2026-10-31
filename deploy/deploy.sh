#!/usr/bin/env bash
# Deploy findMyNextBook to an nginx host under a path prefix, e.g. https://apps.example.org/mynextbook/
#
#   git clone https://github.com/dillera/findMyNextBook.git /root/apps/findMyNextBook
#   /root/apps/findMyNextBook/deploy/deploy.sh            # first install and every update
#
# What it does, every run (safe to repeat):
#   1. git pull --ff-only (skip with NO_PULL=1)
#   2. copies web/ to $WEBROOT, readable by nginx (the clone itself can stay in /root)
#   3. writes $SNIPPET: the nginx locations for $PREFIX, with the same Content-Security-Policy as web/index.html
#      plus frame-ancestors 'none', GET/HEAD only, and an access log of method + path + status (no query string,
#      no IP address, no user agent)
#   4. nginx -t, then reloads nginx
#
# Once per server, include the snippet inside the HTTPS server block of your site:
#   include /etc/nginx/snippets/mynextbook.conf;
set -euo pipefail

PREFIX=${PREFIX:-/mynextbook}
WEBROOT=${WEBROOT:-/var/www/mynextbook}
SNIPPET=${SNIPPET:-/etc/nginx/snippets/mynextbook.conf}
LOGFMT=${LOGFMT:-/etc/nginx/conf.d/mynextbook-log.conf}
LOGFILE=${LOGFILE:-/var/log/nginx/mynextbook.log}
REPO=$(cd "$(dirname "$0")/.." && pwd)

[ "$(id -u)" = 0 ] || { echo "Run as root (writes nginx config and reloads nginx)"; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required"; exit 1; }

if [ -z "${NO_PULL:-}" ]; then
  before=$(git -C "$REPO" rev-parse HEAD)
  git -C "$REPO" pull --ff-only
  # the pull may have replaced this script; bash would carry on running the old copy, so start the new one
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$before" ] || NO_PULL=1 exec "$REPO/deploy/deploy.sh"
fi
echo "Deploying $(git -C "$REPO" log --oneline -1)"

CSP=$(sed -n 's/.*http-equiv="Content-Security-Policy" content="\([^"]*\)".*/\1/p' "$REPO/web/index.html")
[ -n "$CSP" ] || { echo "web/index.html has no Content-Security-Policy meta tag; refusing to deploy without it"; exit 1; }
case "$CSP" in *\"*|*\$*|*\\*) echo "Unexpected characters in the CSP; refusing to write it into nginx config"; exit 1;; esac

mkdir -p "$WEBROOT"
rsync -a --delete --chmod=D755,F644 "$REPO/web/" "$WEBROOT/"

# keep the previous config, so a version that fails nginx -t is rolled back instead of left on disk
for f in "$SNIPPET" "$LOGFMT"; do if [ -f "$f" ]; then cp -p "$f" "$f.prev"; else rm -f "$f.prev"; fi; done
rollback() {
  echo "nginx -t failed: restoring the previous config; nginx keeps running the old one"
  for f in "$SNIPPET" "$LOGFMT"; do if [ -f "$f.prev" ]; then mv "$f.prev" "$f"; else rm -f "$f"; fi; done
  exit 1
}

# log_format must live in the http block, which includes conf.d/*.conf
cat > "$LOGFMT" <<EOF
# Managed by findMyNextBook deploy/deploy.sh. \$uri has no query string.
log_format mynextbook_path '\$time_iso8601 \$request_method \$uri \$status';
EOF

cat > "$SNIPPET" <<EOF
# Managed by findMyNextBook deploy/deploy.sh. Regenerated on each run; edit the script, not this file.
location = $PREFIX {
    access_log $LOGFILE mynextbook_path;
    return 301 $PREFIX/;
}

location ^~ $PREFIX/ {
    alias $WEBROOT/;
    index index.html;
    limit_except GET { deny all; }          # GET includes HEAD; the app never posts anything to this server
    access_log $LOGFILE mynextbook_path;    # method, path, status only

    add_header Content-Security-Policy "$CSP; frame-ancestors 'none'" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
    add_header Cache-Control "no-cache" always;
}
EOF

# -R: sites-enabled holds symlinks, which -r does not follow
if ! grep -Rqs "include $SNIPPET;" /etc/nginx/sites-enabled/ /etc/nginx/nginx.conf; then
  echo
  echo "Almost done: add this line inside your site's HTTPS server { } block, then run this script again:"
  echo "    include $SNIPPET;"
  exit 0
fi

nginx -t || rollback
systemctl reload nginx
echo "Deployed to $WEBROOT and served at $PREFIX/"
