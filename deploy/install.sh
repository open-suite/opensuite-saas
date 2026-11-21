#!/usr/bin/env bash
# Open Suite — native single-server install (Ubuntu 24.04, run as root).
#
#   install.sh <domain> <acme-email> [mail-domain]
#
# Idempotent. Installs nginx, the three headless engines (Tuwunel for chat,
# Stalwart for mail, LiveKit for video) as plain systemd services bound to
# loopback, and the app binary and web build that deploy.sh shipped alongside
# this script. No containers, no cluster. A service is restarted only when its
# binary or configuration actually changed, so releasing the app does not
# interrupt calls, chat or mail.
set -euo pipefail

DOMAIN=${1:?usage: install.sh <domain> <acme-email> [mail-domain]}
ACME_EMAIL=${2:?usage: install.sh <domain> <acme-email> [mail-domain]}
MAIL_DOMAIN=${3:-$DOMAIN}
# "file:/path" reads the address from a file on the server.
case "$ACME_EMAIL" in file:*) ACME_EMAIL=$(cat "${ACME_EMAIL#file:}") ;; esac

TUWUNEL_VERSION=v2.0.0
STALWART_VERSION=v1.1.1
LIVEKIT_VERSION=1.13.11

HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=$(dirname "$HERE") # deploy.sh ships: opensuite (binary), web/, deploy/
ETC=/etc/opensuite
OPT=/opt/opensuite
DATA=/var/lib/opensuite
PUBLIC_IP=${OS_PUBLIC_IP:-$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')}
PUBLIC_IP6=${OS_PUBLIC_IP6:-$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | sed -n 's/.* src \([0-9a-f:]*\).*/\1/p')}

say() { printf '\n== %s\n' "$*"; }
rand() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }

# put <path> <mode> <owner:group>: write stdin to path if it differs.
# Returns 0 when the file changed, 1 when it was already up to date.
put() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then
    rm -f "$tmp"
    return 1
  fi
  install -m "$2" -o "${3%%:*}" -g "${3##*:}" "$tmp" "$1"
  rm -f "$tmp"
}

# ensure <unit> <changed>: restart on change, otherwise just make sure it runs.
ensure() {
  systemctl enable -q "$1"
  if [ "$2" = 1 ]; then systemctl restart "$1"; else systemctl start "$1"; fi
}

say "packages"
if ! command -v nginx >/dev/null || ! command -v pandoc >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  # Installing our packages must never restart unrelated services on the host.
  export NEEDRESTART_SUSPEND=1
  apt-get update -qq
  apt-get install -y -qq nginx pandoc curl ca-certificates >/dev/null
fi

say "users and directories"
id opensuite >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin opensuite
getent group opensuite-certs >/dev/null || groupadd --system opensuite-certs
usermod -aG opensuite-certs opensuite
usermod -aG opensuite-certs www-data
mkdir -p "$ETC" "$OPT/bin" "$OPT/web" "$DATA/certs" "$DATA/blobs"
chown opensuite:opensuite "$DATA/blobs"
# Certificates are written by the app and read by nginx and the mail engine.
chown opensuite:opensuite-certs "$DATA" "$DATA/certs"
chmod 0751 "$DATA"
chmod 2750 "$DATA/certs"

say "secrets"
if [ ! -f "$ETC/secrets.env" ]; then
  umask 077
  cat > "$ETC/secrets.env" <<EOF
OS_SECRET=$(rand 48)
OS_LIVEKIT_KEY=OS$(rand 12)
OS_LIVEKIT_SECRET=$(rand 48)
OS_MATRIX_SECRET=$(rand 48)
OS_MAIL_ADMIN=admin:$(rand 40)
EOF
  umask 022
fi
chmod 600 "$ETC/secrets.env"
# shellcheck disable=SC1091
. "$ETC/secrets.env"

