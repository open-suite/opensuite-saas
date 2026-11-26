// Turning a .csv file into a spreadsheet.
import { Model } from '@ironcalc/wasm-xlsx'

// parseCsv reads comma- or semicolon-separated text with quoted fields.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const head = text.slice(0, text.indexOf('\n') + 1 || text.length)
  const sep = head.split(';').length > head.split(',').length ? ';' : head.split('\t').length > head.split(',').length ? '\t' : ','
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === sep) { row.push(cell); cell = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

// toCsv writes rows of text as comma-separated values.
export function toCsv(rows) {
  const field = (v) => (/[",\r\n]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)
  return rows.map((row) => row.map(field).join(',')).join('\r\n')
}

// csvSnapshot builds a workbook in the spreadsheet engine's own format. The
// engine must already be loaded.
export function csvSnapshot(text, name) {
  const m = new Model(name || 'Workbook', 'en', 'UTC', 'en')
  const rows = parseCsv(text)
  for (let r = 0; r < rows.length && r < 100000; r++) {
    for (let c = 0; c < rows[r].length && c < 1000; c++) {
      if (rows[r][c] !== '') m.setUserInput(0, r + 1, c + 1, rows[r][c])
    }
  }
  const out = m.toBytes()
  m.free()
  return out
}
