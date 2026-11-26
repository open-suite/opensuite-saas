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

- **Call backgrounds** (`lib/backdrop.js`, `lib/matte.js`,
  `apps/backdrop.jsx`, added 2026-11-23). Blur and replacement run in the
  person's own browser on WebGL2. `@livekit/track-processors` supplies only
  the camera-stream plumbing (`ProcessorWrapper`); the picture pipeline is
  ours (`Matte`). Do not go back to that library's own `BackgroundProcessor`:
  it takes the model's yes/no mask at 256 pixels and stretches it, which
  gives stepped outlines, and it was tried and rejected twice (here, and in
  the earlier k3s suite). What makes ours smooth, in order of effect: the
  model's soft confidence instead of its category; a joint bilateral filter
  that moves the mask's edge onto real edges in the camera frame; steadying
  against the previous frame; a blur that ignores the person. The model is
  MediaPipe's `selfie_multiclass_256x256` (16 MB): the 250 KB
  `selfie_segmenter` leaves furniture attached to people and breaks hands.
  Judge any change at 3x zoom on a real photo or video, never on a
  thumbnail. The model draws into the same WebGL context, so `draw()` sets
  all the state it needs every frame. A graphics card that cannot keep up
  drops to asking the model every other frame (`light`).
  The runtime and model are served from `/assets/seg-<version>/` (copied by
  `vite.config.js`, model committed under `web/public/assets/seg/`), never
  from the CDNs MediaPipe defaults to. Those files and `/assets/bg/` are
  left out of the service worker's list on purpose (40 MB on disk, 18 MB
  fetched). The call screen waits for `settled(track)` before publishing, so
  the real room is never sent while a chosen background is starting. No
  WebGL2 means no chooser (`supported`). The built-in scenes are drawn by
  `web/scripts/backgrounds.cjs`; rename the folder if they change.
  `tests/e2e-backdrop.cjs` reads the pixels; give it `OS_PORTRAIT` to judge
  edges on a real photo.

- **Demo reset** (`server/demo.go`, `server/demo/`, added 2026-11-26). The
  organisation named by `OS_DEMO` is put back to `demo/seed.json` every
  morning and from Admin → All organisations. It runs inside the server, not
  as a command, because the server holds the sync hub: deleted documents'
  editors are disconnected (`Hub.evict`), and documents get new ids so no
  device copy merges into the fresh seed. Rows are chosen by the
  organisation's id and the engines are reached only through its own
  people's accounts; mail is imported, never submitted, and events are made
  with `sendSchedulingMessages: false` (`TestDemoReset` checks all of this).
  The documents, spreadsheet and deck are built by
  `web/scripts/demo-seed.mjs` with the app's own schema and engine
  (`apps/doc-format.js`, `apps/slides-doc.js` exist so it can import them);
  the pictures and PDF by `web/scripts/demo-pictures.cjs` in the test
  browser. Comment authors and times are written as same-length stand-ins
  that `demoPersonalise` swaps at reset. A document seed must end in a
  paragraph, or the editor's trailing paragraph rewrites it on first open.
  Chat cannot run on macOS, so the chat part is only exercised on a server.

## The public API, MCP server and agents (added 2026-11-26)

- **One table.** Every operation of `/api/v1` is an `apiOp` in `api.go` (or
  beside its area: `mailapi.go`, `calapi.go`, `chatapi.go`, `content.go`).
  The table routes the request, writes `openapi.json` and the reference
  page, and is the MCP server's tool list (`mcp.go` runs a tool by calling
  the same handler in-process through `runOp`). A new capability is one
  entry; never add a route or a tool outside it. `Write` and `Admin` are
  enforced in `permit` for HTTP and MCP alike; a handler that reuses an
  app handler must not rely on that handler's old `s.admin` wrapper.
- **Reuse.** Where the app already does the job the entry points at the
  app's handler; otherwise the API builds exactly what the app sends (mail
  as `lib/mail.js` does, events as `calendar-event.jsx` does). Mail sent by
  the API, invitations included, passes `recipientsAllowed` (`rawCalls`).