app=0
put "$ETC/opensuite.env" 640 root:opensuite <<EOF && app=1
OS_DOMAIN=$DOMAIN
OS_MAIL_DOMAIN=$MAIL_DOMAIN
OS_MAIL_HOST=$DOMAIN
OS_LISTEN=127.0.0.1:8600
OS_DATA=$DATA
OS_WEB=$OPT/web
OS_PUBLIC_IPS=$PUBLIC_IP${PUBLIC_IP6:+,$PUBLIC_IP6}
OS_ACME_EMAIL=$ACME_EMAIL
OS_MATRIX_URL=http://127.0.0.1:8008
OS_MATRIX_NAME=$DOMAIN
OS_MAIL_URL=http://127.0.0.1:8446
OS_MAIL_RELAY=${OS_MAIL_RELAY:-}
OS_SIGNUP=${OS_SIGNUP:-open}
OS_SIGNUP_CODE=${OS_SIGNUP_CODE:-}
OS_OPERATORS=${OS_OPERATORS:-}
EOF

say "chat engine (Tuwunel $TUWUNEL_VERSION)"
chat=0
if ! dpkg -s tuwunel >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
  curl -fsSL -o /tmp/tuwunel.deb "https://github.com/matrix-construct/tuwunel/releases/download/${TUWUNEL_VERSION}-assets/${TUWUNEL_VERSION}-assets-release-default-x86_64-v2-linux-gnu-tuwunel.deb"
  apt-get install -y -qq /tmp/tuwunel.deb >/dev/null
  rm -f /tmp/tuwunel.deb
  chat=1
fi
put /etc/tuwunel/tuwunel.toml 640 root:tuwunel <<EOF && chat=1
# Written by Open Suite install.sh. The homeserver is a headless engine: it
# listens on loopback only and accounts are created by the Open Suite app.
[global]
server_name = "$DOMAIN"
database_path = "/var/lib/tuwunel"

[global.http]
max_request_size = "50 MiB"
ip_source = "rightmost_x_forwarded_for"

[global.http.listen]
address = ["127.0.0.1"]
port = 8008

[global.registration]
enable = false
displayname_suffix = ""
shared_secret = "$OS_MATRIX_SECRET"

[global.registration.guests]
enable = false

[global.jwt]
enable = true
key = "$OS_MATRIX_SECRET"
format = "HMAC"
algorithm = "HS256"
register_user = true
require_exp = true
issuer = ["opensuite"]
audience = ["chat"]

[global.federation]
enable = false

[global.federation.keys]
trusted_servers = []

[global.directory.rooms]
allow_over_federation = false
allow_without_auth = false
lockdown = true

[global.profile]
allow_inbound_federation_lookups = false
require_auth = true

[global.presence]
allow_local = true
allow_incoming = false
allow_outgoing = false

[global.cache]
capacity_modifier = 0.5

[global.rocksdb]
cache_capacity_mb = 64.0
write_buffer_capacity_mb = 24.0
EOF
ensure tuwunel $chat

say "video engine (LiveKit $LIVEKIT_VERSION)"
video=0
if [ "$(/usr/local/bin/livekit-server --version 2>/dev/null | awk '{print $NF}')" != "$LIVEKIT_VERSION" ]; then
  curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin livekit-server
  chmod 755 /usr/local/bin/livekit-server
  video=1
fi
put "$ETC/livekit.yaml" 640 root:opensuite <<EOF && video=1
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: $PUBLIC_IP
keys:
  $OS_LIVEKIT_KEY: $OS_LIVEKIT_SECRET
logging:
  level: warn
EOF
put /etc/systemd/system/opensuite-livekit.service 644 root:root < "$HERE/systemd/opensuite-livekit.service" && video=1
# Media needs room in the kernel's UDP buffers.
put /etc/sysctl.d/60-opensuite.conf 644 root:root <<EOF && sysctl -q --system
net.core.rmem_max = 5000000
net.core.wmem_max = 5000000
EOF

