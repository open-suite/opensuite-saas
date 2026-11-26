// End-to-end check of the public API and the MCP server against a live Open
// Suite, without a browser: it signs in once (as the app would) to make a
// token, then drives every area of the API with that token, and connects a
// real MCP client (the official TypeScript SDK) both with an API token and
// through the whole OAuth flow (discovery, registration, consent, PKCE),
// approving the connection with the signed-in session the way a person
// would on the consent screen. Everything it makes it removes again. Mail
// only ever goes to the signed-in member's own address.
//
//   OS_BASE=https://office.example OS_E2E_USER=ada OS_E2E_PASS=... \
//   MCP_SDK=/path/to/node_modules/@modelcontextprotocol/sdk node tests/e2e-api.cjs [step ...]
//
// Steps: tokens docs sheets slides files meet mail calendar contacts chat search mcp
// (default: all). Chat is skipped when the server has no chat engine (a
// development machine); everything else must pass.
const assert = require('assert')
const path = require('path')

const BASE = (process.env.OS_BASE || 'https://office.demo.opensuite.online').replace(/\/$/, '')
const USER = process.env.OS_E2E_USER
const PASS = process.env.OS_E2E_PASS
const SDK = process.env.MCP_SDK || '@modelcontextprotocol/sdk'
if (!USER || !PASS) throw new Error('set OS_E2E_USER and OS_E2E_PASS')
const steps = process.argv.slice(2)
const want = (s) => !steps.length || steps.includes(s)
const ok = (msg) => console.log('  ok  ' + msg)
const stamp = Date.now().toString(36)
const cleanup = [] // [method, path] to undo what the run made

