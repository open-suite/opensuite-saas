#!/usr/bin/env bash
# Only for a server that also runs k3s with Traefik on ports 80/443 (the
# shared demo box). k3s captures those ports before nginx sees them, so this
# asks Traefik to hand one host name straight through to nginx:
#
#   :443  TLS passthrough by SNI  -> nginx 10.42.0.1:9443 (PROXY protocol)
#   :80   plain HTTP by Host      -> nginx 10.42.0.1:9080
#
# nginx still terminates TLS itself with the certificate the app obtained, so
# nothing about Open Suite differs from a dedicated server. On a dedicated
# server this script is not needed at all.
#
#   coexist-k3s.sh <domain> [host ...]   add the route, for the app's host
#                                        and others such as the mail host
#                                        (its certificate is issued over HTTP)
#   coexist-k3s.sh <domain> off          remove it
set -euo pipefail
DOMAIN=${1:?usage: coexist-k3s.sh <domain> [host ...|off]}
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
BRIDGE=$(ip -4 -o addr show cni0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p')
NAME=opensuite-native
SNI="HostSNI(\`$DOMAIN\`)"
HOST="Host(\`$DOMAIN\`)"
for h in "${@:2}"; do
  [ "$h" = off ] && continue
  SNI="$SNI || HostSNI(\`$h\`)"
  HOST="$HOST || Host(\`$h\`)"
done

if [ "${2:-}" = off ]; then
  kubectl -n kube-system delete ingressroutetcp,ingressroute,service,endpoints "$NAME" --ignore-not-found
  rm -f /etc/nginx/opensuite-plain-k3s.conf /etc/nginx/opensuite-tls-k3s.conf
  nginx -t && systemctl reload nginx
  exit 0
fi

# Extra nginx listeners, reachable only from inside the cluster network.
echo "listen $BRIDGE:9080;" > /etc/nginx/opensuite-plain-k3s.conf
cat > /etc/nginx/opensuite-tls-k3s.conf <<EOF
listen $BRIDGE:9443 ssl http2 proxy_protocol;
set_real_ip_from 10.42.0.0/16;
real_ip_header proxy_protocol;
EOF
nginx -t
systemctl reload nginx

kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata: { name: $NAME, namespace: kube-system }
spec:
  ports:
    - { name: https, port: 9443, targetPort: 9443 }
    - { name: http, port: 9080, targetPort: 9080 }
---
apiVersion: v1
kind: Endpoints
metadata: { name: $NAME, namespace: kube-system }
subsets:
  - addresses: [{ ip: $BRIDGE }]
    ports:
      - { name: https, port: 9443 }
      - { name: http, port: 9080 }
---
apiVersion: traefik.io/v1alpha1
kind: IngressRouteTCP
metadata: { name: $NAME, namespace: kube-system }
spec:
  entryPoints: [websecure]
  routes:
    - match: $SNI
      services:
        - { name: $NAME, port: 9443, proxyProtocol: { version: 2 } }
  tls: { passthrough: true }
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata: { name: $NAME, namespace: kube-system }
spec:
  entryPoints: [web]
  routes:
    - match: $HOST
      kind: Rule
      services:
        - { name: $NAME, port: 9080 }
EOF
echo "routed $DOMAIN ${*:2} through Traefik to nginx on $BRIDGE"
