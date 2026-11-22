# Open Suite (native, multi-organisation) — agent guide

Read `README.md` first for the architecture. This file is what an agent needs
that the code does not say.

## Product rules (from the owner, 2026-11-21)

- It is just "Open Suite". No other product's name, logo, theme or UI style
  may reach the screen. The engines (Stalwart, Tuwunel, LiveKit, IronCalc,
  Tiptap) are implementation details: never surface their names in the UI or
  in user-facing text.
- One app, one sign-in. Never add a second login, an SSO hop, an iframe of
  another app's UI, or a second origin.
- Light: one server, native installs (nginx, systemd). No Docker, no
  Kubernetes, no extra resident services without a strong reason.
- Fast: a returning user gets a usable screen within 100 ms and never sees a
  loading spinner. `tests/perf.cjs` enforces the budgets; run it after any
  change to loading, routing, the editors or the data layers.
- Sovereign: European hosting, no US service in the data path.

## How the 100 ms rule is met (do not break these)

- The service worker serves `/?shell` (no user data) for every navigation;
  the first server HTML inlines the boot object instead. Never cache a
  response that contains one person's data in the service worker.
- `lib/store.js` restores the boot object from `localStorage`; `refreshBoot()`
  reconciles it and discards a snapshot that overlapped a local write
  (otherwise a new document vanishes when a stale snapshot lands).
- New documents, sheets and meetings mint their id on the client and open at
  once; the server call happens behind (`lib/docs.js`).
- The three heavy chunks (editor, sheet, call) load at idle and then
  "rehearse" and prewarm recent documents into memory, including fetching
  ones this device has never held (`/api/docs/{id}/state`).
- Editors mount in a layout effect so content is in the frame after the click.

## Sync model

`server/docs.go` is format-agnostic: snapshot + ordered log of opaque updates,
each tagged with an 8-byte id for idempotent resend. Text documents send Yjs
updates (order-free). Spreadsheets send engine diffs (order-dependent), so the
client keeps `base + log (server order) + mine (unconfirmed)` and rebuilds in
server order when someone else's edit lands in between (`apps/sheet-core.js`).
A client offers a compacting snapshot only when its state equals a known
sequence number.

Sync message 10 is plain text from a client with edit rights, for the search
index. The hello message is `peer, may write, index fresh`. 11 to 15 are free.

## The parts added on 2026-11-22

- **Search** (`server/search.go`, `lib/search.js`, `lib/search-sources.js`).
  The server never reads documents, so any editor that owns a `DocSocket`
  must set `sock.text = () => <plain text>` or its documents are found by
  title only. `doc_text` and `doc_fts` are kept by triggers on `docs`; do not
  write to them elsewhere. User input reaches FTS5 only through `ftsQuery`.
  A new source is one `addProvider` call; `local` must be synchronous and
  read memory only, anything async goes in `remote`. Rows never reorder and
  late results never push the selected row.
- **Files** (`server/files.go`, `lib/files.js`, `apps/files.jsx`). Uploaded
  content is untrusted and only ever served through `serveFile`: text of
  every kind as `text/plain`, unknown types as attachments, `nosniff`, and
  `Content-Security-Policy: sandbox` (PDF gets `default-src 'none'` without
  sandbox, because Chrome's viewer will not start inside one). Access is
  inherited from folders, so a move can grant ownership: `mayMove` is the
  guard on every move path. A document is filed by `docs.folder_id`. A new
  kind of document is one line each in `docKinds` (server and `lib/docs.js`)
  and `kindIcons`. Backups must include `<data>/files`.
- **Calendar and contacts** (`server/calendar.go`, `lib/calendar.js`,
  `lib/contacts.js`). They live in the mail engine and go through
  `/api/mail/jmap` with the same account pinning. `Principal/*` stays
  refused and `shareWith` is rejected; free/busy is a server endpoint scoped
  to the caller's organisation. The engine speaks the newer JSCalendar
  (`recurrenceRule` singular, `calendarAddress`). We write our own
  invitation mails (raw message: upload, `Email/import`,
  `EmailSubmission/set`) because the engine's carry its own branding; with
  `autoAddInvitations` on, the engine files incoming ones and applies
  answers. `ContactCard/parse` returns only the first card, so vCards are
  parsed in the browser.
- **Presentations** (`apps/slides*.js(x)`). A Yjs document; slides and
  elements are keyed by id and ordered by a number. Never move one by delete
  and re-insert: that drops what a colleague is typing. An empty deck is
  seeded with fixed ids, at once only when `isFresh(id)`, so two devices
  never make two first slides. `frameCss` and `textCss` are shared by the
  drawn box and the live editor; change them together.
- **Comments and suggestions** (`apps/doc-comments.js`, `doc-marks.js`).
  Threads live in the document's own Yjs state. The "comment" role may
  comment and suggest but the server cannot tell a comment from an edit, so
  it is a courtesy between colleagues, not a security boundary. "Clear
  formatting" must not use `unsetAllMarks` (it would strip comment and
  suggestion marks).
- **Version history** (`server/versions.go`). A version is the gzipped
  protocol frames, so it works for any kind. Documents restore as a client
  edit, as its own undo step (`stopCapturing`): joined to typing from a
  moment before, one Undo emptied the page. Spreadsheets restore on the
  server by swapping the log. `Hub.room` and `Hub.release` must be paired.