let cookie = ''
async function session(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const set = res.headers.getSetCookie?.() || []
  for (const c of set) if (c.startsWith('os_s=')) cookie = c.split(';')[0]
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`)
  return json
}

let TOKEN = ''
// api calls the public API with the token; raw bodies pass through as is.
async function api(method, p, body, { token = TOKEN, raw, type, expect = 200, bytes = false } = {}) {
  const headers = { Authorization: 'Bearer ' + token }
  let payload
  if (raw !== undefined) {
    payload = raw
    headers['Content-Type'] = type || 'application/octet-stream'
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(BASE + p, { method, headers, body: payload })
  if (res.status !== expect) throw new Error(`${method} ${p}: ${res.status}, want ${expect}: ${(await res.text()).slice(0, 400)}`)
  if (bytes) return Buffer.from(await res.arrayBuffer())
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const until = async (what, fn, ms = 45000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await new Promise((r) => setTimeout(r, 1500))
  }
}

const zip = (buf) => buf.subarray(0, 2).toString() === 'PK'

;(async () => {
  await session('POST', '/api/login', { email: USER, password: PASS })
  const me0 = await session('GET', '/api/boot')
  const tok = await session('POST', '/api/v1/tokens', { name: 'e2e ' + stamp, expiresInDays: 1 })
  TOKEN = tok.secret
  cleanup.push(['SESSION-DELETE', '/api/v1/tokens/' + tok.id])
  const me = await api('GET', '/api/v1/me')
  assert.equal(me.user.email, me0.user.email)
  const ADDR = me.user.email
  ok(`token acts as ${ADDR} (${me.org.name}, ${me.org.plan} plan)`)

  try {
    if (want('tokens')) {
      const ro = await api('POST', '/api/v1/tokens', { name: 'e2e read-only ' + stamp, readOnly: true, expiresInDays: 1 })
      cleanup.push(['DELETE', '/api/v1/tokens/' + ro.id])
      await api('GET', '/api/v1/documents', undefined, { token: ro.secret })
      const refused = await api('POST', '/api/v1/meetings', {}, { token: ro.secret, expect: 403 })
      assert.match(refused.error, /only read/)
      await api('GET', '/api/v1/me', undefined, { token: 'os_not-a-token', expect: 401 })
      const missing = await api('GET', '/api/v1/documents/nosuchdocument', undefined, { expect: 404 })
      assert.ok(missing.error)
      const spec = await api('GET', '/api/v1/openapi.json')
      assert.equal(spec.openapi, '3.1.0')
      ok(`read-only token refused a write; errors are JSON; OpenAPI lists ${Object.keys(spec.paths).length} paths`)
    }

    let docId
    if (want('docs')) {
      const doc = await api('POST', '/api/v1/documents', { kind: 'doc', title: 'API check ' + stamp, content: '# Plan ' + stamp + '\n\nFirst paragraph with **bold** text.\n\n- one\n- two\n' })
      docId = doc.id
      cleanup.push(['DELETE', '/api/v1/documents/' + doc.id])
      let text = await api('GET', `/api/v1/documents/${doc.id}/text`)
      assert.match(text.content, new RegExp('# Plan ' + stamp))
      assert.match(text.content, /\*\*bold\*\*/)

      // A live editor connected to the document sees the API's edit arrive.
      const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/docs/${doc.id}/sync`, { headers: { Cookie: cookie } })
      ws.binaryType = 'arraybuffer'
      const frames = []
      ws.onmessage = (e) => frames.push(new Uint8Array(e.data))
      await until('the live connection', () => frames.some((f) => f[0] === 4), 15000)
      await api('PUT', `/api/v1/documents/${doc.id}/text`, { content: 'Added by the API.', mode: 'append' })
      await until('the edit to reach the live editor', () => frames.some((f) => f[0] === 1), 15000)
      ws.close()
      text = await api('GET', `/api/v1/documents/${doc.id}/text?format=text`)
      assert.match(text.content, /First paragraph[\s\S]*Added by the API\./)
      ok('document: created from Markdown, read back, appended to while a live editor watched')

      const thread = await api('POST', `/api/v1/documents/${doc.id}/comments`, { quote: 'First paragraph', text: 'Is this right?' })
      await api('POST', `/api/v1/documents/${doc.id}/comments/${thread.id}/replies`, { text: 'Yes.' })
      await api('PATCH', `/api/v1/documents/${doc.id}/comments/${thread.id}`, { resolved: true })
      const comments = await api('GET', `/api/v1/documents/${doc.id}/comments`)
      const t = comments.items.find((x) => x.id === thread.id)
      assert.equal(t.quote, 'First paragraph')
      assert.equal(t.replies.length, 1)
      assert.ok(t.resolved)
      ok('document: comment anchored, replied to, resolved')

      const v = await api('POST', `/api/v1/documents/${doc.id}/versions`, { name: 'Before rewrite' })
      await api('PUT', `/api/v1/documents/${doc.id}/text`, { content: 'Completely new text.', format: 'text' })
      const past = await api('GET', `/api/v1/documents/${doc.id}/versions/${v.id}/content`)
      assert.match(past.content, /Added by the API/)
      await api('POST', `/api/v1/documents/${doc.id}/versions/${v.id}/restore`)
      text = await api('GET', `/api/v1/documents/${doc.id}/text?format=text`)
      assert.match(text.content, /Added by the API/)
      assert.doesNotMatch(text.content, /Completely new text/)
      const versions = await api('GET', `/api/v1/documents/${doc.id}/versions`)
      assert.ok(versions.items.some((x) => x.name === 'Before rewrite'))
      ok('document: named version, rewritten, past version read, restored')

      const docx = await api('GET', `/api/v1/documents/${doc.id}/export?format=docx`, undefined, { bytes: true })
      assert.ok(zip(docx), 'docx is a zip')
      const md = (await api('GET', `/api/v1/documents/${doc.id}/export?format=md`, undefined, { bytes: true })).toString()
      assert.match(md, /Plan/)
      const imported = await api('POST', `/api/v1/documents/import?name=${encodeURIComponent('Imported ' + stamp + '.docx')}`, undefined, { raw: docx })
      cleanup.push(['DELETE', '/api/v1/documents/' + imported.id])
      assert.equal(imported.kind, 'doc')
      assert.match((await api('GET', `/api/v1/documents/${imported.id}/text`)).content, /Plan/)
      ok('document: exported as Word and Markdown, Word file imported back')
    }

    if (want('sheets')) {
      const sheet = await api('POST', '/api/v1/documents', { kind: 'sheet', title: 'API budget ' + stamp, content: 'Item,Cost\nTea,3\nCake,4\n' })
      cleanup.push(['DELETE', '/api/v1/documents/' + sheet.id])
      await api('PUT', `/api/v1/documents/${sheet.id}/cells`, { start: 'A4', values: [['Total', '=SUM(B2:B3)']] })
      let cells = await api('GET', `/api/v1/documents/${sheet.id}/cells`)
      assert.deepEqual(cells.values[3], ['Total', '7'])
      assert.equal(cells.formulas[3][1], '=SUM(B2:B3)')
      await api('PUT', `/api/v1/documents/${sheet.id}/cells`, { start: 'B2', values: [[10]] })
      cells = await api('GET', `/api/v1/documents/${sheet.id}/cells?range=B4`)
      assert.equal(cells.values[0][0], '14')
      await api('POST', `/api/v1/documents/${sheet.id}/sheets`, { name: 'Notes' })
      cells = await api('GET', `/api/v1/documents/${sheet.id}/cells`)
      assert.ok(cells.sheets.some((s) => s.name === 'Notes'))
      const xlsx = await api('GET', `/api/v1/documents/${sheet.id}/export?format=xlsx`, undefined, { bytes: true })
      assert.ok(zip(xlsx))
      const back = await api('POST', `/api/v1/documents/import?name=Budget-${stamp}.xlsx`, undefined, { raw: xlsx })
      cleanup.push(['DELETE', '/api/v1/documents/' + back.id])
      assert.equal((await api('GET', `/api/v1/documents/${back.id}/cells?range=B4`)).values[0][0], '14')
      ok('spreadsheet: from CSV, formula recalculated after an edit, sheet added, Excel out and back in')
    }

    if (want('slides')) {
      const deck = await api('POST', '/api/v1/documents', { kind: 'slides', title: 'API deck ' + stamp, slides: [{ op: 'addSlide', layout: 'title', title: 'Quarterly review', body: 'Made by an agent' }] })
      cleanup.push(['DELETE', '/api/v1/documents/' + deck.id])
      await api('POST', `/api/v1/documents/${deck.id}/slides`, { ops: [{ op: 'addSlide', title: 'Numbers', body: '- Revenue up\n- Costs down', notes: 'Speak slowly' }] })
      let read = await api('GET', `/api/v1/documents/${deck.id}/slides`)
      const last = read.slides[read.slides.length - 1]
      assert.equal(last.notes, 'Speak slowly')
      const box = last.elements.find((e) => /Revenue/.test(e.text || ''))
      assert.ok(box, 'bullets are in a box')
      await api('POST', `/api/v1/documents/${deck.id}/slides`, { ops: [{ op: 'setText', slide: last.id, element: box.id, text: 'Revenue up 12%' }, { op: 'moveSlide', slide: last.id, position: 1 }] })
      read = await api('GET', `/api/v1/documents/${deck.id}/slides`)
      assert.equal(read.slides[0].id, last.id)
      assert.ok(read.slides[0].elements.some((e) => e.text === 'Revenue up 12%'))
      const pptx = await api('GET', `/api/v1/documents/${deck.id}/export?format=pptx`, undefined, { bytes: true })
      assert.ok(zip(pptx))
      const back = await api('POST', `/api/v1/documents/import?name=Deck-${stamp}.pptx`, undefined, { raw: pptx })
      cleanup.push(['DELETE', '/api/v1/documents/' + back.id])
      const again = await api('GET', `/api/v1/documents/${back.id}/slides`)
      assert.ok(JSON.stringify(again).includes('Revenue up 12%'))
      ok(`presentation: ${read.slides.length} slides made, text replaced, slide moved, PowerPoint out and back in`)
    }

    let fileId
    if (want('files')) {
      const folder = await api('POST', '/api/v1/files/folders', { name: 'API folder ' + stamp })
      cleanup.push(['DELETE', '/api/v1/files/' + folder.id])
      const file = await api('POST', `/api/v1/files?name=notes-${stamp}.txt&folder=${folder.id}`, undefined, { raw: 'hello from the API ' + stamp, type: 'text/plain' })
      fileId = file.id
      const list = await api('GET', '/api/v1/files?folder=' + folder.id)
      assert.deepEqual(list.items.map((n) => n.id), [file.id])
      assert.equal((await api('GET', `/api/v1/files/${file.id}/content`, undefined, { bytes: true })).toString(), 'hello from the API ' + stamp)
      const linked = await api('PATCH', '/api/v1/files/' + file.id, { link: true })
      const pub = await fetch(linked.publicUrl.replace('/f/', '/api/public/'))
      assert.equal(pub.status, 200)
      await api('PATCH', '/api/v1/files/' + file.id, { link: false, trashed: true })
      assert.ok((await api('GET', '/api/v1/files?trashed=true')).items.some((n) => n.id === file.id))
      await api('PATCH', '/api/v1/files/' + file.id, { trashed: false })
      ok('files: folder, upload, list, download, public link on and off, trash and back')
    }

    if (want('meet')) {
      const m = await api('POST', '/api/v1/meetings', { title: 'API meeting ' + stamp })
      cleanup.push(['DELETE', '/api/v1/meetings/' + m.code])
      assert.ok((await api('GET', '/api/v1/meetings')).items.some((x) => x.code === m.code && x.url === m.url))
      const info = await fetch(`${BASE}/api/meet/${m.code}`).then((r) => r.json())
      assert.equal(info.title, 'API meeting ' + stamp)
      ok('meetings: room created with a link guests can open')
    }

    if (want('mail')) {
      const boxes = await api('GET', '/api/v1/mail/mailboxes')
      assert.ok(boxes.items.some((b) => b.role === 'inbox'))
      const att = await api('POST', '/api/v1/mail/attachments', undefined, { raw: 'attached ' + stamp, type: 'text/plain' })
      const subject = 'API mail ' + stamp
      await api('POST', '/api/v1/mail/send', { to: [ADDR], subject, text: 'Sent through the API.', attachments: [{ blobId: att.blobId, name: 'a.txt', type: 'text/plain' }, ...(fileId ? [{ fileId }] : [])] })
      const got = await until('the message to arrive', async () => (await api('GET', '/api/v1/mail/messages?mailbox=inbox&q=' + encodeURIComponent(stamp))).items.find((m) => m.subject === subject))
      const full = await api('GET', '/api/v1/mail/messages/' + got.id)
      assert.match(full.text, /Sent through the API/)
      assert.equal(full.attachments.length, fileId ? 2 : 1)
      const dl = await api('GET', `/api/v1/mail/attachments/${full.attachments[0].blobId}?name=a.txt`, undefined, { bytes: true })
      assert.equal(dl.toString(), 'attached ' + stamp)
      const saved = await api('POST', `/api/v1/mail/attachments/${full.attachments[0].blobId}/save`, { name: 'from-mail-' + stamp + '.txt', type: 'text/plain' })
      cleanup.push(['DELETE', '/api/v1/files/' + saved.id])
      await api('POST', `/api/v1/mail/messages/${got.id}/reply`, { text: 'A reply.' })
      await api('POST', `/api/v1/mail/messages/${got.id}/forward`, { to: [ADDR], text: 'Have a look.' })
      await until('the reply and forward', async () => {
        const list = (await api('GET', '/api/v1/mail/messages?q=' + encodeURIComponent(stamp))).items
        return list.some((m) => m.subject === 'Re: ' + subject) && list.some((m) => m.subject === 'Fwd: ' + subject)
      })
      const thread = await api('GET', '/api/v1/mail/threads/' + full.threadId)
      assert.ok(thread.messages.length >= 2, 'the reply joined the conversation')
      await api('PATCH', '/api/v1/mail/messages/' + got.id, { flagged: true, unread: false, mailbox: 'archive' })
      const archived = await api('GET', '/api/v1/mail/messages/' + got.id)
      assert.ok(archived.flagged && !archived.unread)
      const draft = await api('POST', '/api/v1/mail/drafts', { to: [ADDR], subject: 'Draft ' + stamp, text: 'first' })
      const draft2 = await api('PUT', '/api/v1/mail/drafts/' + draft.id, { to: [ADDR], subject: 'Draft ' + stamp, text: 'second' })
      await api('GET', '/api/v1/mail/messages/' + draft.id, undefined, { expect: 404 })
      await api('POST', `/api/v1/mail/drafts/${draft2.id}/send`)
      await until('the sent draft', async () => (await api('GET', '/api/v1/mail/messages?mailbox=inbox&q=' + encodeURIComponent('Draft ' + stamp))).items.length > 0)
      for (const m of (await api('GET', '/api/v1/mail/messages?q=' + encodeURIComponent(stamp) + '&limit=50')).items) {
        await api('DELETE', `/api/v1/mail/messages/${m.id}?permanent=true`)
      }
      ok('mail: sent with attachments (one from Files), read, attachment downloaded and filed, replied, forwarded, flagged, archived, draft saved, replaced and sent')
    }

    if (want('calendar')) {
      const cals = await api('GET', '/api/v1/calendars')
      assert.ok(cals.items.length > 0)
      const start = new Date(Date.now() + 3 * 86400000)
      start.setUTCHours(9, 0, 0, 0)
      const ev = await api('POST', '/api/v1/calendar/events', { title: 'API event ' + stamp, start: start.toISOString().replace('.000', ''), duration: 'PT45M', timeZone: 'Europe/Berlin', meeting: true, location: 'Room 1' })
      cleanup.push(['DELETE', '/api/v1/calendar/events/' + ev.id])
      assert.ok(ev.meetingUrl && /\/meet\//.test(ev.meetingUrl))
      assert.equal(new Date(ev.startsAt).getTime(), start.getTime())
      const occ = await api('GET', `/api/v1/calendar/events?from=${new Date(start - 3600000).toISOString()}&to=${new Date(+start + 7200000).toISOString()}`)
      assert.ok(occ.items.some((o) => o.eventId === ev.id))
      const weekly = await api('POST', '/api/v1/calendar/events', { title: 'API weekly ' + stamp, start: start.toISOString(), duration: 'PT30M', repeat: { frequency: 'weekly', count: 3 } })
      cleanup.push(['DELETE', '/api/v1/calendar/events/' + weekly.id])
      const three = await api('GET', `/api/v1/calendar/events?from=${new Date(start - 3600000).toISOString()}&to=${new Date(+start + 30 * 86400000).toISOString()}&q=weekly`)
      assert.equal(three.items.filter((o) => o.eventId === weekly.id).length, 3)
      const moved = await api('PATCH', '/api/v1/calendar/events/' + ev.id, { end: new Date(+start + 3600000).toISOString(), title: 'API event (moved) ' + stamp })
      assert.equal(moved.duration, 'PT1H')
      const busy = await api('POST', '/api/v1/calendar/freebusy', { people: [ADDR], from: new Date(start - 3600000).toISOString(), to: new Date(+start + 7200000).toISOString() })
      assert.ok(Object.values(busy.busy)[0]?.length > 0, 'busy while the event is on')
      ok('calendar: event with a meeting link, repeating event unrolled, event changed, free/busy')
    }

    if (want('contacts')) {
      const c = await api('POST', '/api/v1/contacts', { givenName: 'Ada', surname: 'Tester ' + stamp, emails: ['ada.tester@example.org'], company: 'Engines Ltd' })
      cleanup.push(['DELETE', '/api/v1/contacts/' + c.id])
      assert.equal(c.fullName, 'Ada Tester ' + stamp)
      const found = await api('GET', '/api/v1/contacts?q=' + stamp)
      assert.equal(found.items.length, 1)
      const changed = await api('PATCH', '/api/v1/contacts/' + c.id, { jobTitle: 'Analyst', phones: ['+44 20 7946 0000'] })
      assert.equal(changed.jobTitle, 'Analyst')
      assert.deepEqual(changed.emails, ['ada.tester@example.org'])
      ok('contacts: added, found, changed')
    }

    if (want('chat')) {
      const res = await fetch(BASE + '/api/v1/chat/rooms', { headers: { Authorization: 'Bearer ' + TOKEN } })
      if (res.status === 503) {
        ok('chat: skipped, this server has no chat engine')
      } else {
        assert.equal(res.status, 200)
        const people = await api('GET', '/api/v1/people')
        const other = people.items.find((p) => p.email !== ADDR && p.status === 'active')
        assert.ok(other, 'a colleague to chat with')
        const room = await api('POST', '/api/v1/chat/rooms', { people: [other.email] })
        assert.ok(room.direct)
        const again = await api('POST', '/api/v1/chat/rooms', { people: [other.id] })
        assert.equal(again.id, room.id, 'the direct conversation is reused')
        await api('POST', `/api/v1/chat/rooms/${room.id}/messages`, { text: 'Hello from the API ' + stamp })
        await api('POST', `/api/v1/chat/rooms/${room.id}/files?name=chat-${stamp}.txt`, undefined, { raw: 'chat file ' + stamp, type: 'text/plain' })
        const msgs = await api('GET', `/api/v1/chat/rooms/${room.id}/messages?limit=10`)
        assert.ok(msgs.items.some((m) => m.text === 'Hello from the API ' + stamp))
        const file = msgs.items.find((m) => m.file?.name === `chat-${stamp}.txt`)
        assert.ok(file)
        assert.equal((await api('GET', file.file.url, undefined, { bytes: true })).toString(), 'chat file ' + stamp)
        assert.ok((await api('GET', '/api/v1/chat/rooms')).items.some((r) => r.id === room.id))
        ok(`chat: direct conversation with ${other.name}, message and file sent and read back`)
      }
    }

    if (want('search') && docId) {
      const found = await until('the search index', async () => {
        const r = await api('GET', '/api/v1/search?q=' + encodeURIComponent('Plan ' + stamp) + '&in=documents')
        return r.documents.some((d) => d.id === docId) && r
      })
      assert.ok(found)
      ok('search: the document is found by its contents')
    }

    if (want('mcp')) await mcp(ADDR)
  } finally {
    for (const [method, p] of cleanup.reverse()) {
      try {
        if (method === 'SESSION-DELETE') await session('DELETE', p)
        else await api(method, p)
      } catch (e) {
        if (!/: 404/.test(e.message)) console.log('  cleanup: ' + e.message)
      }
    }
  }
  console.log('all good')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})

