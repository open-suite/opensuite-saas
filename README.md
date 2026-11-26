# Open Suite

A sovereign office suite that runs on one server: mail, calendar, contacts,
chat, video meetings, files, documents, spreadsheets and presentations, with
search across all of it and an admin console, behind one sign-in, as one app. No containers, no cluster. Hosted for many organisations at once, each
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
| `server/` | Go backend. `main.go` routes, `auth.go`, `admin.go`, `docs.go` (sync hub), `versions.go` (history), `files.go` (drive), `search.go` (index), `mail.go`, `groups.go` (shared inboxes), `calendar.go`, `chat.go`, `meet.go`, `tls.go` (ACME), `web.go`, `convert.go` (pandoc), `demo.go` (daily demo reset; its story and files in `server/demo/`). The public API: `api.go` (the operation table), `mailapi.go`, `calapi.go`, `chatapi.go`, `content.go` with `engine.go` (document content), `tokens.go`, `oauth.go`, `mcp.go`, `openapi.go`, `schema.go`. |
| `web/` | Preact app. `src/lib/` data layers (`store`, `api`, `sync`, `mail`, `calendar`, `contacts`, `files`, `search`, `matrix`), `src/apps/` screens, `src/sw.js` offline shell. `src/headless/` builds the app's document code into the content engine (`dist-headless/engine.mjs`). |
| `deploy/` | `deploy.sh` (build and ship), `install.sh` (server side, idempotent), nginx and systemd files, `coexist-k3s.sh` (shared demo box only). |
| `dev/` | `mail.sh` (a loopback mail engine), `run.sh` (build and run a checkout locally). |
| `tests/` | `e2e.cjs` two-person end-to-end run and one `e2e-<part>.cjs` per newer part; `perf.cjs` and `perf-<part>.cjs` performance budgets. Backend tests are `server/*_test.go`. |

## Develop

```sh
dev/mail.sh                    # once, in its own terminal: mail engine on 127.0.0.1:8446
dev/run.sh main 8610           # builds and serves http://main.localhost:8610
cd server && go test ./...
```

`run.sh <name> <port>` gives each checkout its own data and mail domain, so
several branches can run side by side. Chat and calls need their engines,
which have no macOS build; those two screens only work on a server. Set
`OS_DEV_DIR` to choose where local data lives (default `~/.opensuite-dev`).

## Deploy

On a fresh Ubuntu 24.04 server with ports 80, 443, 25, 465, 587, 993,
7881/tcp and 7882/udp open, and DNS for the domain pointing at it:

```sh
deploy/deploy.sh root@server office.example.com admin@example.com
```

That builds the web app and a static Linux binary, ships them, and runs
`install.sh`, which installs nginx, pandoc, Node (for the content engine,
run on demand like pandoc) and the three engines, generates
secrets once (`/etc/opensuite/secrets.env`), configures the mail engine on
first run, and starts everything. Re-running it is the release process; a
service restarts only if its binary or configuration changed. Optional
settings pass through the environment: `OS_SIGNUP` (`open`, `code`, `closed`),
`OS_SIGNUP_CODE`, `OS_OPERATORS` (sign-in addresses of platform operators),
`OS_MAIL_RELAY` (`host:port:user:password` for an outbound smarthost, or
`file:/path` to read it from a file on the server), `OS_DEMO`
(`<org id>,<login>:<password>,...`, or `file:/path`: a public demo
organisation, put back to the example story in `server/demo/` every morning at
04:00 Berlin time and from Admin → All organisations).

For mail to be accepted by other providers, publish for the mail domain: an
MX record to the server, SPF, the DKIM keys the mail engine generated (shown
in Admin → Domains for customer domains), DMARC, and a PTR record for the
server's address.

Check a deployment:

```sh
OS_BASE=https://office.example.com OS_E2E_USER=... OS_E2E_PASS=... node tests/e2e.cjs
OS_BASE=https://office.example.com OS_E2E_USER=... OS_E2E_PASS=... OS_E2E_COLLEAGUE_PASS=... node tests/e2e-groups.cjs
OS_BASE=https://office.example.com OS_E2E_USER=... OS_E2E_PASS=... node tests/perf.cjs
OS_BASE=https://office.example.com OS_E2E_USER=... OS_E2E_PASS=... MCP_SDK=.../node_modules/@modelcontextprotocol/sdk node tests/e2e-api.cjs
```

