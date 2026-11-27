// What a spreadsheet knows beyond the engine's cells: filters, filter views,
// data validation, pivot tables and clipped text. Like charts
// (sheet-charts.js), they live in a hidden sheet of their own, one row each:
// an id, the settings as JSON, and a formula naming the range they cover. So
// they sync, undo, land in versions and device copies like any edit, and the
// engine keeps their ranges right when rows, columns or sheets change.
//
// Everything here works on a bare engine model, so the spreadsheet screen
// (sheet-core.js) and the server's headless engine (headless/sheets.js) share
// it. Nothing here draws.
import { newId } from '../lib/util.js'
import { colName, extent } from './sheet-data.js'
import { parseRange, rangeText } from './sheet-charts.js'

const MARK = 'opensuite:meta'
export const MAXR = 1048576
export const MAXC = 16384

export const metaSheets = (m) => m.getWorksheetsProperties().map((sh, i) => (sh.state !== 'visible' && m.getCellContent(i, 1, 1) === MARK ? i : -1)).filter((i) => i >= 0)

const quoted = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)
export const refFormula = (m, ref) => `=ROWS(${quoted(m.getWorksheetsProperties()[ref.sheet].name)}!$${colName(ref.c1)}$${ref.r1}:$${colName(ref.c2)}$${ref.r2})`

// readMeta lists every item, optionally of one kind. `cache` is any object
// whose `metaCache` may be reused while `rev` is unchanged.
export function readMeta(m, kind, cache, rev) {
  let list
  if (cache && cache.metaCache?.rev === rev && cache.metaCache.model === m) list = cache.metaCache.list
  else {
    list = []
    for (const sheet of metaSheets(m)) {
      for (const row of m.getRowsWithData(sheet, 1)) {
        if (row === 1) continue
        try {
          const id = m.getCellContent(sheet, row, 1)
          const cfg = JSON.parse(m.getCellContent(sheet, row, 2))
          const src = m.getCellContent(sheet, row, 3)
          const ref = src ? parseRange(m, src.replace(/^=ROWS\(/, '').replace(/\)$/, ''), -1) : null
          if (id && cfg && typeof cfg === 'object' && cfg.kind) list.push({ ...cfg, id, ref, at: { sheet, row } })
        } catch {}
      }
    }
    if (cache) cache.metaCache = { rev, model: m, list }
  }
  return kind ? list.filter((x) => x.kind === kind) : list
}

function withMetaSheet(m, fn) {
  let sheet = metaSheets(m)[0]
  if (sheet === undefined) {
    m.newSheet()
    sheet = m.getWorksheetsProperties().length - 1
    m.renameSheet(sheet, '_meta_' + newId(5))
    m.hideSheet(sheet)
    m.setUserInput(sheet, 1, 1, MARK)
  }
  return fn(sheet)
}

const settings = ({ id, ref, at, ...cfg }) => JSON.stringify(cfg)

export function addMeta(m, cfg, ref) {
  const id = newId(8)
  withMetaSheet(m, (sheet) => {
    // A row picked at random, so two people adding at once do not collide.
    const row = 2 + Math.floor(Math.random() * 900000)
    m.setUserInput(sheet, row, 2, settings(cfg))
    if (ref) m.setUserInput(sheet, row, 3, refFormula(m, ref))
    m.setUserInput(sheet, row, 1, id)
  })
  return id
}

export function updateMeta(m, item, patch, ref) {
  const next = { ...item, ...patch }
  if (settings(next) !== settings(item)) m.setUserInput(item.at.sheet, item.at.row, 2, settings(next))
  if (ref) m.setUserInput(item.at.sheet, item.at.row, 3, refFormula(m, ref))
}

export function removeMeta(m, item) {
  m.rangeClearAll(item.at.sheet, item.at.row, 1, item.at.row, 3)
}

const sheetId = (m, sheet) => m.getWorksheetsProperties()[sheet]?.sheet_id
export const sheetById = (m, id) => m.getWorksheetsProperties().findIndex((sh) => sh.sheet_id === id)

