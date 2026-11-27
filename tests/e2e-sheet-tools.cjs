// End-to-end check of the spreadsheet's menus and data tools against a live
// Open Suite, with two people in the same workbook: the menu bar and its
// search, freezing, sorting (one Undo), a shared filter, a filter view only
// its opener sees, data validation, checkboxes, conditional formatting,
// fonts and wrapping, a pivot table that follows its data, find and replace,
// and an Excel download that keeps the filter and validation. Fails on any
// console error or failed request.
//
//   OS_BASE=... OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-sheet-tools.cjs
//
// Run tests/e2e.cjs once first: it creates the colleague these checks sign in as.
const JSZip = require('../web/node_modules/jszip')
const { connect, login, collect, BASE } = require('./browser.cjs')

const { state } = require('./browser.cjs').remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
if (!state.colleague?.changed) throw new Error('run tests/e2e.cjs first: it creates the colleague')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const cell = (col, row) => ({ x: 46 + 90 * col - 45, y: 24 + 25 * row - 12 }) // centre of a default-size cell
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout })
const shown = (page, r, c) => page.evaluate(([r, c]) => window.__sheet.model.getFormattedCellValue(window.__sheet.sheet, r, c), [r, c])

async function menu(page, top, ...path) {
  await page.click(`.mb-btn:text-is("${top}")`)
  for (let i = 0; i < path.length; i++) {
    const sel = `.menu .menu-item:has(.mb-label:text-is("${path[i]}"))`
    if (i < path.length - 1) await page.hover(sel)
    else await page.click(sel)
  }
}

async function selectRange(page, a, b) {
  await page.click('.grid-scroll', { position: cell(...a) })
  await page.keyboard.down('Shift')
  await page.click('.grid-scroll', { position: cell(...b) })
  await page.keyboard.up('Shift')
}

