#!/usr/bin/env bash
# A mail engine for development, shared by every local Open Suite instance.
# It listens on loopback only (http://127.0.0.1:8446) and keeps its data under
# $OS_DEV_DIR/mail. Mail between local accounts works; nothing leaves the
# machine because no SMTP listener is opened.
#
#   OS_DEV_DIR=/path/to/dev-dir dev/mail.sh        (runs in the foreground)
set -euo pipefail

DEV="${OS_DEV_DIR:-$HOME/.opensuite-dev}"
VERSION=v1.1.1
BIN="$DEV/bin/stalwart"
DIR="$DEV/mail"
PORT=8446
SETUP_PORT=8447
mkdir -p "$DEV/bin" "$DIR/data"

if [ ! -x "$BIN" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) asset=stalwart-aarch64-apple-darwin ;;
    Darwin-x86_64) asset=stalwart-x86_64-apple-darwin ;;
    Linux-x86_64) asset=stalwart-x86_64-unknown-linux-gnu ;;
    Linux-aarch64) asset=stalwart-aarch64-unknown-linux-gnu ;;
    *) echo "no mail engine build for this platform" >&2; exit 1 ;;
  esac
  mkdir -p "$DIR/download"
  curl -fsSL "https://github.com/stalwartlabs/stalwart/releases/download/$VERSION/$asset.tar.gz" | tar -xz -C "$DIR/download" stalwart
  install -m 755 "$DIR/download/stalwart" "$BIN"
fi

[ -f "$DIR/admin" ] || echo "admin:$(openssl rand -hex 12)" > "$DIR/admin"
[ -f "$DIR/config.json" ] || echo "{\"@type\":\"RocksDb\",\"path\":\"$DIR/data/\"}" > "$DIR/config.json"
export STALWART_RECOVERY_ADMIN="$(cat "$DIR/admin")"
export STALWART_PUBLIC_URL="http://127.0.0.1:$PORT"

if [ ! -f "$DIR/.configured" ]; then
  # A fresh engine only offers a setup port. Give it one loopback HTTP
  # listener; each instance adds its own mail domain when it starts.
  STALWART_RECOVERY_MODE=1 STALWART_RECOVERY_MODE_PORT=$SETUP_PORT "$BIN" --config="$DIR/config.json" &
  pid=$!
  trap 'kill $pid 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do curl -fs -o /dev/null "http://127.0.0.1:$SETUP_PORT/" && break; sleep 1; done
  curl -fsS -u "$STALWART_RECOVERY_ADMIN" -H 'Content-Type: application/json' "http://127.0.0.1:$SETUP_PORT/jmap/" -d '{
    "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    "methodCalls": [["x:NetworkListener/set", {"create": {"http": {
      "name": "http", "protocol": "http", "bind": {"127.0.0.1:'"$PORT"'": true}, "implicitTls": false}}}, "0"]]}'
  echo
  kill $pid
  wait $pid 2>/dev/null || true
  trap - EXIT
  touch "$DIR/.configured"
fi

exec "$BIN" --config="$DIR/config.json"