// --- cell values ---------------------------------------------------------------

// A cell as sorting and filtering see it: its shown text, and its number when
// it holds one.
export function cellValue(m, sheet, r, c) {
  const text = m.getFormattedCellValue(sheet, r, c)
  if (!text) return { text: '', num: NaN, blank: true }
  const type = m.getCellType(sheet, r, c)
  let num = NaN
  if (type === 1) {
    const raw = m.getCellContent(sheet, r, c)
    num = Number(raw)
    if (!isFinite(num)) {
      // A formula: read the number back from the shown text.
      const t = text.replace(/[^0-9.eE+\-()%]/g, '')
      const neg = /^\(.*\)$/.test(t)
      num = Number(t.replace(/[()%]/g, '')) * (neg ? -1 : 1) / (t.includes('%') ? 100 : 1)
    }
  }
  return { text, num, blank: false }
}

// compare orders numbers first, then text (case-insensitive, natural), and
// blanks last whichever way the sort goes.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
function compare(a, b, desc) {
  if (a.blank || b.blank) return a.blank === b.blank ? 0 : a.blank ? 1 : -1
  const an = !isNaN(a.num)
  const bn = !isNaN(b.num)
  let d
  if (an && bn) d = a.num - b.num
  else if (an !== bn) d = an ? -1 : 1
  else d = collator.compare(a.text, b.text)
  return desc ? -d : d
}

// --- sorting -------------------------------------------------------------------

// sortRange sorts the rows of ref by keys [{ col, desc }] (col is a sheet
// column number). With `header` the first row stays where it is. Rows move
// with their formatting, and their formulas are adjusted as a copy and paste
// would adjust them. Returns how many rows moved.
export function sortRange(m, ref, keys, header = false) {
  const { sheet } = ref
  const r1 = ref.r1 + (header ? 1 : 0)
  const r2 = Math.min(ref.r2, Math.max(r1, extentRows(m, sheet, ref)))
  if (r2 <= r1) return 0
  if (m.getMergedCells(sheet).some((g) => g.row <= r2 && g.row + g.height - 1 >= r1 && g.column <= ref.c2 && g.column + g.width - 1 >= ref.c1)) {
    throw new Error('Sorting a range with merged cells is not possible; unmerge them first.')
  }
  const rows = []
  for (let r = r1; r <= r2; r++) rows.push({ r, k: keys.map((k) => cellValue(m, sheet, r, k.col)) })
  const sorted = [...rows].sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const d = compare(a.k[i], b.k[i], keys[i].desc)
      if (d) return d
    }
    return a.r - b.r // stable
  })
  if (sorted.every((x, i) => x.r === r1 + i)) return 0
  m.setSelectedSheet(sheet)
  m.setSelectedCell(r1, ref.c1)
  m.setSelectedRange(r1, ref.c1, r2, ref.c2)
  const clip = m.copyToClipboard()
  let moved = 0
  sorted.forEach((x, i) => {
    const dst = r1 + i
    if (x.r === dst) return
    const one = new Map([[x.r, clip.data.get(x.r) || new Map()]])
    m.setSelectedCell(dst, ref.c1)
    m.setSelectedRange(dst, ref.c1, dst, ref.c2)
    m.pasteFromClipboard(sheet, [x.r, ref.c1, x.r, ref.c2], one, false)
    moved++
  })
  return moved
}

// Where the data in a range ends, so sorting whole columns does not move a
// million empty rows.
function extentRows(m, sheet, ref) {
  let last = 0
  for (let c = ref.c1; c <= Math.min(ref.c2, ref.c1 + 200); c++) {
    const rows = m.getRowsWithData(sheet, c)
    for (const r of rows) if (r <= ref.r2 && r > last) last = r
  }
  return last
}

