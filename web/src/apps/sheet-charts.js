// Where charts live. The calculation engine has no notion of a chart, so a
// workbook keeps its charts in a hidden sheet of its own: one row per chart
// holding an id, its settings as JSON, and a formula that refers to its data.
//
// That choice buys a lot for nothing. Chart changes are ordinary engine edits,
// so they ride the same ordered sync as cell edits, are in every snapshot,
// device copy and version, and Undo covers them. And because the data range
// is a real formula, the engine itself keeps it pointing at the right cells
// when rows or columns are inserted or a sheet is renamed.
import { newId } from '../lib/util.js'
import { colName } from './sheet-data.js'

const MARK = 'opensuite:charts'
const MAX_ROWS = 400
const MAX_COLS = 60

const chartSheets = (m) => m.getWorksheetsProperties().map((sh, i) => (sh.state !== 'visible' && m.getCellContent(i, 1, 1) === MARK ? i : -1)).filter((i) => i >= 0)

const colIndex = (name) => [...name].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)

// "A1:C5", "Sheet2!A1:C5" or "'My sheet'!A1:C5" -> { sheet, r1, c1, r2, c2 }
export function parseRange(m, text, fallbackSheet) {
  const x = /^\s*(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?\s*$/.exec(text || '')
  if (!x) return null
  const name = x[1] ? x[1].replace(/''/g, "'") : x[2]
  const sheets = m.getWorksheetsProperties()
  const sheet = name ? sheets.findIndex((sh) => sh.name.toLowerCase() === name.toLowerCase()) : fallbackSheet
  if (sheet < 0 || sheet === undefined) return null
  const ca = colIndex(x[3].toUpperCase())
  const cb = x[5] ? colIndex(x[5].toUpperCase()) : ca
  const ra = +x[4]
  const rb = x[6] ? +x[6] : ra
  if (!ra || !rb || Math.max(ca, cb) > 16384 || Math.max(ra, rb) > 1048576) return null
  return { sheet, r1: Math.min(ra, rb), c1: Math.min(ca, cb), r2: Math.max(ra, rb), c2: Math.max(ca, cb) }
}

const quoted = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)

export function rangeText(m, ref, relativeTo) {
  const cells = `${colName(ref.c1)}${ref.r1}:${colName(ref.c2)}${ref.r2}`
  return ref.sheet === relativeTo ? cells : `${quoted(m.getWorksheetsProperties()[ref.sheet].name)}!${cells}`
}

const formula = (m, ref) => `=ROWS(${quoted(m.getWorksheetsProperties()[ref.sheet].name)}!${colName(ref.c1)}${ref.r1}:${colName(ref.c2)}${ref.r2})`

// readCharts lists every chart in the workbook. Cached until the workbook
// changes (Sheet.rev).
export function readCharts(s) {
  if (s.chartCache?.rev === s.rev && s.chartCache.model === s.model) return s.chartCache.list
  const m = s.model
  const list = []
  for (const sheet of chartSheets(m)) {
    for (const row of m.getRowsWithData(sheet, 1)) {
      if (row === 1) continue
      try {
        const id = m.getCellContent(sheet, row, 1)
        const cfg = JSON.parse(m.getCellContent(sheet, row, 2))
        const src = m.getCellContent(sheet, row, 3)
        const ref = parseRange(m, src.replace(/^=ROWS\(/, '').replace(/\)$/, ''), -1)
        if (id && cfg && typeof cfg === 'object') list.push({ ...cfg, id, ref, at: { sheet, row } })
      } catch {}
    }
  }
  s.chartCache = { rev: s.rev, model: s.model, list }
  return list
}

// The engine addresses sheets by position, so the hidden sheet is found (or
// made) inside the same edit that writes to it.
function withChartSheet(m, fn) {
  let sheet = chartSheets(m)[0]
  if (sheet === undefined) {
    m.newSheet()
    sheet = m.getWorksheetsProperties().length - 1
    m.renameSheet(sheet, '_charts_' + newId(5))
    m.hideSheet(sheet)
    m.setUserInput(sheet, 1, 1, MARK)
  }
  fn(sheet)
}

const settings = ({ id, ref, at, ...cfg }) => JSON.stringify(cfg)

export function addChart(s, cfg, ref) {
  const id = newId(8)
  s.act((m) => withChartSheet(m, (sheet) => {
    // A row picked at random, so two people adding charts at the same moment
    // do not write over each other.
    const row = 2 + Math.floor(Math.random() * 900000)
    m.setUserInput(sheet, row, 2, settings(cfg))
    m.setUserInput(sheet, row, 3, formula(m, ref))
    // The id goes in last: a chart exists once its row has one, so a single
    // Undo takes a new chart away again.
    m.setUserInput(sheet, row, 1, id)
  }))
  return id
}

export function updateChart(s, id, patch, ref) {
  const c = readCharts(s).find((x) => x.id === id)
  if (!c) return
  s.act((m) => {
    m.setUserInput(c.at.sheet, c.at.row, 2, settings({ ...c, ...patch }))
    if (ref) m.setUserInput(c.at.sheet, c.at.row, 3, formula(m, ref))
  })
}