say "mail engine (Stalwart $STALWART_VERSION)"
mail=0
if [ "$(/usr/local/bin/stalwart -V 2>/dev/null | awk '{print $NF}')" != "${STALWART_VERSION#v}" ]; then
  curl -fsSL "https://github.com/stalwartlabs/stalwart/releases/download/${STALWART_VERSION}/stalwart-x86_64-unknown-linux-gnu.tar.gz" | tar -xz -C /usr/local/bin stalwart
  chmod 755 /usr/local/bin/stalwart
  mail=1
fi
id stalwart >/dev/null 2>&1 || useradd --system --home /var/lib/stalwart --shell /usr/sbin/nologin -U stalwart
usermod -aG opensuite-certs stalwart
mkdir -p /etc/stalwart /var/lib/stalwart
chown stalwart:stalwart /etc/stalwart /var/lib/stalwart
chmod 750 /etc/stalwart /var/lib/stalwart
[ -f /etc/stalwart/config.json ] || echo '{"@type":"RocksDb","path":"/var/lib/stalwart/"}' | install -m 640 -o stalwart -g stalwart /dev/stdin /etc/stalwart/config.json
put /etc/stalwart/stalwart.env 600 stalwart:stalwart <<EOF && mail=1
STALWART_RECOVERY_ADMIN=$OS_MAIL_ADMIN
STALWART_PUBLIC_URL=https://$DOMAIN
EOF
put /etc/systemd/system/opensuite-mail.service 644 root:root < "$HERE/systemd/opensuite-mail.service" && mail=1

say "app"
if ! cmp -s "$BUNDLE/opensuite" "$OPT/bin/opensuite"; then
  install -m 755 "$BUNDLE/opensuite" "$OPT/bin/opensuite"
  app=1
fi
cp -a "$BUNDLE/web/." "$OPT/web/"
# Fingerprinted assets from older builds stay briefly for open tabs, then go.
find "$OPT/web/assets" -type f -mtime +14 -delete 2>/dev/null || true
put /etc/systemd/system/opensuite.service 644 root:root < "$HERE/systemd/opensuite.service" && app=1

say "services"
systemctl daemon-reload
ensure opensuite-livekit $video
if [ ! -f /etc/stalwart/.configured ]; then
  say "mail engine first-time setup"
  # A fresh engine is configured through its setup port (8080, all
  # interfaces). Keep that port closed to the outside while it is open.
  echo "STALWART_RECOVERY_MODE=1" >> /etc/stalwart/stalwart.env
  iptables -C INPUT -p tcp --dport 8080 ! -i lo -j DROP 2>/dev/null || iptables -I INPUT -p tcp --dport 8080 ! -i lo -j DROP
  systemctl enable -q opensuite-mail
  systemctl restart opensuite-mail
  for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8080/ && break; sleep 1; done
  (set -a; . "$ETC/opensuite.env"; . "$ETC/secrets.env"; set +a; "$OPT/bin/opensuite" mail-setup http://127.0.0.1:8080)
  sed -i '/STALWART_RECOVERY_MODE/d' /etc/stalwart/stalwart.env
  touch /etc/stalwart/.configured
  systemctl restart opensuite-mail
  iptables -D INPUT -p tcp --dport 8080 ! -i lo -j DROP
else
  ensure opensuite-mail $mail
fi
ensure opensuite $app

say "nginx"
web=0
sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/nginx/opensuite.conf" | put /etc/nginx/sites-available/opensuite.conf 644 root:root && web=1
ln -sf /etc/nginx/sites-available/opensuite.conf /etc/nginx/sites-enabled/opensuite.conf
rm -f /etc/nginx/sites-enabled/default
systemctl enable -q nginx
if [ $web = 1 ] || ! systemctl is-active -q nginx; then
  nginx -t
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
fi

say "done: https://$DOMAIN"