// dataBlock grows from a cell to the edges of the block of data around it,
// as a filter, sort or pivot table takes "the data" when given one cell.
export function dataBlock(m, sheet, sel) {
  let { r1, c1, r2, c2 } = sel
  if (r2 >= MAXR || c2 >= MAXC) {
    const e = extent(m, sheet)
    r2 = Math.min(r2, Math.max(1, e.rows))
    c2 = Math.min(c2, Math.max(1, e.cols))
    return { sheet, r1, c1, r2, c2 }
  }
  if (r1 !== r2 || c1 !== c2) return { sheet, r1, c1, r2, c2 }
  const filled = (r, c) => r >= 1 && c >= 1 && m.getFormattedCellValue(sheet, r, c) !== ''
  for (let grew = true, n = 0; grew && n < 100000; n++) {
    grew = false
    const rowHas = (r) => { for (let c = c1; c <= c2; c++) if (filled(r, c)) return true; return false }
    const colHas = (c) => { for (let r = r1; r <= Math.min(r2, r1 + 2000); r++) if (filled(r, c)) return true; return false }
    if (rowHas(r2 + 1)) { r2++; grew = true }
    if (r1 > 1 && rowHas(r1 - 1)) { r1--; grew = true }
    if (colHas(c2 + 1)) { c2++; grew = true }
    if (c1 > 1 && colHas(c1 - 1)) { c1--; grew = true }
  }
  return { sheet, r1, c1, r2, c2 }
}

// --- filters -------------------------------------------------------------------
//
// A filter is { kind: 'filter', sheet: sheet_id, criteria } over a range whose
// first row holds the headings. A filter view is the same with kind 'view', a
// name and its owner; it changes the sheet only for whoever has it open.
// criteria: { [column number]: { hidden?: [shown texts], cond?: { op, a, b } } }
// and sort: { col, desc } (filter views sort on screen only).

export const condOps = {
  empty: 'Is empty',
  notEmpty: 'Is not empty',
  contains: 'Text contains',
  notContains: 'Text does not contain',
  starts: 'Text starts with',
  ends: 'Text ends with',
  is: 'Text is exactly',
  gt: 'Greater than',
  gte: 'Greater than or equal to',
  lt: 'Less than',
  lte: 'Less than or equal to',
  eq: 'Is equal to',
  ne: 'Is not equal to',
  between: 'Is between',
}

export function passes(v, cond) {
  if (!cond?.op) return true
  const t = v.text.toLowerCase()
  const a = String(cond.a ?? '').toLowerCase()
  const na = Number(cond.a)
  const nb = Number(cond.b)
  switch (cond.op) {
    case 'empty': return v.blank
    case 'notEmpty': return !v.blank
    case 'contains': return t.includes(a)
    case 'notContains': return !t.includes(a)
    case 'starts': return t.startsWith(a)
    case 'ends': return t.endsWith(a)
    case 'is': return t === a
    case 'gt': return !isNaN(v.num) && v.num > na
    case 'gte': return !isNaN(v.num) && v.num >= na
    case 'lt': return !isNaN(v.num) && v.num < na
    case 'lte': return !isNaN(v.num) && v.num <= na
    case 'eq': return isNaN(na) ? t === a : v.num === na
    case 'ne': return isNaN(na) ? t !== a : v.num !== na
    case 'between': return !isNaN(v.num) && v.num >= Math.min(na, nb) && v.num <= Math.max(na, nb)
  }
  return true
}

// The rows a filter covers: its range, and rows typed straight under it.
export const filterRange = (m, f) => growSource(m, f.ref)

// hiddenRows is the set of rows a filter (or view) hides.
export function hiddenRows(m, f) {
  const out = new Set()
  if (!f?.ref) return out
  const ref = filterRange(m, f)
  const { sheet, r1 } = ref
  const cols = Object.entries(f.criteria || {}).filter(([, c]) => c && (c.hidden?.length || c.cond?.op))
  if (!cols.length) return out
  const r2 = Math.min(ref.r2, Math.max(r1, extentRows(m, sheet, ref)))
  for (let r = r1 + 1; r <= r2; r++) {
    for (const [col, c] of cols) {
      const v = cellValue(m, sheet, r, +col)
      if ((c.hidden?.length && c.hidden.includes(v.text)) || !passes(v, c.cond)) {
        out.add(r)
        break
      }
    }
  }
  return out
}

