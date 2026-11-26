// What a workbook is apart from the screen: building one, replaying its log,
// naming its columns and reading it as text. The spreadsheet controller
// (sheet-core.js) and the server's headless engine (src/headless/) share it.
// The calculation engine must already be loaded; each caller loads it its
// own way.
import { Model } from '@ironcalc/wasm-xlsx'

const tz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

export function blank(name) {
  try {
    return new Model(name || 'Workbook', 'en', tz, 'en')
  } catch {
    return new Model(name || 'Workbook', 'en', 'UTC', 'en')
  }
}

// applyDiff plays one change from the log. A diff the engine refuses is
// skipped, as every participant skips it, so all still agree.
export function applyDiff(m, diff) {
  try {
    m.applyExternalDiffs(diff)
  } catch (e) {
    console.warn('sheet: diff rejected', e)
  }
}

// loadModel builds a workbook from { base, updates }: a snapshot and the
// diffs after it, in server order.
export function loadModel(state, name) {
  const m = state.base.length ? Model.fromBytes(state.base, 'en') : blank(name)
  for (const u of state.updates) applyDiff(m, u)
  return m
}

// xlsxSnapshot converts an Excel workbook to the engine's own format.
export function xlsxSnapshot(bytes, name) {
  let m
  try {
    m = Model.fromXlsx(bytes, name, 'en', tz, 'en')
  } catch {
    m = Model.fromXlsx(bytes, name, 'en', 'UTC', 'en')
  }
  const out = m.toBytes()
  m.free()
  return out
}

export function colName(c) {
  let s = ''
  while (c > 0) {
    c--
    s = String.fromCharCode(65 + (c % 26)) + s
    c = Math.floor(c / 26)
  }
  return s
}

// addSheet appends a sheet. The engine numbers a new sheet by counting every
// sheet, hidden ones included; people count the tabs they can see.
export function addSheet(m, name) {
  m.newSheet()
  const all = m.getWorksheetsProperties()
  name ||= 'Sheet' + all.filter((sh) => sh.state === 'visible').length
  if (!all.some((sh) => sh.name === name)) m.renameSheet(all.length - 1, name)
}

// sheetText is the workbook as plain text, for the search index. Hidden
// sheets (where charts are stored) are left out.
export function sheetText(m) {
  const lines = []
  let size = 0
  m.getWorksheetsProperties().forEach((ws, s) => {
    if (ws.state && ws.state !== 'visible') return
    lines.push(ws.name)
    const rows = new Set()
    for (let c = 1; c <= 60; c++) for (const r of m.getRowsWithData(s, c)) rows.add(r)
    for (const r of [...rows].sort((a, b) => a - b)) {
      if (size > 400000) return
      const line = [...m.getColumnsWithData(s, r)].sort((a, b) => a - b).map((c) => m.getFormattedCellValue(s, r, c)).filter(Boolean).join(' ')
      size += line.length
      if (line) lines.push(line)
    }
  })
  return lines.join('\n')
}
