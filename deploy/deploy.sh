#!/usr/bin/env bash
# Build Open Suite here and install it on a server.
#
#   deploy/deploy.sh <ssh-host> <domain> <acme-email> [mail-domain]
#
# Builds the web app, the content engine and a static Linux binary, ships them with the install
# files and runs install.sh on the server. Safe to run for every release.
set -euo pipefail

HOST=${1:?usage: deploy.sh <ssh-host> <domain> <acme-email> [mail-domain]}
DOMAIN=${2:?usage: deploy.sh <ssh-host> <domain> <acme-email> [mail-domain]}
EMAIL=${3:?usage: deploy.sh <ssh-host> <domain> <acme-email> [mail-domain]}
MAIL_DOMAIN=${4:-$DOMAIN}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REMOTE=/root/opensuite-bundle

echo "== build web"
npm --prefix "$ROOT/web" run build --silent

echo "== build server"
mkdir -p "$ROOT/build"
(cd "$ROOT/server" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$ROOT/build/opensuite" .)

echo "== ship"
ssh "$HOST" "mkdir -p $REMOTE/web $REMOTE/dist-headless $REMOTE/deploy"
rsync -az "$ROOT/build/opensuite" "$HOST:$REMOTE/opensuite"
rsync -az --delete "$ROOT/web/dist/" "$HOST:$REMOTE/web/"
rsync -az --delete "$ROOT/web/dist-headless/" "$HOST:$REMOTE/dist-headless/"
rsync -az --delete "$ROOT/deploy/" "$HOST:$REMOTE/deploy/"

echo "== install"
# Optional settings pass through from this shell: OS_SIGNUP (open|code|closed),
# OS_SIGNUP_CODE, OS_OPERATORS (comma-separated sign-in addresses),
# OS_MAIL_RELAY (host:port:user:password for an outbound smarthost),
# OS_DEMO (the demo organisation reset every morning, see server/demo.go) and
# OS_ORG_DOMAIN_SUFFIX (new organisations get <slug>.<suffix>, see
# server/orgdomain.go) and OS_MAIL_HOST (the name the MX records point at,
# whose certificate the mail engine presents; default the domain).
# OS_MAIL_RELAY and OS_DEMO may be file:/path to read them from a file on the
# server.
ssh "$HOST" "OS_SIGNUP='${OS_SIGNUP:-}' OS_SIGNUP_CODE='${OS_SIGNUP_CODE:-}' OS_OPERATORS='${OS_OPERATORS:-}' OS_MAIL_RELAY='${OS_MAIL_RELAY:-}' OS_DEMO='${OS_DEMO:-}' OS_ORG_DOMAIN_SUFFIX='${OS_ORG_DOMAIN_SUFFIX:-}' OS_MAIL_HOST='${OS_MAIL_HOST:-}' bash $REMOTE/deploy/install.sh '$DOMAIN' '$EMAIL' '$MAIL_DOMAIN'"