// columnValues lists a filter column's distinct shown values with counts, for
// the filter menu.
export function columnValues(m, f, col) {
  const ref = filterRange(m, f)
  const { sheet, r1 } = ref
  const r2 = Math.min(ref.r2, Math.max(r1, extentRows(m, sheet, ref)), r1 + 50000)
  const seen = new Map()
  for (let r = r1 + 1; r <= r2; r++) {
    const v = cellValue(m, sheet, r, col)
    const e = seen.get(v.text)
    if (e) e.n++
    else seen.set(v.text, { text: v.text, v, n: 1 })
  }
  return [...seen.values()].sort((a, b) => compare(a.v, b.v, false))
}

export const filterOf = (m, sheet, cache, rev) => readMeta(m, 'filter', cache, rev).find((f) => f.ref && f.ref.sheet === sheet)

export function setFilter(m, sheet, ref, criteria = {}) {
  const old = readMeta(m, 'filter').find((f) => f.ref?.sheet === sheet)
  if (old) updateMeta(m, old, { criteria }, ref)
  else addMeta(m, { kind: 'filter', criteria }, ref)
}

export function removeFilter(m, sheet) {
  for (const f of readMeta(m, 'filter')) if (f.ref?.sheet === sheet) removeMeta(m, f)
}

// --- data validation -------------------------------------------------------------
//
// { kind: 'validation', rule, strict, help } over a range. rule is one of
//   { type: 'list', values: [..] }          a dropdown of these items
//   { type: 'range', source: 'Sheet!A1:A9' } a dropdown of the cells there
//   { type: 'checkbox' }                     TRUE / FALSE, drawn as a box
//   { type: 'number', op, a, b }             op as in condOps (gt, between…)
//   { type: 'text', op, a }                  contains, notContains, is
// strict: refuse other input; otherwise mark it as invalid.

export function validationAt(m, sheet, r, c, cache, rev) {
  let found = null
  for (const v of readMeta(m, 'validation', cache, rev)) {
    const ref = v.ref
    if (ref && ref.sheet === sheet && r >= ref.r1 && r <= ref.r2 && c >= ref.c1 && c <= ref.c2) found = v
  }
  return found
}

export function listItems(m, rule) {
  if (rule.type === 'list') return (rule.values || []).map(String).filter((x) => x !== '')
  if (rule.type === 'range') {
    const ref = parseRange(m, rule.source, 0)
    if (!ref) return []
    const out = []
    for (let r = ref.r1; r <= Math.min(ref.r2, ref.r1 + 500); r++) {
      for (let c = ref.c1; c <= Math.min(ref.c2, ref.c1 + 20); c++) {
        const t = m.getFormattedCellValue(ref.sheet, r, c)
        if (t && !out.includes(t)) out.push(t)
      }
    }
    return out
  }
  return []
}

// valid says whether input (as typed or shown) meets a rule. Empty is fine.
export function valid(m, rule, text) {
  if (text === '' || text == null) return true
  const s = String(text)
  switch (rule.type) {
    case 'list':
    case 'range': return listItems(m, rule).some((x) => x.toLowerCase() === s.toLowerCase())
    case 'checkbox': return /^(true|false)$/i.test(s)
    case 'number': {
      const n = Number(s.replace(/[, ]/g, ''))
      if (!isFinite(n)) return false
      return passes({ text: s, num: n, blank: false }, rule)
    }
    case 'text': return passes({ text: s, num: NaN, blank: false }, rule)
  }
  return true
}

export function describeRule(rule) {
  switch (rule.type) {
    case 'list': return `one of: ${(rule.values || []).join(', ')}`
    case 'range': return `one of the values in ${rule.source}`
    case 'checkbox': return 'TRUE or FALSE'
    case 'number': return `a number that ${(condOps[rule.op] || '').toLowerCase()} ${rule.a ?? ''}${rule.op === 'between' ? ' and ' + rule.b : ''}`.replace('is ', '')
    case 'text': return `text that ${(condOps[rule.op] || '').toLowerCase().replace('text ', '')} "${rule.a ?? ''}"`
  }
  return ''
}