;(async () => {
  const b = await connect()
  const problems = []
  let created = null
  let cleanup = null
  const pages = {}
  const ok = (msg) => console.log('  ok  ' + msg)
  try {
    const A = (pages.admin = await b.open())
    const B = (pages.colleague = await b.open())
    cleanup = async (id) => {
      await A.goto(BASE + '/')
      await A.evaluate(async (id) => fetch('/api/docs/' + id, { method: 'DELETE' }), id)
      console.log('  ok  cleaned up the test spreadsheet')
    }
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await login(A, ADMIN.user, ADMIN.pass)
    await login(B, state.colleague.user, COLLEAGUE_PASS)
    const rows = ['Region,Rep,Amount,Done', 'North,Ann,10,', 'South,Bob,20,', 'North,Cy,5,', 'East,Di,7,', 'South,Ed,12,']
    const doc = await A.evaluate(async (content) => (await fetch('/api/v1/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'sheet', title: 'E2E sheet tools', content }) })).json(), rows.join('\n'))
    created = doc.id
    await A.evaluate(async (id) => fetch('/api/docs/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access: 'org' }) }), doc.id)
    await A.goto(BASE + '/s/' + doc.id)
    await B.goto(BASE + '/s/' + doc.id)
    await A.waitForSelector('.menubar')
    await B.waitForSelector('.menubar')
    await until(A, () => window.__sheet?.model && window.__sheet.online, null, 20000)
    await until(B, () => window.__sheet?.model && window.__sheet.online && window.__sheet.canEdit, null, 20000)

    // The menu bar: keyboard and search.
    await A.click('.grid-scroll', { position: cell(1, 1) })
    await A.keyboard.press('Alt+/')
    await A.keyboard.type('bold')
    await A.keyboard.press('Enter')
    await until(A, () => window.__sheet.style().font.b)
    if (!(await A.evaluate(() => document.activeElement?.classList.contains('grid-wrap')))) throw new Error('the grid lost focus after a menu search')
    await A.click('.mb-btn:text-is("File")')
    await A.keyboard.press('ArrowRight')
    await A.waitForSelector('.mb-btn.on:text-is("Edit")')
    await A.keyboard.press('Escape')
    ok('menus: search finds and applies Bold, arrows move between menus, the grid keeps focus')

    // Freeze the heading row.
    await menu(A, 'View', 'Freeze', '1 row')
    await until(B, () => window.__sheet.fr === 1)
    ok('freeze: one row frozen, for both people')

    // Sort the data under the heading by Amount, Z to A, then undo it in one step.
    await A.click('.grid-scroll', { position: cell(3, 2) })
    await menu(A, 'Data', 'Sort sheet by column C, Z → A')
    await until(B, () => window.__sheet.model.getFormattedCellValue(0, 2, 3) === '20')
    if ((await shown(A, 1, 1)) !== 'Region') throw new Error('the frozen heading moved when sorting')
    await A.click('.grid-scroll', { position: cell(5, 8) })
    await A.keyboard.press(mod + '+z')
    await until(B, () => window.__sheet.model.getFormattedCellValue(0, 2, 3) === '10')
    ok('sort: rows move under a frozen heading, and one Undo puts them all back')

    // A shared filter hides East for both.
    await A.click('.grid-scroll', { position: cell(1, 2) })
    await A.click('[aria-label="Create a filter"]')
    await until(B, () => !!window.__sheet.filter)
    await A.click('.grid-scroll', { position: { x: 46 + 90 - 10, y: 24 + 12 } })
    await A.waitForSelector('.sp-float')
    await A.click('.sp-float .chart-check:has-text("East") input')
    await A.click('.sp-float button:text-is("OK")')
    await until(B, () => window.__sheet.hidden.has(5))
    ok('filter: the filter and what it hides reach the colleague')

    // A filter view hides North for its opener only.
    await menu(A, 'Data', 'Filter views', 'Create new filter view')
    await A.waitForSelector('.sp-viewbar')
    await A.click('.grid-scroll', { position: { x: 46 + 90 - 10, y: 24 + 12 } })
    await A.waitForSelector('.sp-float')
    await A.click('.sp-float .chart-check:has-text("North") input')
    await A.click('.sp-float button:text-is("OK")')
    await until(A, () => window.__sheet.hidden.has(2) && window.__sheet.hidden.has(4))
    await B.waitForTimeout(800)
    if (await B.evaluate(() => window.__sheet.hidden.has(2))) throw new Error('a filter view changed the colleague’s sheet')
    const viewUrl = A.url()
    if (!/fv=/.test(viewUrl)) throw new Error('the filter view is not in the address')
    await B.goto(viewUrl)
    await until(B, () => window.__sheet?.view && window.__sheet.hidden?.has(2))
    await B.click('[aria-label="Close filter view"]')
    await until(B, () => !window.__sheet.view && !window.__sheet.hidden.has(2))
    await A.click('[aria-label="Close filter view"]')
    ok('filter view: hides rows only for whoever opens it, and its link opens it for the colleague')

    // Data validation: a dropdown refuses other input; checkboxes toggle.
    await selectRange(A, [1, 2], [1, 6])
    await menu(A, 'Data', 'Data validation')
    await A.fill('[aria-label="Items"]', 'North\nSouth\nEast\nWest')
    await A.click('.chart-panel button:text-is("Save rule")')
    await A.click('[aria-label="Close data validation"]')
    await A.click('.grid-scroll', { position: cell(1, 2) })
    await A.keyboard.type('Mars')
    await A.keyboard.press('Enter')
    await A.waitForSelector('.toast-error')
    await A.keyboard.press('Escape')
    if ((await shown(A, 2, 1)) !== 'North') throw new Error('a refused value was kept')
    await selectRange(A, [4, 2], [4, 6])
    await menu(A, 'Insert', 'Checkbox')
    await A.click('.grid-scroll', { position: cell(4, 3) })
    await until(B, () => window.__sheet.model.getFormattedCellValue(0, 3, 4) === 'TRUE')
    ok('validation: a dropdown refuses other values, and a checkbox ticks for both people')

    // Conditional formatting colours amounts over 10.
    await selectRange(A, [3, 2], [3, 6])
    await menu(A, 'Format', 'Conditional formatting')
    await A.fill('[aria-label="Value or formula"]', '10')
    await A.click('.chart-panel button:text-is("Done")')
    await until(B, () => window.__sheet.sheet === 0 && !!window.__sheet.cell(3, 3).fill && !window.__sheet.cell(2, 3).fill)
    await A.click('[aria-label="Close conditional formatting"]')
    ok('conditional formatting: the rule colours matching cells for the colleague')

    // Font, size and wrapping.
    await A.click('.grid-scroll', { position: cell(2, 2) })
    await A.selectOption('[aria-label="Font"]', 'Georgia')
    await A.selectOption('[aria-label="Font size"]', '18')
    await until(B, () => { const f = window.__sheet.model.getCellStyle(0, 2, 2).style.font; return f.name === 'Georgia' && f.sz === 18 })
    if (!(await B.evaluate(() => window.__sheet.model.getRowHeight(0, 2) > 25))) throw new Error('the row did not grow for the larger text')
    ok('format: font and size reach the colleague and the row grows to fit')

    // A pivot table that follows new data.
    await A.click('.grid-scroll', { position: cell(1, 2) })
    await menu(A, 'Insert', 'Pivot table')
    await A.click('.modal button:text-is("Create")')
    await A.waitForSelector('[aria-label="Pivot table editor"]')
    await A.selectOption('[aria-label="Add to rows"]', { label: 'Region' })
    await A.selectOption('[aria-label="Add a value"]', { label: 'Amount' })
    await until(A, () => window.__sheet.model.getFormattedCellValue(window.__sheet.sheet, 1, 2) === 'Sum of Amount')
    const pivotSheet = await A.evaluate(() => window.__sheet.sheet)
    const table = () => A.evaluate((s) => [1, 2, 3, 4, 5].map((r) => [1, 2].map((c) => window.__sheet.model.getFormattedCellValue(s, r, c)).join('=')).join(' '), pivotSheet)
    if ((await table()) !== 'Region=Sum of Amount East=7 North=15 South=32 Grand total=54') throw new Error('pivot table: ' + await table())
    await B.evaluate(() => window.__sheet.useSheet(0))
    await B.click('.grid-scroll', { position: cell(1, 7) })
    await B.keyboard.type('West\tFay\t9\n')
    await until(A, (s) => window.__sheet.model.getFormattedCellValue(s, 5, 1) === 'West' && window.__sheet.model.getFormattedCellValue(s, 6, 2) === '63', pivotSheet)
    ok('pivot table: sums by region, and a row the colleague adds shows up in it')

    // Find and replace across sheets.
    await A.evaluate(() => window.__sheet.useSheet(0))
    await A.click('.grid-scroll', { position: cell(5, 9) })
    await menu(A, 'Edit', 'Find and replace')
    await A.fill('.modal [aria-label="Find"]', 'South')
    await A.fill('.modal [aria-label="Replace with"]', 'Sud')
    await A.click('.modal button:text-is("Replace all")')
    await A.waitForSelector('.modal .sp-note:has-text("Replaced in")')
    await A.click('.modal [aria-label="Close"]')
    await until(B, () => window.__sheet.model.getFormattedCellValue(0, 3, 1) === 'Sud')
    ok('find and replace: replaces in every sheet, for both people')

    // Excel keeps the filter and the validation.
    await A.evaluate(() => {
      // Keep the file in the page instead of saving it to the Downloads folder.
      const click = HTMLAnchorElement.prototype.click
      const make = URL.createObjectURL
      let last = null
      URL.createObjectURL = (blob) => make.call(URL, (last = blob))
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__saved = { blob: last }
        else click.call(this)
      }
    })
    await menu(A, 'File', 'Download', 'Microsoft Excel (.xlsx)')
    await until(A, () => window.__saved, null, 20000)
    const b64 = await A.evaluate(async () => {
      const buf = new Uint8Array(await window.__saved.blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
      return btoa(s)
    })
    const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'))
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
    for (const part of ['<autoFilter ', '<dataValidation ', '<pane ', 'hidden="1"']) if (!xml.includes(part)) throw new Error('the Excel file lacks ' + part)
    if (Object.keys(zip.files).some((f) => /sheet[4-9]\.xml$/.test(f))) throw new Error('hidden helper sheets went into the Excel file')
    ok('Excel: the download keeps frozen rows, the filter and its hidden rows, and the validation')

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    for (const [name, page] of Object.entries(pages)) {
      const at = await page.evaluate(() => {
        const s = window.__sheet
        return { url: location.href, model: !!s?.model, online: s?.online, sel: s?.sel, cf: s?.model?.getConditionalFormattingList(0), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent), panel: document.querySelector('.chart-panel')?.getAttribute('aria-label') }
      }).catch((x) => x.message)
      console.error(`  ${name}: ${JSON.stringify(at)}`)
    }
    if (problems.length) console.error(problems.slice(0, 12).join('\n'))
    process.exitCode = 1
  } finally {
    if (created) await cleanup?.(created).catch(() => {})
    await b.close()
  }
})()