`e2e-api.cjs` drives the API and the MCP server (with the official MCP
client, including the OAuth flow) without a browser.

## What it includes

- Organisations with owner, administrator and member roles; a free plan
  (5 people, 5 GB, 1 custom domain, 5 groups, mail only to addresses this
  installation hosts) and a larger one (250 people and groups) that can mail
  anyone, switched by the platform operator. Admins add people (temporary
  password, replaced at first sign-in), change roles, suspend, reset
  passwords and remove.
- Groups: shared inboxes with an address of their own, like sales@. Anyone
  can write to one, people outside the organisation included, unless an
  administrator limits it to the organisation or to the group's members.
  Members are people or agents, as viewers (read), users (also send and
  reply as the group) or group admins (also manage viewers and users).
  Members see each group in Mail beside their own mailbox, with unread
  counts, search, a choice of sender when writing, and who in the group has
  read and answered each conversation. Groups are listed in Contacts and
  complete in address fields.
- Custom domains for the web address and for mail, verified against DNS, with
  certificates issued automatically.
- Mail: folders, conversations, search, compose with attachments, reply and
  forward, archive, star, push delivery, remote images blocked until asked.
- Calendar: month, week, day and agenda views, repeating events, time zones,
  several calendars, reminders, invitations by mail with one-click answers,
  colleagues' free and busy times, a meeting link on any event.
- Contacts: an address book beside the organisation's directory, vCard import
  and export, address completion in mail and invitations.
- Chat: direct and group conversations, files and images (from the device or
  from Files), unread counts, typing notices, a one-click meeting from any
  conversation.
- Meet: permanent room links, guests join with no account, screen sharing,
  background blur and virtual backgrounds computed on the person's own device.
- Files: folders, uploads, previews, trash, sharing with colleagues and by
  public link, a storage quota per organisation. Documents of every kind live
  in the same folders.
- Docs: rich-text documents with live cursors and offline editing; comments,
  suggestions (tracked changes) and version history; import and export of
  Word, OpenDocument and Markdown; print to PDF.
- Sheets: formulas, formatting, borders, merges, multiple sheets, live
  cursors, charts, version history; Excel import and export.
- Slides: presentations with text, shapes and pictures, layouts and themes,
  speaker notes, a presenter view, live collaboration; PowerPoint import and
  export; print to PDF.
- Search: one box (Ctrl/Cmd+K or "/") over people, contacts, documents and
  their contents, files, calendar, mail, chat and meetings.
- Home: today's agenda, recent documents, inbox, conversations and meeting
  rooms in one view.
- An API for everything: a versioned JSON API at `/api/v1` covering every
  part above and the administration, described by an OpenAPI 3.1 document
  (`/api/v1/openapi.json`) and a reference page (`/api/v1/reference`), and
  the same operations as an MCP server at `/mcp`, so an AI assistant can be
  connected by its address alone (OAuth 2.1). People make API tokens in
  Account settings (full access or read only); administrators add agents,
  members without a password that act only through tokens, and count
  towards the plan's people limit like anyone with a mailbox. No extra cost,
  and no limits beyond abuse protection (1,200 calls a minute per token, 200
  messages an hour per member).

Not included yet: wiki, payments, mail and calendar access from other apps
(IMAP is running but people have no app passwords yet), chat federation with
other Matrix servers (off by one setting), end-to-end encrypted chat, offline
editing of spreadsheets beyond the open session, shared calendars, comments
on spreadsheet cells, charts in Excel files, tables in presentations, and
version history for presentations.

## Licence

MIT, see `LICENSE`. Two things in the tree come from elsewhere under their
own terms: `web/public/assets/seg/selfie_multiclass_256x256.tflite` is
Google's MediaPipe model (Apache 2.0), and the engines the installer
downloads (Stalwart, Tuwunel, LiveKit) keep their own licences. The call
backgrounds in `web/public/assets/bg/` are drawn by
`web/scripts/backgrounds.cjs` and are ours.