export function setValidation(m, ref, rule, strict = true, help = '') {
  // A new rule replaces any rule over exactly that range.
  for (const v of readMeta(m, 'validation')) {
    if (v.ref && v.ref.sheet === ref.sheet && v.ref.r1 === ref.r1 && v.ref.r2 === ref.r2 && v.ref.c1 === ref.c1 && v.ref.c2 === ref.c2) removeMeta(m, v)
  }
  return addMeta(m, { kind: 'validation', rule, strict: !!strict, help: help || '' }, ref)
}

export function clearValidation(m, ref) {
  for (const v of readMeta(m, 'validation')) {
    const r = v.ref
    if (r && r.sheet === ref.sheet && r.r1 <= ref.r2 && r.r2 >= ref.r1 && r.c1 <= ref.c2 && r.c2 >= ref.c1) removeMeta(m, v)
  }
}

// --- text clipping -------------------------------------------------------------
// Excel has only "overflow" and "wrap"; "clip" (cut the text at the cell's
// edge) is kept here as ranges.

export function clipped(m, sheet, r, c, cache, rev) {
  return readMeta(m, 'clip', cache, rev).some((x) => x.ref && x.ref.sheet === sheet && r >= x.ref.r1 && r <= x.ref.r2 && c >= x.ref.c1 && c <= x.ref.c2)
}

// setWrapping sets overflow, wrap or clip on a range.
export function setWrapping(m, ref, mode) {
  m.updateRangeStyle({ sheet: ref.sheet, row: ref.r1, column: ref.c1, width: ref.c2 - ref.c1 + 1, height: ref.r2 - ref.r1 + 1 }, 'alignment.wrap_text', String(mode === 'wrap'))
  for (const x of readMeta(m, 'clip')) {
    const r = x.ref
    if (r && r.sheet === ref.sheet && r.r1 >= ref.r1 && r.r2 <= ref.r2 && r.c1 >= ref.c1 && r.c2 <= ref.c2) removeMeta(m, x)
  }
  if (mode === 'clip') addMeta(m, { kind: 'clip' }, ref)
}

// --- find and replace --------------------------------------------------------------

// matcher builds a test from find options { find, matchCase, wholeCell, regex }.
export function matcher({ find, matchCase, wholeCell, regex }) {
  if (!find) return null
  let src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (wholeCell) src = `^(?:${src})$`
  return new RegExp(src, matchCase ? 'g' : 'gi')
}

// findAll lists matching cells: in what was typed when `formulas` is set,
// otherwise in what is shown (formulas are then skipped for replacing).
export function findAll(m, opts, sheets) {
  const re = matcher(opts)
  if (!re) return []
  const out = []
  for (const sheet of sheets) {
    const e = extent(m, sheet)
    for (let r = 1; r <= e.rows; r++) {
      const cols = m.getColumnsWithData(sheet, r)
      for (const c of [...cols].sort((a, b) => a - b)) {
        const content = m.getCellContent(sheet, r, c)
        const formula = content.startsWith('=')
        const text = opts.formulas ? content : m.getFormattedCellValue(sheet, r, c)
        re.lastIndex = 0
        if (re.test(text)) out.push({ sheet, r, c, formula, content })
      }
    }
  }
  return out
}

// replaceAll replaces in every match it can: plain values always, formulas
// only when searching within formulas. Returns how many cells changed.
export function replaceAll(m, opts, sheets) {
  const re = matcher(opts)
  if (!re) return 0
  let n = 0
  for (const hit of findAll(m, opts, sheets)) {
    if (hit.formula && !opts.formulas) continue
    re.lastIndex = 0
    const next = hit.content.replace(re, opts.replace ?? '')
    if (next !== hit.content) {
      m.setUserInput(hit.sheet, hit.r, hit.c, next)
      n++
    }
  }
  return n
}

export const visibleSheets = (m) => m.getWorksheetsProperties().map((sh, i) => (sh.state === 'visible' ? i : -1)).filter((i) => i >= 0)

