// End-to-end check of Files against a live Open Suite: folders, uploads,
// previews, sharing with a colleague, a public link for a guest, and the two
// mail hand-offs. Fails on any console error or failed request.
//
//   OS_BASE=http://files.localhost:8612 OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-files.cjs
//
// OS_E2E_NO_CHAT=1 ignores chat failures (a local run has no chat engine);
// OS_E2E_SHOTS=<dir> saves a screenshot of every screen along the way.
const fs = require('fs')
const path = require('path')
const { connect, login, collect, BASE } = require('./browser.cjs')

const { state, save } = require('./browser.cjs').remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
const SHOTS = process.env.OS_E2E_SHOTS
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')

// A real picture, made here: a 320x200 gradient.
const png = (() => {
  const zlib = require('zlib')
  const w = 320, h = 200
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set([255 - Math.floor((x / w) * 200), 90 + Math.floor((y / h) * 120), 31 + Math.floor((x / w) * 200)], y * (w * 3 + 1) + 1 + x * 3)
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(zlib.crc32(body), body.length + 4)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
})()
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Quarterly report) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const files = [
  { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Launch notes\n\nShip on **Friday**.\n\n- [x] Budget\n- [ ] Press kit\n\n<script>window.__pwned = 1</script>\n') },
  { name: 'photo.png', mimeType: 'image/png', buffer: png },
  { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf },
  { name: 'figures.csv', mimeType: 'text/csv', buffer: Buffer.from('Item,Cost\nLaptops,4200\nChairs,1350\n') },
  { name: 'evil.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><title>x</title><script>window.__pwned = 1; document.title = "pwned"</script><h1>hello</h1>') },
]