- **Charts** (`apps/sheet-charts.js`) are rows in a hidden sheet of the
  workbook, so they sync, version and undo like cells. Anything that walks
  worksheets must skip the hidden ones.

## Engines: facts verified on 2026-11-21

- **Stalwart 1.1.1** has no TOML and no REST admin API any more. All
  configuration is JMAP `x:<Object>/get|set|query` on `/jmap/` with capability
  `urn:stalwart:jmap`, authenticated as `STALWART_RECOVERY_ADMIN` (works in
  normal mode too). A fresh engine exposes only a setup port (8080, all
  interfaces) in recovery mode; `install.sh` firewalls it and runs
  `opensuite mail-setup`. Account id in management equals the JMAP account id.
  Creating an existing account returns `primaryKeyViolation` with the id.
  The browser never talks to it: `/api/mail/jmap` pins `accountId` and allows
  mail methods only (`server/mail.go`, tested).
- **Tuwunel 2.0.0** release assets live under the tag `v2.0.0-assets`. Users
  are created by JWT login (`org.matrix.login.jwt`); nginx blocks
  `/login`, `/register`, the user directory and the public room list.
  Membership must be loaded in full (no lazy loading) because room titles and
  direct-chat detection depend on it.
- **LiveKit** needs no Redis on one node. The browser connects to
  `wss://<host>/lk`; media uses udp/7882 and tcp/7881 directly.
- **IronCalc 0.9.1** (`@ironcalc/wasm-xlsx`): an empty send queue is 1 byte;
  `pasteCsvText` needs the selected cell inside the area;
  `web/scripts/probe-engine.mjs` records these assumptions and can be re-run
  after an upgrade.
- **Preact 11** does not add `px` to numeric inline styles; `lib/px.js`
  restores that. nginx on Ubuntu 24.04 is 1.24: `listen ... http2`, not
  `http2 on`.

## Test deployment

- `https://office.demo.opensuite.online` on the shared demo box
  `95.217.109.206` (same server as the old k3s stack, which must keep
  working). k3s captures ports 80/443, so `deploy/coexist-k3s.sh` adds a
  Traefik TCP passthrough (kube-system objects named `opensuite-native`) to
  nginx on `10.42.0.1:9443/9080`. On a dedicated server none of that exists.
- Deploy: `OS_OPERATORS=ada@office.demo.opensuite.online OS_SIGNUP=code OS_SIGNUP_CODE=<code> deploy/deploy.sh root@95.217.109.206 office.demo.opensuite.online file:/etc/opensuite/acme-email`
  The settings are rewritten on every deploy, so pass all of them each time
  (the current code is in `/etc/opensuite/opensuite.env` on the box).
- Sign-up there is by invitation code on purpose: the box can deliver mail
  directly, and open sign-up would let anyone send from its address. Do not
  open it before outbound limits and abuse handling exist.
- Test accounts: `ada` (owner and operator) and `grace.hopper`; passwords are
  in the handover notes, not in the repo.
- Port 25 over IPv4 on that box still belongs to the old stack's mail pod, and
  the test domain has no MX/SPF/DKIM/PTR, so mail there is internal only.
- The production name `office.opensuite.online` has no DNS record yet (DNS is
  at Namecheap; no API access from here).

## Gotchas already paid for

- `@preact/signals` makes a component that has hook state or reads signals
  re-render only when its props, state or signals change. A component that
  reads a mutable object at render time (the editor, the sheet controller)
  must be given a changing prop (`tick`) or it goes stale silently. The
  editor toolbar did exactly that; `tests/e2e.cjs` now checks it.
- Toolbars use `keepFocus` on mousedown so buttons never take the caret from
  the document or grid; without it fast typing after a click loses keystrokes.
- A cell edit begins on a key press but the cell editor takes focus one frame
  later; `Sheet.onKey` handles keys in that gap. Do not remove that branch.

- `apt-get install` on that box triggers needrestart, which restarted k3s.
  `install.sh` now sets `NEEDRESTART_SUSPEND=1`; keep it.
- Let's Encrypt allows 5 failed validations per host per hour. Make sure
  `/.well-known/acme-challenge/` reaches the app before restarting it on a new
  host.
- nginx `include` globs: `opensuite-plain-*.conf` and `opensuite-tls-*.conf`
  must not match each other.
- Background test tabs never get focus; the checks use a synthetic camera and
  microphone so no real device is opened. They also slow timers to one a
  second, so effects run late: a check must not assume a shortcut is
  listening or an effect has run the instant a selector appears, and a
  screen must not rely on an effect for its first frame.
- Sign-in is limited to 10 attempts per address per 5 minutes. Running many
  checks back to back against one deployment hits it; wait, do not raise it.
- The checks remember the colleague they created per deployment in
  `tests/.state.json` (`remember()` in `tests/browser.cjs`).
- `autofocus` does nothing on forms opened after load; focus in a layout
  effect. Tiptap's `editor.getText()` throws after `destroy()`; read
  `editor.state.doc`. A numeric CSS custom property in an inline style gets
  `px` from `lib/px.js`; pass a string.
- Local development: `dev/mail.sh` then `dev/run.sh <name> <port>`. The
  service worker registers on https only, so `tests/perf.cjs` needs a
  server.