// --- pivot tables ---------------------------------------------------------------
//
// { kind: 'pivot', target: sheet_id, rows: [col], cols: [col], values:
// [{ col, fn }], filters: { [col]: [hidden values] } } over the source range
// (headings in its first row). The table is written into its own sheet as
// labels and formulas (SUMIFS and friends), so totals follow the data as it
// changes; the labels are rewritten when new values appear (refreshPivots).

export const pivotFns = { SUM: 'Sum', COUNT: 'Count', AVERAGE: 'Average', MIN: 'Min', MAX: 'Max' }

const esc = (s) => `"${String(s).replace(/"/g, '""')}"`
const crit = (label) => (/[*?~]/.test(label) ? esc('=' + label.replace(/[*?~]/g, '~$&')) : null)

function colRange(m, src, c) {
  const name = quoted(m.getWorksheetsProperties()[src.sheet].name)
  return `${name}!$${colName(c)}$${src.r1 + 1}:$${colName(c)}$${src.r2}`
}

const BLANK = '(blank)'

// growSource takes in rows added straight under the source range.
function growSource(m, src) {
  if (!src || src.r2 >= MAXR) return src
  let r2 = src.r2
  const filled = (r) => { for (let c = src.c1; c <= src.c2; c++) if (m.getFormattedCellValue(src.sheet, r, c) !== '') return true; return false }
  while (r2 < MAXR && filled(r2 + 1) && r2 - src.r2 < 100000) r2++
  return r2 === src.r2 ? src : { ...src, r2 }
}

function distinct(m, src, col, hiddenFilter) {
  const seen = new Map()
  for (let r = src.r1 + 1; r <= src.r2; r++) {
    if (hiddenFilter(r)) continue
    const v = cellValue(m, src.sheet, r, col)
    const key = v.blank ? BLANK : v.text
    if (!seen.has(key)) seen.set(key, v)
  }
  return [...seen.entries()].sort((a, b) => compare(a[1], b[1], false)).map(([k]) => k)
}

const heading = (m, src, c) => m.getFormattedCellValue(src.sheet, src.r1, c) || colName(c)

