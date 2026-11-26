#!/usr/bin/env bash
# Build this checkout and run it locally, with its own data, at
# http://<name>.localhost:<port>. Several checkouts can run side by side as
# long as each has its own name and port.
#
#   OS_DEV_DIR=/path/to/dev-dir dev/run.sh <name> <port>
#
# Mail works when dev/mail.sh is running. Chat and calls need their engines,
# which have no macOS build, so those two screens only work on a server.
# Set OS_DEV_SKIP_WEB=1 to reuse the last web build.
set -euo pipefail

NAME="${1:?usage: dev/run.sh <name> <port>}"
PORT="${2:?usage: dev/run.sh <name> <port>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${OS_DEV_DIR:-$HOME/.opensuite-dev}"
DATA="$DEV/instances/$NAME"
mkdir -p "$DATA"

if [ -z "${OS_DEV_SKIP_WEB:-}" ]; then
  [ -d "$ROOT/web/node_modules" ] || (cd "$ROOT/web" && npm ci)
  (cd "$ROOT/web" && npm run build)
fi
(cd "$ROOT/server" && go build -o "$DATA/opensuite" .)

[ -f "$DATA/secret" ] || openssl rand -hex 32 > "$DATA/secret"
export OS_DOMAIN="$NAME.localhost:$PORT"
export OS_MAIL_DOMAIN="$NAME.dev.test"
# New organisations get <slug>.$NAME.dev.test, as they get <slug>.<suffix> on a server.
export OS_ORG_DOMAIN_SUFFIX="${OS_ORG_DOMAIN_SUFFIX-$OS_MAIL_DOMAIN}"
export OS_MAIL_HOST="localhost"
export OS_LISTEN="127.0.0.1:$PORT"
export OS_DATA="$DATA"
export OS_WEB="$ROOT/web/dist"
export OS_SECRET="$(cat "$DATA/secret")"
export OS_SIGNUP=open
export OS_OPERATORS="ada@$OS_MAIL_DOMAIN"
# The content engine (web/dist-headless, built with the web app) runs in the
# Node this shell has.
export OS_NODE="${OS_NODE:-$(command -v node)}"
if [ -f "$DEV/mail/admin" ] && curl -fs -o /dev/null http://127.0.0.1:8446/; then
  export OS_MAIL_URL=http://127.0.0.1:8446
  export OS_MAIL_ADMIN="$(cat "$DEV/mail/admin")"
  "$DATA/opensuite" mail-setup "$OS_MAIL_URL"
else
  echo "dev: mail engine is not running (dev/mail.sh); starting without mail" >&2
fi
echo "dev: http://$OS_DOMAIN"
exec "$DATA/opensuite"