// --- MCP ----------------------------------------------------------------------

async function mcp(ADDR) {
  const { Client } = require(path.join(SDK, 'dist/cjs/client/index.js'))
  const { StreamableHTTPClientTransport } = require(path.join(SDK, 'dist/cjs/client/streamableHttp.js'))
  const { UnauthorizedError } = require(path.join(SDK, 'dist/cjs/client/auth.js'))
  const url = new URL(BASE + '/mcp')

  // With an API token.
  {
    const client = new Client({ name: 'open-suite-e2e', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + TOKEN } } })
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.ok(tools.length > 60, `${tools.length} tools`)
    const me = await client.callTool({ name: 'get_me', arguments: {} })
    assert.equal(me.structuredContent.user.email, ADDR)
    const doc = await client.callTool({ name: 'create_document', arguments: { kind: 'doc', title: 'MCP doc ' + Date.now(), content: 'Written over MCP.' } })
    const id = doc.structuredContent.id
    const read = await client.readResource({ uri: 'opensuite://documents/' + id })
    assert.match(read.contents[0].text, /Written over MCP/)
    const bad = await client.callTool({ name: 'get_document', arguments: { id: 'nosuchdocument' } })
    assert.equal(bad.isError, true)
    await client.callTool({ name: 'delete_document', arguments: { id } })
    await client.close()
    ok(`MCP with a token (protocol ${transport.protocolVersion}): ${tools.length} tools, called, resource read, errors reported as tool errors`)
  }

  // The current revision, stateless: discovery with mirrored headers.
  {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }),
    })
    const out = await res.json()
    assert.equal(out.result.resultType, 'complete')
    assert.ok(out.result.supportedVersions.includes('2026-07-28'))
    ok('MCP 2026-07-28: server/discover answers statelessly')
  }

  // By URL alone, through OAuth: the client discovers the authorization
  // server, registers itself, and sends the person to approve; the approval
  // is given with the signed-in session, as on the consent screen.
  {
    let info, tokens, verifier, approvedCode
    const provider = {
      redirectUrl: 'http://127.0.0.1:53682/callback',
      clientMetadata: { client_name: 'Open Suite e2e', redirect_uris: ['http://127.0.0.1:53682/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      clientInformation: () => info,
      saveClientInformation: (i) => (info = i),
      tokens: () => tokens,
      saveTokens: (t) => (tokens = t),
      saveCodeVerifier: (v) => (verifier = v),
      codeVerifier: () => verifier,
      redirectToAuthorization: async (authUrl) => {
        const q = authUrl.search.slice(1)
        const page = await fetch(authUrl, { headers: { Cookie: cookie } })
        assert.equal(page.status, 200, 'the consent page opens')
        const req = await session('GET', '/api/oauth/request?' + q)
        assert.equal(req.client.name, 'Open Suite e2e')
        const { redirect } = await session('POST', '/api/oauth/approve', { query: q, readOnly: false })
        const back = new URL(redirect)
        assert.equal(back.searchParams.get('iss'), BASE)
        approvedCode = back.searchParams.get('code')
      },
    }
    const client = new Client({ name: 'open-suite-e2e-oauth', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider })
    try {
      await client.connect(transport)
      throw new Error('connected without signing in')
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e
    }
    await transport.finishAuth(approvedCode)
    const client2 = new Client({ name: 'open-suite-e2e-oauth', version: '1.0.0' })
    await client2.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))
    const r = await client2.callTool({ name: 'search', arguments: { q: 'a', in: 'people' } })
    assert.equal(r.isError, false)
    await client2.close()
    const conns = await session('GET', '/api/v1/tokens')
    const conn = conns.items.find((t) => t.kind === 'connection' && t.name === 'Open Suite e2e')
    assert.ok(conn, 'the connection is listed with the tokens')
    await session('DELETE', '/api/v1/tokens/' + conn.id)
    const after = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })
    assert.equal(after.status, 401)
    ok('MCP by URL alone: OAuth discovery, client registration, consent, PKCE, tool call, connection listed and revoked')
  }
}