export function removeChart(s, id) {
  const c = readCharts(s).find((x) => x.id === id)
  if (c) s.act((m) => m.rangeClearAll(c.at.sheet, c.at.row, 1, c.at.row, 3))
}

// Formatted cell text back to a number: "€4,200.00", "45%", "(1,234)".
function toNumber(text, fmt) {
  if (/[dmyhs]/i.test((fmt || '').replace(/"[^"]*"|\[[^\]]*\]|general/gi, ''))) return NaN // dates read as labels
  let t = text.replace(/[^0-9.eE+\-()%]/g, '')
  const neg = /^\(.*\)$/.test(t)
  const pct = t.includes('%')
  t = t.replace(/[()%]/g, '')
  if (!t || !/\d/.test(t)) return NaN
  const n = Number(t)
  if (!isFinite(n)) return NaN
  return (neg ? -n : n) / (pct ? 100 : 1)
}

function readCells(m, ref) {
  const rows = []
  const r2 = Math.min(ref.r2, ref.r1 + MAX_ROWS - 1)
  const c2 = Math.min(ref.c2, ref.c1 + MAX_COLS - 1)
  for (let r = ref.r1; r <= r2; r++) {
    const row = []
    for (let c = ref.c1; c <= c2; c++) {
      const text = m.getFormattedCellValue(ref.sheet, r, c)
      const num = text && m.getCellType(ref.sheet, r, c) === 1 ? toNumber(text, m.getCellStyle(ref.sheet, r, c).style.num_fmt) : NaN
      row.push({ text, num })
    }
    rows.push(row)
  }
  return rows
}

// chartData turns a chart's range into labels and series, following its
// settings for headers, labels and orientation.
export function chartData(s, chart) {
  if (!chart.ref) return { missing: true, labels: [], series: [] }
  let grid = readCells(s.model, chart.ref)
  if (chart.byRows) grid = grid[0].map((_, c) => grid.map((row) => row[c]))
  const head = chart.headers ? grid[0] : null
  const body = chart.headers ? grid.slice(1) : grid
  const first = chart.labels ? 1 : 0
  const labels = body.map((row, i) => (chart.labels ? row[0].text : String(i + 1)))
  const series = []
  for (let c = first; c < (grid[0]?.length || 0); c++) {
    series.push({ name: head?.[c]?.text || `Series ${c - first + 1}`, values: body.map((row) => row[c].num), texts: body.map((row) => row[c].text) })
  }
  // Scatter reads its horizontal values from the first column when that
  // column is numeric, even if it would otherwise be labels.
  const xs = chart.labels ? body.map((row) => row[0].num) : null
  return { labels, series, xs }
}

// guessChart proposes a chart for the current selection: the block of data
// around a single cell, or the selected range, with headers and labels
// switched on when the first row and column look like text.
export function guessChart(s) {
  const m = s.model
  const sheet = s.sheet
  let { r1, c1, r2, c2 } = s.sel
  const filled = (r, c) => r >= 1 && c >= 1 && m.getFormattedCellValue(sheet, r, c) !== ''
  if (r1 === r2 && c1 === c2) {
    // Grow from the cell to the edges of the block it belongs to.
    for (let grew = true; grew && r2 - r1 < MAX_ROWS && c2 - c1 < MAX_COLS;) {
      grew = false
      const rowHas = (r) => { for (let c = c1; c <= c2; c++) if (filled(r, c)) return true; return false }
      const colHas = (c) => { for (let r = r1; r <= r2; r++) if (filled(r, c)) return true; return false }
      if (rowHas(r2 + 1)) { r2++; grew = true }
      if (r1 > 1 && rowHas(r1 - 1)) { r1--; grew = true }
      if (colHas(c2 + 1)) { c2++; grew = true }
      if (c1 > 1 && colHas(c1 - 1)) { c1--; grew = true }
    }
  } else {
    // A whole row or column selection is trimmed to where the data ends.
    const rows = []
    const cols = []
    for (let c = c1; c <= Math.min(c2, c1 + MAX_COLS); c++) for (const r of m.getRowsWithData(sheet, c)) if (r >= r1 && r <= r2) { rows.push(r); cols.push(c) }
    if (rows.length) {
      r2 = Math.max(...rows)
      c2 = Math.max(...cols)
      r1 = Math.max(r1, Math.min(...rows))
      c1 = Math.max(c1, Math.min(...cols))
    } else {
      r2 = r1
      c2 = c1
    }
  }
  const ref = { sheet, r1, c1, r2, c2 }
  const grid = readCells(m, ref)
  const numeric = (cell) => !isNaN(cell.num)
  const headers = grid.length > 1 && grid[0].some((x) => x.text) && !grid[0].slice(grid[0].length > 1 ? 1 : 0).some(numeric)
  const body = headers ? grid.slice(1) : grid
  const labels = grid[0].length > 1 && body.some((row) => row[0].text) && !body.some((row) => numeric(row[0]))
  return { ref, headers, labels }
}

export const chartSheetsOf = chartSheets