;(async () => {
  const b = await connect()
  const problems = []
  const ok = (msg) => console.log('  ok  ' + msg)
  let n = 0
  const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`) })
  const quiet = (list) => (process.env.OS_E2E_NO_CHAT ? list.filter((p) => !/_matrix|\/api\/chat|\/lk\//.test(p) && !/console: Failed to load resource/.test(p)) : list)
  const row = (name) => `.drive-row:has(.name:text-is("${name}"))`
  const menu = async (page, name, item) => {
    await page.click(`${row(name)} [aria-label="More"]`)
    await page.click(`${row(name)} .menu >> text=${item}`)
  }
  let A
  try {
    // Start from a clean drive so a run that stopped half way can be repeated.
    const sweep = await b.open()
    await login(sweep, ADMIN.user, ADMIN.pass)
    await sweep.evaluate(async () => {
      const { nodes } = await (await fetch('/api/files')).json()
      for (const n of nodes.filter((x) => x.role === 'owner' && /^(Project X|launch-notes\.md|photo\.png)$/.test(x.name))) await fetch('/api/files/' + n.id, { method: 'DELETE' })
    })
    await sweep.close()

    A = await b.open()
    const B = await b.open()
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await login(A, ADMIN.user, ADMIN.pass)

    if (!state.colleague) {
      await A.click('a[href="/admin"]')
      await A.click('text=Add person')
      await A.fill('.modal input.input', 'Grace Hopper')
      await A.click('.modal >> text=Add person')
      await A.waitForSelector('text=Person added')
      const lines = await A.$$eval('.modal .card div', (els) => els.map((e) => e.textContent))
      state.colleague = { user: lines[0], temp: lines[1] }
      save()
      await A.click('.modal >> text=Done')
    }
    await login(B, state.colleague.user, state.colleague.changed ? COLLEAGUE_PASS : state.colleague.temp)
    if (await B.$('input[autocomplete=new-password]')) {
      await B.fill('input[autocomplete=new-password]', COLLEAGUE_PASS)
      await B.click('button[type=submit]')
      await B.waitForSelector('.rail')
      state.colleague.changed = true
      save()
    }
    ok('administrator and colleague signed in')

    // --- folders and uploads ---
    await A.click('a[href="/files"]')
    await A.waitForSelector('.page-head')
    await A.click('.page-head button:has-text("New")')
    await A.click('.menu >> text=New folder')
    await A.fill('.modal input.input', 'Project X')
    await A.click('.modal >> text=Create')
    await A.waitForSelector(row('Project X'))
    await shot(A, 'my-files')
    await A.click(row('Project X'))
    await A.waitForSelector('.crumbs >> text=Project X')
    await A.waitForSelector('text=This folder is empty')
    await shot(A, 'empty-folder')
    await A.setInputFiles('input[type=file][multiple]', files)
    for (const f of files) await A.waitForSelector(row(f.name))
    await A.waitForFunction(() => !document.querySelector('.upl'), null, { timeout: 15000 })
    const folderUrl = A.url()
    ok('folder created, five files uploaded')
    await shot(A, 'folder-list')

    // --- previews ---
    await A.click(row('photo.png'))
    await A.waitForFunction(() => document.querySelector('.preview-stage img')?.naturalWidth > 0)
    await shot(A, 'preview-image')
    const first = await A.textContent('.preview-bar .name')
    await A.keyboard.press('ArrowRight')
    await A.waitForFunction((was) => document.querySelector('.preview-bar .name')?.textContent !== was, first)
    await A.keyboard.press('Escape')
    await A.waitForSelector('.preview', { state: 'detached' })
    await A.click(row('report.pdf'))
    await A.waitForSelector('.preview iframe.preview-frame[src*="/content"]')
    await A.waitForTimeout(1200)
    await shot(A, 'preview-pdf')
    await A.keyboard.press('Escape')
    await A.waitForSelector('.preview', { state: 'detached' })
    await A.click(row('notes.md'))
    const md = A.frameLocator('.preview iframe')
    await md.locator('h1:text("Launch notes")').waitFor()
    if ((await md.locator('strong').innerText()) !== 'Friday') throw new Error('markdown not rendered')
    if (await md.locator('script').count()) throw new Error('markdown preview kept a script element')
    await shot(A, 'preview-markdown')
    await A.keyboard.press('Escape')
    await A.click(row('evil.html'))
    await A.waitForFunction(() => document.querySelector('.preview-text')?.textContent.includes('<script>'))
    if (await A.evaluate(() => window.__pwned)) throw new Error('an uploaded page ran script in the app')
    await shot(A, 'preview-text')
    await A.keyboard.press('Escape')
    ok('previews: image, PDF, Markdown and text; an uploaded page shows as text')

    // Opened directly, an uploaded page is still only text.
    const evilId = await A.evaluate(async () => (await (await fetch('/api/files')).json()).nodes.find((x) => x.name === 'evil.html').id)
    const direct = await A.evaluate(async (id) => {
      const res = await fetch(`/api/files/${id}/content`)
      return { type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), sniff: res.headers.get('x-content-type-options') }
    }, evilId)
    if (!direct.type.startsWith('text/plain') || !direct.csp.startsWith('sandbox') || direct.sniff !== 'nosniff') throw new Error('unsafe headers on an uploaded page: ' + JSON.stringify(direct))
    await A.goto(`${BASE}/api/files/${evilId}/content`)
    if ((await A.evaluate(() => document.contentType)) !== 'text/plain' || (await A.title()) === 'pwned') throw new Error('an uploaded page was rendered as a page')
    await A.goto(folderUrl)
    await A.waitForSelector(row('evil.html'))
    ok('an uploaded page opened directly is plain text with a sandbox policy')

    // --- rename, keyboard, move ---
    await menu(A, 'notes.md', 'Rename')
    await A.fill('.modal input.input', 'launch-notes.md')
    await A.keyboard.press('Enter')
    await A.waitForSelector(row('launch-notes.md'))
    await A.focus(row('photo.png'))
    await A.keyboard.press('Space')
    await A.waitForSelector('.selbar >> text=1 selected')
    await A.keyboard.press('Shift+ArrowDown')
    await A.waitForSelector('.selbar >> text=2 selected')
    await shot(A, 'selection')
    await A.keyboard.press('Escape')
    await A.waitForSelector('.selbar', { state: 'detached' })
    await menu(A, 'photo.png', 'Move to')
    await A.waitForSelector('.modal .browser')
    await shot(A, 'move-dialog')
    await A.click('.modal >> text=Move to My files')
    await A.waitForSelector(row('photo.png'), { state: 'detached' })
    await A.click('.crumbs a:has-text("Files")')
    await A.waitForSelector(row('photo.png'))
    // Drag it back into the folder.
    await A.dragAndDrop(row('photo.png'), row('Project X'))
    await A.waitForSelector(row('photo.png'), { state: 'detached' })
    await A.click(row('Project X'))
    await A.waitForSelector(row('photo.png'))
    ok('rename, keyboard selection, move by dialog and by drag')

    // --- a document lives in the folder too ---
    await A.click('.page-head button:has-text("New")')
    await A.click('.menu >> text=New document')
    await A.waitForSelector('.paper')
    const docId = A.url().split('/').pop()
    await A.fill('.doc-title', 'Plan of record')
    await A.click('.paper')
    await A.keyboard.type('Filed in Project X.')
    await A.waitForTimeout(700)
    await A.goto(folderUrl)
    await A.waitForSelector(`a.list-row[href="/d/${docId}"] >> text=Plan of record`)
    ok('a new document is filed in the folder it was created in')

    // --- open a CSV as a spreadsheet ---
    await A.click(row('figures.csv'))
    await A.click('.preview-bar >> text=Open as spreadsheet')
    await A.waitForSelector('.toolbar .select', { timeout: 15000 })
    const sheetId = A.url().split('/').pop()
    await A.waitForFunction(() => document.querySelector('.doc-title')?.value === 'figures')
    await A.goto(folderUrl)
    await A.waitForSelector(`a.list-row[href="/s/${sheetId}"]`)
    ok('a CSV file opens as a spreadsheet in the same folder')

    // --- grid view ---
    await A.click('[aria-label="Grid"]')
    await A.waitForFunction(() => document.querySelector('.ftile-art img')?.naturalWidth > 0)
    await shot(A, 'folder-grid')
    await A.click('[aria-label="List"]')

    // --- sharing with a colleague ---
    await A.click('[aria-label="Share this folder"]')
    await A.click('.modal >> text=Everyone at')
    await shot(A, 'share-dialog')
    await A.click('.modal >> text=Create a public link')
    await A.waitForSelector('.modal input[aria-label="Public link"]')
    const publicUrl = await A.inputValue('.modal input[aria-label="Public link"]')
    await shot(A, 'share-dialog-link')
    await A.click('.modal >> text=Done')
    await B.click('a[href="/files"]')
    await B.click('.drive-place:has-text("Shared with me")')
    await B.waitForSelector(row('Project X'), { timeout: 8000 })
    await shot(B, 'shared-with-me')
    await B.click(row('Project X'))
    await B.waitForSelector(row('launch-notes.md'))
    await B.waitForSelector(`a.list-row[href="/d/${docId}"]`)
    await B.setInputFiles('input[type=file][multiple]', [{ name: 'from-grace.txt', mimeType: 'text/plain', buffer: Buffer.from('Added by the colleague.') }])
    await B.waitForSelector(row('from-grace.txt'))
    await B.waitForFunction(() => !document.querySelector('.upl'))
    await B.click(`a.list-row[href="/d/${docId}"]`)
    await B.waitForFunction(() => document.querySelector('.paper')?.textContent.includes('Filed in Project X'), null, { timeout: 8000 })
    await A.goto(folderUrl)
    await A.waitForSelector(row('from-grace.txt'))
    ok('colleague opens the shared folder, the document in it, and adds a file the owner sees')

    // --- public link, no account ---
    const G = await b.open()
    collect(G, 'guest', problems)
    await G.goto(publicUrl)
    await G.waitForSelector('.public .list-row >> text=launch-notes.md')
    await shot(G, 'public-folder')
    await G.click('.public .list-row >> text=photo.png')
    await G.waitForFunction(() => document.querySelector('.preview-stage img')?.naturalWidth > 0)
    if (!(await G.getAttribute('.public-bar a[download]', 'href')).includes('/api/public/')) throw new Error('no download on the public page')
    await shot(G, 'public-file')
    const leak = await G.evaluate(async () => (await fetch('/api/files')).status)
    if (leak !== 401) throw new Error('a guest reached the drive API: ' + leak)
    problems.splice(0, problems.length, ...problems.filter((p) => !(p.startsWith('guest') && /401|\/api\/files/.test(p))))
    ok('guest opens the public link, previews and can download, and reaches nothing else')
    await A.click('[aria-label="Share this folder"]')
    await A.click('.modal >> text=Switch off')
    await A.waitForSelector('.modal >> text=Create a public link')
    await A.click('.modal >> text=Done')
    const guestProblems = problems.length
    await G.goto(publicUrl)
    await G.waitForSelector("text=This link isn't available")
    await shot(G, 'public-off')
    problems.splice(guestProblems) // the 404 is the point
    ok('switched off, the link stops working')

    // --- mail hand-offs ---
    await A.goto(BASE + '/mail')
    await A.click('text=Compose')
    await A.fill('#c-to', ADMIN.user.includes('@') ? ADMIN.user : await A.evaluate(() => JSON.parse(localStorage.getItem('os:boot')).user.email))
    const subject = 'Files ' + Date.now().toString(36)
    await A.fill('#c-subj', subject)
    await A.click('[aria-label="Attach from Files"]')
    await A.waitForSelector('.modal .browser')
    await A.click('.modal .list-row >> text=Project X')
    await shot(A, 'attach-from-files')
    await A.click('.modal .list-row >> text=launch-notes.md')
    await A.waitForSelector('.modal .list-row.picked')
    await A.click('.modal footer >> text=Attach')
    await A.waitForFunction(() => /launch-notes\.md\s*\d+ B/.test(document.querySelector('.compose .atts')?.textContent || ''), null, { timeout: 10000 })
    await A.click('.compose-body')
    await A.keyboard.type('Notes attached.')
    await A.click('.compose >> text=Send')
    await A.waitForSelector('.compose', { state: 'detached', timeout: 10000 })
    await A.click(`.mrow >> text=${subject}`, { timeout: 15000 })
    await A.click('.msg [aria-label="Save to Files"]')
    await A.waitForSelector('text=Saved "launch-notes.md" to Files')
    await A.click('a[href="/files"]')
    await A.waitForSelector(row('launch-notes.md'))
    ok('mail: attached from Files, received, saved back to Files')

    // --- trash, restore, delete for ever ---
    await menu(A, 'launch-notes.md', 'Move to trash')
    await A.waitForSelector(row('launch-notes.md'), { state: 'detached' })
    await menu(A, 'Project X', 'Move to trash')
    await A.click('.drive-place:has-text("Trash")')
    await A.waitForSelector(row('Project X'))
    await shot(A, 'trash')
    await B.goto(BASE + '/files/shared')
    await B.waitForSelector('.page-head')
    await B.waitForTimeout(800)
    if (await B.$(row('Project X'))) throw new Error('a trashed folder is still shared')
    await menu(A, 'Project X', 'Restore')
    await A.click('.drive-place:has-text("My files")')
    await A.waitForSelector(row('Project X'))
    await A.click(row('Project X'))
    await A.waitForSelector(row('photo.png'))
    await A.click('.drive-place:has-text("Recent")')
    await A.waitForSelector(row('photo.png'))
    await shot(A, 'recent')
    await A.click('.drive-place:has-text("My files")')
    await menu(A, 'Project X', 'Move to trash')
    await A.click('.drive-place:has-text("Trash")')
    await A.click('text=Empty trash')
    await A.click('.modal footer >> text=Delete for ever')
    await A.waitForSelector('text=Trash is empty')
    const left = await A.evaluate(async () => (await (await fetch('/api/files')).json()).nodes.filter((x) => /^(Project X|launch-notes\.md)$/.test(x.name)).length)
    if (left !== 0) throw new Error(left + ' items left after emptying the trash')
    ok('trash hides a folder from everyone, restore brings it back, emptying deletes for ever')

    const found = quiet(problems)
    if (found.length) throw new Error('problems during the run:\n' + found.join('\n'))
    console.log('all good')
  } catch (e) {
    if (SHOTS && A) await A.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {})
    console.error('FAILED: ' + e.message.split('\n').slice(0, 14).join('\n'))
    const found = quiet(problems)
    if (found.length) console.error('problems so far:\n' + found.slice(0, 12).join('\n'))
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
