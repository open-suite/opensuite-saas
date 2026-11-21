# Open Suite

A sovereign office suite that runs on one server: mail, chat, video meetings,
documents and spreadsheets, with an admin console, behind one sign-in, as one
app. No containers, no cluster. Hosted for many organisations at once, each
with its own people, admins and (optionally) its own domain.

This is a ground-up rewrite of the earlier k3s distribution (see
`../open-suite`). That version assembled nine separately branded apps behind
Keycloak and an auth gate; its recurring problems were sign-in state drifting
between apps, other products' names and styles leaking through, and weight
(about 70 pods and 16 GB of memory for a demo). This version has one identity,
one interface and one origin, and uses about 0.5 GB.

## How it is built

```
browser ── https ──> nginx ──┬─> opensuite (Go, :8600)   identity, orgs, documents, glue
   one origin, one cookie    ├─> Tuwunel   (:8008)       chat engine   (Matrix homeserver)
                             ├─> LiveKit   (:7880)       video engine  (media on udp/7882, tcp/7881)
                             └─> /assets from disk
                 opensuite ──┴─> Stalwart  (:8446)       mail engine   (SMTP 25/465/587, IMAP 993)
```

- **One app.** `server/` is a single Go binary with a SQLite database. It owns
  accounts, organisations, sessions, documents, spreadsheets, meeting rooms,
  TLS certificates and custom domains. `web/` is one Preact single-page app
  that draws every screen from one design system (`web/src/style.css`,
  `web/src/ui.jsx`).
- **Three headless engines** do the protocol work that should not be
  rewritten: Stalwart (mail), Tuwunel (Matrix chat), LiveKit (WebRTC). Each is
  a native binary under systemd, bound to loopback. None has a user-facing
  page or a login of its own: the app vouches for people with signed
  assertions and machine credentials, so there is no single sign-on to drift.
- **Local-first.** A service worker keeps the app shell on the device; data is
  mirrored there (IndexedDB) and painted before the network answers.
  Documents are CRDTs (Yjs) edited locally and synced; spreadsheets run the
  IronCalc engine in the browser (WebAssembly, reads and writes .xlsx itself).
  The server relays and stores opaque updates (`server/docs.go`).
- **Custom domains** need no reload and no per-domain config: nginx picks the
  certificate per handshake from `certs/<server name>.crt`, and the app's own
  ACME client writes that file once the customer's DNS points here.

Measured on the test deployment (browser in South Africa, server in Finland,
`tests/perf.cjs`): return visit to a usable screen 31 ms; switching sections
20 ms; opening a document 64 ms, a spreadsheet 85 ms, a mail conversation
49 ms (medians). A first ever visit is bounded by the network (about 430 ms
at that distance, 47 KB). Memory in use for the whole suite: about 500 MB.

## Layout

| Path | What |
| --- | --- |
| `server/` | Go backend. `main.go` routes, `auth.go`, `admin.go`, `docs.go` (sync hub), `mail.go`, `chat.go`, `meet.go`, `tls.go` (ACME), `web.go`, `convert.go` (pandoc). |
| `web/` | Preact app. `src/lib/` data layers (`store`, `api`, `sync`, `mail`, `matrix`), `src/apps/` screens, `src/sw.js` offline shell. |
| `deploy/` | `deploy.sh` (build and ship), `install.sh` (server side, idempotent), nginx and systemd files, `coexist-k3s.sh` (shared demo box only). |
| `tests/` | `e2e.cjs` two-person end-to-end run, `perf.cjs` performance budgets. Backend tests are `server/*_test.go`. |

## Develop

```sh
cd server && OS_SECRET=$(openssl rand -hex 32) go run .     # API on :8600, data in ./data
cd web && npm install && npm run dev                        # app on :5173, proxies /api
cd server && go test ./...
```

Without the engines configured (`OS_MATRIX_URL`, `OS_MAIL_URL`, LiveKit keys)
identity, admin, documents and spreadsheets work; chat, mail and meetings
show their "being prepared" state.

## Deploy

On a fresh Ubuntu 24.04 server with ports 80, 443, 25, 465, 587, 993,
7881/tcp and 7882/udp open, and DNS for the domain pointing at it:

```sh
deploy/deploy.sh root@server office.example.com admin@example.com
```

That builds the web app and a static Linux binary, ships them, and runs
`install.sh`, which installs nginx, pandoc and the three engines, generates
secrets once (`/etc/opensuite/secrets.env`), configures the mail engine on
first run, and starts everything. Re-running it is the release process; a
service restarts only if its binary or configuration changed. Optional
settings pass through the environment: `OS_SIGNUP` (`open`, `code`, `closed`),
`OS_SIGNUP_CODE`, `OS_OPERATORS` (sign-in addresses of platform operators),
`OS_MAIL_RELAY` (`host:port:user:password` for an outbound smarthost).

For mail to be accepted by other providers, publish for the mail domain: an
MX record to the server, SPF, the DKIM keys the mail engine generated (shown
in Admin → Domains for customer domains), DMARC, and a PTR record for the
server's address.

Check a deployment:

```sh
OS_BASE=https://office.example.com OS_E2E_USER=... OS_E2E_PASS=... node tests/e2e.cjs
OS_BASE=https://office.example.com OS_E2E_USER=... OS_E2E_PASS=... node tests/perf.cjs
```

## What version 1 includes

- Organisations with owner, administrator and member roles; a free plan
  (5 people, 5 GB, 1 custom domain) and a larger one, switched by the platform
  operator. Admins add people (temporary password, replaced at first sign-in),
  change roles, suspend, reset passwords and remove.
- Custom domains for the web address and for mail, verified against DNS, with
  certificates issued automatically.
- Mail: folders, conversations, search, compose with attachments, reply and
  forward, archive, star, push delivery, remote images blocked until asked.
- Chat: direct and group conversations, files and images, unread counts,
  typing notices, a one-click meeting from any conversation.
- Meet: permanent room links, guests join with no account, screen sharing.
- Docs: rich-text documents with live cursors and offline editing; import and
  export of Word, OpenDocument and Markdown; print to PDF.
- Sheets: formulas, formatting, borders, merges, multiple sheets, live
  cursors; Excel import and export.
- Home: recent documents, inbox, conversations and meeting rooms in one view.

Not in version 1: calendar and contacts (the mail engine already speaks both
protocols), a file drive, presentations, wiki, payments, mail access from
other mail apps (IMAP is running but people have no app passwords yet), chat
federation with other Matrix servers (off by one setting), end-to-end
encrypted chat, and offline editing of spreadsheets beyond the open session.