// pivotCells works out what the table's sheet should hold: a Map of
// "row:col" -> what to type.
export function pivotCells(m, p) {
  const src = p.ref
  const out = new Map()
  if (!src) return { cells: out, rows: 0, cols: 0 }
  const put = (r, c, v) => out.set(r + ':' + c, String(v))
  const filters = Object.entries(p.filters || {}).filter(([, h]) => h?.length)
  const isHidden = (r) => filters.some(([c, h]) => { const v = cellValue(m, src.sheet, r, +c); return h.includes(v.blank ? BLANK : v.text) })
  const rowFields = p.rows || []
  const colField = (p.cols || [])[0]
  const vals = (p.values || []).length ? p.values : [{ col: null, fn: 'COUNT' }]
  // Row keys: every combination that occurs.
  const combos = new Map()
  for (let r = src.r1 + 1; r <= src.r2; r++) {
    if (isHidden(r)) continue
    const key = rowFields.map((c) => { const v = cellValue(m, src.sheet, r, c); return { k: v.blank ? BLANK : v.text, v } })
    if (!rowFields.length && combos.size) continue
    const id = key.map((x) => x.k).join('\u0000')
    if (!combos.has(id)) combos.set(id, key)
  }
  const rowKeys = [...combos.values()].sort((a, b) => {
    for (let i = 0; i < a.length; i++) {
      const d = compare(a[i].v, b[i].v, false)
      if (d) return d
    }
    return 0
  }).map((k) => k.map((x) => x.k))
  const colKeys = colField ? distinct(m, src, colField, isHidden) : [null]
  const nr = Math.max(1, rowFields.length)
  // Headings.
  rowFields.forEach((c, i) => put(1, i + 1, heading(m, src, c)))
  if (!rowFields.length) put(1, 1, '')
  const fname = (v) => `${pivotFns[v.fn] || v.fn} of ${v.col ? heading(m, src, v.col) : 'rows'}`
  const columns = []
  for (const ck of colKeys) for (const v of vals) columns.push({ ck, v })
  if (colField) for (const v of vals) columns.push({ ck: undefined, v, total: true })
  columns.forEach((col, j) => {
    const label = col.total ? (vals.length > 1 ? `Total ${fname(col.v)}` : 'Grand total') : col.ck === null ? fname(col.v) : vals.length > 1 ? `${col.ck} · ${fname(col.v)}` : col.ck
    put(1, nr + 1 + j, label)
  })
  // Criteria for one cell of the table.
  const where = (r, j, keys, grand) => {
    const parts = []
    if (!grand) keys.forEach((k, i) => parts.push(colRange(m, src, rowFields[i]), k === BLANK ? '"="' : crit(k) || `$${colName(i + 1)}$${r}`))
    const col = columns[j]
    if (colField && !col.total) parts.push(colRange(m, src, colField), col.ck === BLANK ? '"="' : crit(col.ck) || `${colName(nr + 1 + j)}$1`)
    for (const [c, h] of filters) for (const x of h) parts.push(colRange(m, src, +c), x === BLANK ? '"<>"' : esc('<>' + x.replace(/[*?~]/g, '~$&')))
    return parts
  }
  const formula = (v, parts) => {
    const vr = v.col ? colRange(m, src, v.col) : null
    const anyCol = colRange(m, src, rowFields[0] || colField || src.c1)
    const crits = parts.length ? parts : [anyCol, '"<>"']
    const c = crits.join(',')
    switch (v.fn) {
      case 'SUM': return `=SUMIFS(${vr},${c})`
      case 'AVERAGE': return `=IFERROR(AVERAGEIFS(${vr},${c}),"")`
      case 'MIN': return `=IF(COUNTIFS(${vr},"<>",${c})=0,"",MINIFS(${vr},${c}))`
      case 'MAX': return `=IF(COUNTIFS(${vr},"<>",${c})=0,"",MAXIFS(${vr},${c}))`
      default: return vr ? `=COUNTIFS(${vr},"<>",${c})` : `=COUNTIFS(${c})`
    }
  }
  rowKeys.forEach((keys, i) => {
    const r = 2 + i
    keys.forEach((k, j) => put(r, j + 1, k))
    columns.forEach((col, j) => put(r, nr + 1 + j, formula(col.v, where(r, j, keys, false))))
  })
  const tr = 2 + rowKeys.length
  put(tr, 1, 'Grand total')
  columns.forEach((col, j) => put(tr, nr + 1 + j, formula(col.v, where(tr, j, [], true))))
  return { cells: out, rows: tr, cols: nr + columns.length }
}

// refreshPivots rewrites every pivot table whose sheet no longer matches what
// its source says it should hold. Only changed cells are written, so a table
// whose labels are unchanged costs nothing.
export function refreshPivots(m) {
  let wrote = 0
  for (const p of readMeta(m, 'pivot')) {
    if (!p.ref) continue
    const grown = growSource(m, p.ref)
    if (grown !== p.ref) {
      updateMeta(m, p, {}, grown)
      p.ref = grown
    }
    const target = sheetById(m, p.target)
    if (target < 0) continue
    wrote += writePivot(m, p, target)
  }
  return wrote
}

function writePivot(m, p, target) {
  const { cells, rows, cols } = pivotCells(m, p)
  const e = extent(m, target)
  const R = Math.max(rows, e.rows)
  const C = Math.max(cols, e.cols)
  let wrote = 0
  for (let r = 1; r <= R; r++) {
    for (let c = 1; c <= C; c++) {
      const want = cells.get(r + ':' + c) ?? ''
      if (m.getCellContent(target, r, c) === want) continue
      if (want === '') m.rangeClearContents(target, r, c, r, c)
      else m.setUserInput(target, r, c, want)
      wrote++
    }
  }
  // Headings and totals in bold, the rows between not (they move as labels come and go).
  if (wrote && rows) {
    if (rows > 2) m.updateRangeStyle({ sheet: target, row: 2, column: 1, width: C, height: rows - 2 }, 'font.b', 'false')
    m.updateRangeStyle({ sheet: target, row: 1, column: 1, width: cols, height: 1 }, 'font.b', 'true')
    m.updateRangeStyle({ sheet: target, row: rows, column: 1, width: cols, height: 1 }, 'font.b', 'true')
    if (R > rows) m.updateRangeStyle({ sheet: target, row: rows + 1, column: 1, width: C, height: R - rows }, 'font.b', 'false')
  }
  return wrote
}