- **Credentials.** `Authorization: Bearer` works on `/api/v1` and `/mcp`
  only; with a Bearer header the cookie is ignored, so `guard` lets those
  requests through cross-site. App routes stay cookie-only. Tokens are
  SHA-256 hashes in `api_tokens`; an OAuth connection is a row there too
  (short-lived `hash`, rotating `refresh_hash`). Suspension stops tokens by
  the `status` check in `bearerUser`; removal deletes them by foreign key.
- **Agents** are `users.kind = 'agent'` with an empty `pw_hash` (never
  matches). They count towards the plan's people limit. Only agents' tokens
  can be managed by an administrator; people manage their own.
- **Content engine** (`engine.go`, `web/src/headless/`). The server still
  never parses documents: it passes snapshot and log to the app's own code
  in Node and applies the returned update through `applyUpdate` with no
  peer, so it is stored, versioned, fanned out and merged like a browser's.
  The engine is started on demand and stops after three idle minutes. Any
  logic the engine needs must live in a module the app imports too
  (`doc-format.js`, `slides-doc.js`, `sheet-data.js`, `lib/invite.js`,
  `lib/occurrences.js`); `web/scripts/check-headless.mjs` checks every op.
  The server runs the pinned Node from `install.sh` (`OS_NODE`).
- **MCP** speaks 2026-07-28 (stateless, `_meta` per request, mirrored
  headers checked, `server/discover`) and, for clients that open with
  `initialize`, 2025-11-25, 2025-06-18 and 2025-03-26. No sessions, nothing
  pushed. OAuth follows the same revision: protected resource metadata,
  RFC 8414 metadata, Client ID Metadata Documents (fetched only from public
  addresses), dynamic registration, PKCE S256 only, `iss` in the response.
- **Demo reset** revokes every token and connection of the demo
  organisation's seed people and removes agents with the other members.
- **Tests**: `server/api_test.go`, `content_test.go` (needs Node and the
  web build), `groups_test.go` and `tests/e2e-api.cjs` (needs `MCP_SDK`).

## Groups: shared inboxes (added 2026-11-26)

- **In the engine** (`server/groups.go`) a group is an `x:Account` of
  `@type: Group` with its own folders; it has no credentials. Users and
  group admins are engine members (`memberGroupIds/<group>` on their own
  account): the engine then lists the group's account in their session with
  full rights, and lets them submit from its address. Viewers are not
  members; the suite shares each of the group's folders with them
  (`shareWith`, `mayReadItems` + `maySetSeen`). So the engine enforces the
  roles too; the suite never holds a credential for a group.
- **One proxy rule.** Every mail endpoint (`/api/mail/jmap`, blob, upload,
  `files/from-mail`, `files/{id}/to-mail`, and every `/api/v1/mail/*`
  operation through `mailCall`) resolves `?group=` with `mailAccount` and
  pins calls to that account. `groupCallOK` decides by role: viewers read
  and set only `$seen` and their own read mark; nobody changes a group's
  folders, identity, filters or calendars, or imports into it. A group's
  standard folders are all made at creation, so nothing needs to create one.
  `shareWith` is refused from browsers for folders too (`groupwareCallOK`).
- **Senders.** The engine checks only the envelope, so `sendersAllowed`
  (in `callsAllowed`, beside `recipientsAllowed`) requires every submitted
  message's From to be the address of the mailbox it is sent from; an
  imported message (an invitation) is read back from the engine to check.
  A member's own account also lists the group's address as an identity;
  sending as the group from there is refused, so the copy lands in the
  group's Sent.
- **Who may write** is a Sieve script named `opensuite` on the group's
  account (`groupPolicy`). Mail from other providers carries the
  `Authentication-Results` header the engine adds on port 25; local
  submissions do not, and their envelope sender is the authenticated
  account's. Restricted groups discard outside mail (no backscatter) and
  reject colleagues who may not write (they get a bounce saying why). The
  allowed list is rewritten when people or members change
  (`refreshPolicies`); `policyMu` serialises writes, because the engine
  refuses overlapping edits of one script.
- **Read and replied marks** are keywords on the group's messages,
  `os-read-<member id>` and `os-replied-<member id>` (with `$answered`). The
  API reports them as `readBy` and `repliedBy`. A user could set someone
  else's mark: like the comment role, a courtesy between colleagues.
