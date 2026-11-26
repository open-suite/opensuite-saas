// Spreadsheets, through the same engine and helpers as the spreadsheet
// screen (apps/sheet-data.js, apps/sheet-charts.js). A write is one engine
// diff, made on the workbook as the server's log has it, exactly like an
// edit in the browser; the server orders it with everyone else's. Hidden
// sheets (where charts are kept) are never shown or written.
import { Model } from '@ironcalc/wasm-xlsx'
import { loadModel, xlsxSnapshot, addSheet, sheetText, colName } from '../apps/sheet-data.js'
import { parseRange, toXlsx } from '../apps/sheet-charts.js'
import { parseCsv, toCsv, csvSnapshot } from '../lib/csv.js'
import { arg, frames, fromB64, toB64 } from './wire.js'

const MAX_CELLS = 200000

function open(args, fn) {
  const m = loadModel(frames(args))
  try {
    return fn(m)
  } finally {
    m.free()
  }
}

// The sheets people see, with their position in the workbook (`at`) and
// among the visible ones (`index`).
const visible = (m) => m.getWorksheetsProperties().map((sh, at) => ({ ...sh, at })).filter((sh) => sh.state === 'visible').map((sh, index) => ({ ...sh, index }))

const names = (m) => visible(m).map((sh) => JSON.stringify(sh.name)).join(', ')

// pick finds a sheet by name or by its position among the visible ones; none
// given is the first.
function pick(m, which) {
  const shown = visible(m)
  const sh = which == null ? shown[0]
    : typeof which === 'number' ? shown[which]
      : typeof which === 'string' ? shown.find((s) => s.name === which) || shown.find((s) => s.name.toLowerCase() === which.toLowerCase())
        : null
  if (!sh) throw new Error(`No sheet ${JSON.stringify(which)}. The sheets are ${names(m)}`)
  return sh
}

// area reads "B2", "A1:C9" or "Sheet2!A1:C9" on sheet `sh` unless it names
// another one.
function area(m, text, sh, key) {
  const ref = parseRange(m, text, sh.at)
  if (!ref) throw new Error(`${key} must be a cell or range such as "B2" or "A1:C9", not ${JSON.stringify(text)}`)
  const on = visible(m).find((s) => s.at === ref.sheet)
  if (!on) throw new Error(`No sheet in ${JSON.stringify(text)}. The sheets are ${names(m)}`)
  return { ...ref, sh: on }
}

// extent is where a sheet's data ends. The engine lists rows one column at a
// time, so rows are found in the columns the search text reads (sheetText),
// and each is then followed to its last cell.
function extent(m, s) {
  const rows = new Set()
  for (let c = 1; c <= 60; c++) for (const r of m.getRowsWithData(s, c)) rows.add(r)
  let cols = 0
  for (const r of rows) cols = Math.max(cols, m.getLastNonEmptyInRowBeforeColumn(s, r, 16385) ?? 0)
  return { rows: rows.size ? Math.max(...rows) : 0, cols }
}

const rangeText = (r) => `${colName(r.c1)}${r.r1}:${colName(r.c2)}${r.r2}`

// cellInput turns a value into what typing it in the cell would be.
function cellInput(v, r, c) {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (Number.isFinite(v)) return String(v)
  throw new Error(`The value for ${colName(c)}${r} must be a string, number, boolean or null`)
}

// written ends a write: the diff it made and the new search text.
function written(m) {
  const diff = m.flushSendQueue()
  return { update: diff.length > 1 ? toB64(diff) : '', text: sheetText(m) }
}

// snapshotted describes a workbook made from a file.
function snapshotted(bytes) {
  const m = Model.fromBytes(bytes, 'en')
  try {
    return { snapshot: toB64(bytes), text: sheetText(m) }
  } finally {
    m.free()
  }
}

export const sheetOps = {
  'sheet.read': (args) => open(args, (m) => {
    const sh = pick(m, args.sheet)
    const sheets = visible(m).map((s) => ({ name: s.name, index: s.index, ...extent(m, s.at) }))
    let ref
    if (args.range != null) ref = area(m, arg(args, 'range', 'string'), sh, 'range')
    else {
      const e = extent(m, sh.at)
      if (!e.rows) return { sheets, sheet: sh.name, range: '', values: [], formulas: [], csv: '' }
      ref = { sh, r1: 1, c1: 1, r2: e.rows, c2: e.cols }
    }
    const cells = (ref.r2 - ref.r1 + 1) * (ref.c2 - ref.c1 + 1)
    if (cells > MAX_CELLS) throw new Error(`${rangeText(ref)} has ${cells} cells; read at most ${MAX_CELLS} at a time`)
    const values = []
    const formulas = []
    for (let r = ref.r1; r <= ref.r2; r++) {
      const v = []
      const f = []
      for (let c = ref.c1; c <= ref.c2; c++) {
        v.push(m.getFormattedCellValue(ref.sh.at, r, c))
        f.push(m.getCellContent(ref.sh.at, r, c))
      }
      values.push(v)
      formulas.push(f)
    }
    return { sheets, sheet: ref.sh.name, range: rangeText(ref), values, formulas, csv: toCsv(values) }
  }),

  // Values are typed into cells as a person would type them: "=SUM(A1:A3)"
  // is a formula, "12" a number. null leaves a cell as it is, "" empties it.
  'sheet.write': (args) => open(args, (m) => {
    const sh = pick(m, args.sheet)
    if (args.clear != null) {
      const ref = area(m, arg(args, 'clear', 'string'), sh, 'clear')
      m.rangeClearContents(ref.sh.at, ref.r1, ref.c1, ref.r2, ref.c2)
      return written(m)
    }
    const at = area(m, arg(args, 'start', 'string'), sh, 'start')
    const rows = args.csv != null ? parseCsv(arg(args, 'csv', 'string')) : arg(args, 'values', 'array')
    if (rows.some((row) => !Array.isArray(row))) throw new Error('values must be an array of rows, each an array')
    if (at.r1 + rows.length - 1 > 1048576 || at.c1 + Math.max(0, ...rows.map((row) => row.length)) - 1 > 16384) throw new Error('Those values run past the edge of the sheet')
    rows.forEach((row, i) => row.forEach((v, j) => {
      const r = at.r1 + i
      const c = at.c1 + j
      if (v === null) return
      if (v === '') m.rangeClearContents(at.sh.at, r, c, r, c)
      else m.setUserInput(at.sh.at, r, c, cellInput(v, r, c))
    }))
    return written(m)
  }),

  'sheet.addSheet': (args) => open(args, (m) => {
    const name = arg(args, 'name', 'string').trim()
    if (!name) throw new Error('name must not be empty')
    if (m.getWorksheetsProperties().some((sh) => sh.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a sheet called ${JSON.stringify(name)}`)
    addSheet(m, name)
    return written(m)
  }),

  'sheet.xlsx': (args) => open(args, (m) => ({ xlsx: toB64(toXlsx(m)) })),

  'sheet.fromXlsx': (args) => snapshotted(xlsxSnapshot(fromB64(arg(args, 'xlsx', 'string')), arg(args, 'name', 'string', true) || 'Workbook')),

  'sheet.fromCsv': (args) => snapshotted(csvSnapshot(arg(args, 'csv', 'string'), arg(args, 'name', 'string', true) || 'Workbook')),
}
