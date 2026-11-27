// Spreadsheets, through the same engine and helpers as the spreadsheet
// screen (apps/sheet-data.js, apps/sheet-meta.js, apps/sheet-xlsx.js). A
// write is one engine diff, made on the workbook as the server's log has it,
// exactly like an edit in the browser; the server orders it with everyone
// else's. Hidden sheets (where charts, filters and the like are kept) are
// never shown or written as cells.
import { Model } from '@ironcalc/wasm-xlsx'
import { loadModel, addSheet, sheetText, colName, extent, timezone } from '../apps/sheet-data.js'
import { exportXlsx, importXlsx } from '../apps/sheet-xlsx.js'
import { refreshPivots, readMeta } from '../apps/sheet-meta.js'
import { applyOp, setupOf, visible, pick, area } from './sheet-ops.js'
import { parseCsv, toCsv, csvSnapshot } from '../lib/csv.js'
import { arg, frames, fromB64, toB64 } from './wire.js'

const MAX_CELLS = 200000

function open(args, fn) {
  const m = loadModel(frames(args))
  let out
  try {
    out = fn(m)
  } catch (e) {
    m.free()
    throw e
  }
  if (out && typeof out.then === 'function') return out.finally(() => m.free())
  m.free()
  return out
}

const rangeText = (r) => `${colName(r.c1)}${r.r1}:${colName(r.c2)}${r.r2}`

// cellInput turns a value into what typing it in the cell would be.
function cellInput(v, r, c) {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (Number.isFinite(v)) return String(v)
  throw new Error(`The value for ${colName(c)}${r} must be a string, number, boolean or null`)
}

// written ends a write: the diff it made and the new search text. Pivot
// tables are brought up to date first, as the spreadsheet screen does.
function written(m) {
  if (readMeta(m, 'pivot').length) refreshPivots(m)
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

  // Everything about the sheets beyond their cells: frozen panes, filters,
  // filter views, conditional formatting, data validation, pivot tables.
  'sheet.setup': (args) => open(args, (m) => ({ sheets: setupOf(m) })),

  // A list of changes made as one edit; see sheet-ops.js for what each does.
  'sheet.ops': (args) => open(args, (m) => {
    const ops = arg(args, 'ops', 'array')
    const results = ops.map((op, i) => {
      try {
        return applyOp(m, op, args.sheet == null ? undefined : args.sheet)
      } catch (e) {
        throw new Error(`ops[${i}] (${op?.op || 'no op'}): ${e.message}`)
      }
    })
    return { ...written(m), results }
  }),

  'sheet.xlsx': (args) => open(args, async (m) => ({ xlsx: toB64(await exportXlsx(m)) })),

  'sheet.fromXlsx': async (args) => snapshotted(await importXlsx(fromB64(arg(args, 'xlsx', 'string')), arg(args, 'name', 'string', true) || 'Workbook', timezone)),

  'sheet.fromCsv': (args) => snapshotted(csvSnapshot(arg(args, 'csv', 'string'), arg(args, 'name', 'string', true) || 'Workbook')),
}