- **Addresses** of people and groups are one space (`addressTaken`).
  Reserved names (`validLocalPart`) apply on the installation's shared mail
  domain; on an organisation's own domain a group may be `support@`,
  `info@` and so on. Plans allow 5 (free) or 250 (team) groups.
- **Demo reset** deletes the demo organisation's groups and makes the
  seed's (`groups` in `demo/seed.json`), importing their mail through a
  member's account. The engine refuses to delete a group that still has
  members, so `groupDeleteMail` drops memberships in the same call.
- **Web**: `lib/mail.js` makes one box per mailbox (`own`, `boxFor(group)`)
  and routes pushes by account id; the old single-mailbox exports remain
  for home, calendar and search. `apps/groups.jsx` is Admin → Groups and the
  settings dialog Mail opens for group admins. `tests/e2e-groups.cjs`.

## Engines: facts verified on 2026-11-21

- **Stalwart 1.1.1** has no TOML and no REST admin API any more. All
  configuration is JMAP `x:<Object>/get|set|query` on `/jmap/` with capability
  `urn:stalwart:jmap`, authenticated as `STALWART_RECOVERY_ADMIN` (works in
  normal mode too). A fresh engine exposes only a setup port (8080, all
  interfaces) in recovery mode; `install.sh` firewalls it and runs
  `opensuite mail-setup`. Account id in management equals the JMAP account id.
  Creating an existing account returns `primaryKeyViolation` with the id.
  The browser never talks to it: `/api/mail/jmap` pins `accountId` (the
  person's own, or a group's they belong to) and allows mail methods only
  (`server/mail.go`, tested).
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
- Deploy: `OS_OPERATORS=ada@demo.opensuite.online OS_SIGNUP=open OS_MAIL_RELAY=file:/etc/opensuite/mail-relay OS_DEMO=file:/etc/opensuite/demo deploy/deploy.sh root@95.217.109.206 office.demo.opensuite.online file:/etc/opensuite/acme-email demo.opensuite.online`
  The settings are rewritten on every deploy, so pass all of them each time.
  `/etc/opensuite/demo` names "Analytical Engines" (`j7axt4urdx`) and the
  two demo passwords. The box also has an `opensuite-demo-reset` timer: that
  is the old k3s stack's, not ours; leave it alone.
- Mail there is `@demo.opensuite.online` (the old stack's domain, whose MX,
  SPF, DKIM and DMARC already exist for Brevo). Outbound goes through Brevo
  (free plan, about 300 a day) with the login in `/etc/opensuite/mail-relay`,
  copied from the old stack's `mb-messages/messages-mta-out-relay` secret.
  Inbound port 25 reaches this engine because the old stack's
  `messages-mta-in` and `messages-mta-out` are scaled to 0; a helmfile
  re-apply of the old stack scales them back up and takes port 25 again.
- Sign-up there is open, because the landing page sends the public there.
  That is safe only because free organisations cannot mail other providers
  (`recipientsAllowed` in `server/mail.go`); the demo's own organisation is on
  the team plan. Keep that check before anything else that sends mail.
- Test accounts: `ada` (owner and operator) and `grace.hopper`; passwords are
  in the handover notes, not in the repo. `opensuite move-address <old> <new>`
  moved them from `@office.demo.opensuite.online`.
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
- Every stylesheet ends up loaded in the same page, so a bare class is
  global. Three screens built separately each styled `.day`, `.pick` or
  `.now` and broke one another. Prefix a screen's classes (`tg-`, `sl-`,
  `ev-`, `ct-`) and keep bare names for the shared kit in `style.css`.
- The server does not list what is inside a trashed folder; the device keeps
  its copy out of sight (`refreshFiles`) so a restore shows it at once.
- The test browser loses its GPU after running for days (everything falls
  back to software and WebGL is off; `chrome://gpu` or a `getContext('webgl2')`
  that returns null shows it). Backgrounds cannot be checked until it is
  restarted: `launchctl kickstart -k gui/<uid>/co.ritza.agent-browser`, when
  no other tabs are open in it.
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