// addPivot makes a new sheet for a pivot table over src and fills it.
export function addPivot(m, src, cfg) {
  const names = new Set(m.getWorksheetsProperties().map((sh) => sh.name.toLowerCase()))
  let name = 'Pivot table'
  for (let n = 2; names.has(name.toLowerCase()); n++) name = 'Pivot table ' + n
  m.newSheet()
  const at = m.getWorksheetsProperties().length - 1
  m.renameSheet(at, name)
  const target = sheetId(m, at)
  const id = addMeta(m, { kind: 'pivot', target, rows: cfg.rows || [], cols: cfg.cols || [], values: cfg.values || [], filters: cfg.filters || {} }, src)
  const p = readMeta(m, 'pivot').find((x) => x.id === id)
  writePivot(m, p, at)
  return { id, sheet: at, name }
}

export function updatePivot(m, p, patch) {
  updateMeta(m, p, patch)
  const next = { ...p, ...patch }
  const target = sheetById(m, p.target)
  if (target >= 0) writePivot(m, next, target)
}

export const pivotOn = (m, sheet, cache, rev) => readMeta(m, 'pivot', cache, rev).find((p) => sheetById(m, p.target) === sheet)

// --- describing -------------------------------------------------------------------

// setup is everything beyond cells, for the API: per visible sheet its
// freeze, filter, rules, validation, and the pivot tables.
export function setup(m) {
  const props = m.getWorksheetsProperties()
  const meta = readMeta(m)
  const name = (i) => props[i]?.name
  const rt = (ref) => (ref ? rangeText(m, ref, -1) : null)
  return visibleSheets(m).map((i) => ({
    name: name(i),
    frozenRows: m.getFrozenRowsCount(i),
    frozenColumns: m.getFrozenColumnsCount(i),
    filter: meta.filter((x) => x.kind === 'filter' && x.ref?.sheet === i).map((f) => ({ range: rt(f.ref), criteria: namedCriteria(f) }))[0] || null,
    filterViews: meta.filter((x) => x.kind === 'view' && x.ref?.sheet === i).map((f) => ({ id: f.id, name: f.name, owner: f.ownerName || '', range: rt(f.ref), criteria: namedCriteria(f), sort: f.sort ? { column: colName(f.sort.col), desc: !!f.sort.desc } : null })),
    conditionalFormats: m.getConditionalFormattingList(i).map((x) => ({ index: x.index, range: x.range, rule: x.cf_rule, format: m.getDxfForConditionalFormatting(i, x.index) })),
    validation: meta.filter((x) => x.kind === 'validation' && x.ref?.sheet === i).map((v) => ({ id: v.id, range: rt(v.ref), rule: v.rule, strict: v.strict, help: v.help || '' })),
    pivotTable: (() => {
      const p = meta.find((x) => x.kind === 'pivot' && sheetById(m, x.target) === i)
      return p ? { id: p.id, source: rt(p.ref), rows: p.rows.map(colName), columns: (p.cols || []).map(colName), values: p.values.map((v) => ({ column: v.col ? colName(v.col) : null, fn: v.fn })), filters: Object.fromEntries(Object.entries(p.filters || {}).map(([c, h]) => [colName(+c), h])) } : null
    })(),
  }))
}

const namedCriteria = (f) => Object.fromEntries(Object.entries(f.criteria || {}).filter(([, c]) => c && (c.hidden?.length || c.cond?.op)).map(([c, v]) => [colName(+c), v]))
