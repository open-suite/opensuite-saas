// Spreadsheet changes for the API (sheet.ops): everything the menus do, as a
// list of operations applied to the workbook in order and sent as one edit.
// Each takes `sheet` (name or 0-based index among the visible sheets; default
// the request's, else the first). Ranges are A1 notation ("B2:D9",
// "Sheet2!A1:C5"); columns are letters ("C").
import { addSheet, colName } from '../apps/sheet-data.js'
import { parseRange } from '../apps/sheet-charts.js'
import {
  setFilter, removeFilter, addMeta, readMeta, removeMeta, updateMeta, setValidation, clearValidation, setWrapping, sortRange, replaceAll,
  visibleSheets, addPivot, updatePivot, sheetById, setup, pivotFns, condOps, MAXR, MAXC,
} from '../apps/sheet-meta.js'

// The sheets people see, with their position in the workbook (`at`) and
// among the visible ones (`index`).
export const visible = (m) => m.getWorksheetsProperties().map((sh, at) => ({ ...sh, at })).filter((sh) => sh.state === 'visible').map((sh, index) => ({ ...sh, index }))

const names = (m) => visible(m).map((sh) => JSON.stringify(sh.name)).join(', ')

// pick finds a sheet by name or by its position among the visible ones; none
// given is the first.
export function pick(m, which) {
  const shown = visible(m)
  const sh = which == null ? shown[0]
    : typeof which === 'number' ? shown[which]
      : typeof which === 'string' ? shown.find((s) => s.name === which) || shown.find((s) => s.name.toLowerCase() === which.toLowerCase())
        : null
  if (!sh) throw new Error(`No sheet ${JSON.stringify(which)}. The sheets are ${names(m)}`)
  return sh
}

// area reads "B2", "A1:C9", "Sheet2!A1:C9", or whole columns or rows ("A:C",
// "2:5") on sheet `sh` unless it names another one.
export function area(m, text, sh, key) {
  let t = String(text ?? '')
  const cols = /^(.*!)?\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(t)
  const rows = /^(.*!)?\$?(\d+):\$?(\d+)$/.exec(t)
  if (cols) t = `${cols[1] || ''}${cols[2]}1:${cols[3]}${MAXR}`
  else if (rows) t = `${rows[1] || ''}A${rows[2]}:${colName(MAXC)}${rows[3]}`
  const ref = parseRange(m, t, sh.at)
  if (!ref) throw new Error(`${key} must be a cell or range such as "B2" or "A1:C9", not ${JSON.stringify(text)}`)
  const on = visible(m).find((s) => s.at === ref.sheet)
  if (!on) throw new Error(`No sheet in ${JSON.stringify(text)}. The sheets are ${names(m)}`)
  return { ...ref, sh: on }
}

const colIndex = (name, key) => {
  if (typeof name !== 'string' || !/^[A-Za-z]{1,3}$/.test(name)) throw new Error(`${key} must be a column letter such as "C", not ${JSON.stringify(name)}`)
  return [...name.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
}

const need = (v, key, type) => {
  if (v == null || (type === 'array' ? !Array.isArray(v) : typeof v !== type)) throw new Error(`${key} must be a${type === 'array' ? 'n array' : ' ' + type}`)
  return v
}

const areaArg = (ref) => ({ sheet: ref.sheet, row: ref.r1, column: ref.c1, width: ref.c2 - ref.c1 + 1, height: ref.r2 - ref.r1 + 1 })

// criteria in the API name columns by letter; inside, by number.
function criteriaIn(c, key) {
  const out = {}
  for (const [col, v] of Object.entries(c || {})) {
    const n = colIndex(col, `${key} column`)
    const cond = v?.condition
    if (cond && !condOps[cond.op]) throw new Error(`${key}.${col}.condition.op must be one of ${Object.keys(condOps).join(', ')}`)
    out[n] = { hidden: Array.isArray(v?.hidden) ? v.hidden.map(String) : undefined, cond: cond ? { op: cond.op, a: cond.a ?? cond.value, b: cond.b } : undefined }
  }
  return out
}

const borders = { all: 'All', outer: 'Outer', bottom: 'Bottom', top: 'Top', left: 'Left', right: 'Right', inner: 'Inner', none: 'None' }
const aligns = ['left', 'center', 'right', 'general']
const valigns = { top: 'top', middle: 'center', center: 'center', bottom: 'bottom' }

function format(m, ref, op) {
  const a = areaArg(ref)
  const set = (path, v) => m.updateRangeStyle(a, path, String(v))
  if (op.bold != null) set('font.b', !!op.bold)
  if (op.italic != null) set('font.i', !!op.italic)
  if (op.underline != null) set('font.u', !!op.underline)
  if (op.strikethrough != null) set('font.strike', !!op.strikethrough)
  if (op.size != null) set('font.size', need(op.size, 'size', 'number'))
  if (op.color != null) set('font.color', op.color || '#000000')
  if (op.fill != null) set('fill.color', op.fill || '')
  if (op.numberFormat != null) set('num_fmt', need(op.numberFormat, 'numberFormat', 'string'))
  if (op.align != null) {
    if (!aligns.includes(op.align)) throw new Error(`align must be one of ${aligns.join(', ')}`)
    set('alignment.horizontal', op.align)
  }
  if (op.valign != null) {
    if (!valigns[op.valign]) throw new Error('valign must be top, middle or bottom')
    set('alignment.vertical', valigns[op.valign])
  }
  if (op.wrap != null) {
    if (!['overflow', 'wrap', 'clip'].includes(op.wrap)) throw new Error('wrap must be overflow, wrap or clip')
    setWrapping(m, ref, op.wrap)
  }
  if (op.borders != null) {
    if (!borders[op.borders]) throw new Error(`borders must be one of ${Object.keys(borders).join(', ')}`)
    m.setAreaWithBorder(a, { item: { style: 'thin', color: op.borderColor || '#000000' }, type: borders[op.borders] })
  }
  if (op.font !== undefined) {
    // The engine has no style path for the font name: each cell's style is rewritten.
    const r2 = Math.min(ref.r2, ref.r1 + 5000)
    const c2 = Math.min(ref.c2, ref.c1 + 200)
    const styles = []
    for (let r = ref.r1; r <= r2; r++) {
      const row = []
      for (let c = ref.c1; c <= c2; c++) {
        const st = m.getCellStyle(ref.sheet, r, c).style
        st.font = { ...st.font, name: op.font || 'Calibri', scheme: op.font ? 'none' : 'minor' }
        row.push(st)
      }
      styles.push(row)
    }
    m.setSelectedSheet(ref.sheet)
    m.setSelectedCell(ref.r1, ref.c1)
    m.setSelectedRange(ref.r1, ref.c1, r2, c2)
    m.onPasteStyles(styles)
  }
}

const sizeRange = (m, text, sh, key, cols) => {
  const ref = area(m, text, sh, key)
  return cols ? [ref.c1, Math.min(ref.c2, MAXC)] : [ref.r1, Math.min(ref.r2, MAXR)]
}

// The pivot fields the API names by column letter.
function pivotIn(op) {
  const fns = Object.keys(pivotFns)
  const values = (op.values || []).map((v, i) => {
    if (!fns.includes(v.fn || 'SUM')) throw new Error(`values[${i}].fn must be one of ${fns.join(', ')}`)
    return { col: colIndex(v.column, `values[${i}].column`), fn: v.fn || 'SUM' }
  })
  const filters = {}
  for (const [c, h] of Object.entries(op.filters || {})) filters[colIndex(c, 'filters column')] = need(h, `filters.${c}`, 'array').map(String)
  return {
    rows: (op.rows || []).map((c, i) => colIndex(c, `rows[${i}]`)),
    cols: (op.columns || []).slice(0, 1).map((c, i) => colIndex(c, `columns[${i}]`)),
    values,
    filters,
  }
}

const findPivot = (m, id) => {
  const p = readMeta(m, 'pivot').find((x) => x.id === id)
  if (!p) throw new Error(`No pivot table ${JSON.stringify(id)}; get_sheet_setup lists them`)
  return p
}

// applyOp makes one change. Returns something for the caller to know (a new
// id, a count) or null.
export function applyOp(m, op, dflt) {
  if (!op || typeof op !== 'object') throw new Error('each op must be an object')
  const sh = pick(m, op.sheet ?? dflt)
  const s = sh.at
  const rangeOf = (key = 'range') => area(m, need(op[key], key, 'string'), sh, key)
  switch (op.op) {
    case 'format':
      format(m, rangeOf(), op)
      return null
    case 'clearFormatting': {
      const r = rangeOf()
      m.rangeClearFormatting(r.sheet, r.r1, r.c1, r.r2, r.c2)
      return null
    }
    case 'merge':
      m.mergeCells(areaArg(rangeOf()))
      return null
    case 'unmerge':
      m.unmergeCells(areaArg(rangeOf()))
      return null
    case 'freeze':
      if (op.rows != null) m.setFrozenRowsCount(s, Math.max(0, need(op.rows, 'rows', 'number')))
      if (op.columns != null) m.setFrozenColumnsCount(s, Math.max(0, need(op.columns, 'columns', 'number')))
      return null
    case 'resize': {
      if (op.columns != null) {
        const [a, b] = sizeRange(m, op.columns, sh, 'columns', true)
        m.setColumnsWidth(s, a, b, Math.max(12, need(op.width, 'width', 'number')))
      }
      if (op.rows != null) {
        const [a, b] = sizeRange(m, op.rows, sh, 'rows', false)
        m.setRowsHeight(s, a, b, Math.max(8, need(op.height, 'height', 'number')))
      }
      return null
    }
    case 'insertRows':
      m.insertRows(s, need(op.at, 'at', 'number'), op.count || 1)
      return null
    case 'deleteRows':
      m.deleteRows(s, need(op.at, 'at', 'number'), op.count || 1)
      return null
    case 'insertColumns':
      m.insertColumns(s, colIndex(op.at, 'at'), op.count || 1)
      return null
    case 'deleteColumns':
      m.deleteColumns(s, colIndex(op.at, 'at'), op.count || 1)
      return null
    case 'renameSheet': {
      const name = need(op.name, 'name', 'string').trim()
      if (!name) throw new Error('name must not be empty')
      m.renameSheet(s, name)
      return null
    }
    case 'deleteSheet':
      if (visible(m).length < 2) throw new Error('A workbook keeps at least one sheet')
      m.deleteSheet(s)
      return null
    case 'addSheet':
      addSheet(m, need(op.name, 'name', 'string').trim())
      return null
    case 'sort': {
      const r = rangeOf()
      const by = need(op.by, 'by', 'array').map((k, i) => ({ col: colIndex(k.column, `by[${i}].column`), desc: !!k.desc }))
      return { moved: sortRange(m, r, by, !!op.header) }
    }
    case 'filter':
      setFilter(m, s, rangeOf(), criteriaIn(op.criteria, 'criteria'))
      return null
    case 'removeFilter':
      removeFilter(m, s)
      return null
    case 'addFilterView':
      return { id: addMeta(m, { kind: 'view', name: op.name || 'Filter view', owner: '', ownerName: op.owner || '', criteria: criteriaIn(op.criteria, 'criteria') }, rangeOf()) }
    case 'removeFilterView': {
      const v = readMeta(m, 'view').find((x) => x.id === op.id)
      if (!v) throw new Error(`No filter view ${JSON.stringify(op.id)}`)
      removeMeta(m, v)
      return null
    }
    case 'conditionalFormat': {
      const r = rangeOf()
      const rule = need(op.rule, 'rule', 'object')
      const range = `${colName(r.c1)}${r.r1}:${colName(r.c2)}${r.r2}`
      if (op.index != null) m.updateConditionalFormatting(r.sheet, op.index, range, rule)
      else m.addConditionalFormatting(r.sheet, range, rule)
      return null
    }
    case 'removeConditionalFormat':
      m.deleteConditionalFormatting(s, need(op.index, 'index', 'number'))
      return null
    case 'validation': {
      const rule = need(op.rule, 'rule', 'object')
      if (!['list', 'range', 'checkbox', 'number', 'text'].includes(rule.type)) throw new Error('rule.type must be list, range, checkbox, number or text')
      return { id: setValidation(m, rangeOf(), rule, op.strict !== false, op.help || '') }
    }
    case 'clearValidation':
      clearValidation(m, rangeOf())
      return null
    case 'pivot': {
      const src = rangeOf('source')
      const made = addPivot(m, src, pivotIn(op))
      return { id: made.id, sheet: made.name }
    }
    case 'updatePivot': {
      const p = findPivot(m, op.id)
      if (op.source) updateMeta(m, p, {}, area(m, op.source, sh, 'source'))
      const fresh = findPivot(m, op.id)
      const cfg = pivotIn({ rows: op.rows ?? fresh.rows.map(colName), columns: op.columns ?? (fresh.cols || []).map(colName), values: op.values ?? fresh.values.map((v) => ({ column: colName(v.col), fn: v.fn })), filters: op.filters ?? Object.fromEntries(Object.entries(fresh.filters || {}).map(([c, h]) => [colName(+c), h])) })
      updatePivot(m, fresh, cfg)
      return null
    }
    case 'removePivot': {
      const p = findPivot(m, op.id)
      const at = sheetById(m, p.target)
      removeMeta(m, p)
      if (op.deleteSheet !== false && at >= 0 && visible(m).length > 1) m.deleteSheet(at)
      return null
    }
    case 'replace': {
      const sheets = op.allSheets ? visibleSheets(m) : [s]
      return { replaced: replaceAll(m, { find: need(op.find, 'find', 'string'), replace: op.replace ?? '', matchCase: !!op.matchCase, wholeCell: !!op.wholeCell, regex: !!op.regex, formulas: !!op.formulas }, sheets) }
    }
  }
  throw new Error('op must be one of format, clearFormatting, merge, unmerge, freeze, resize, insertRows, deleteRows, insertColumns, deleteColumns, addSheet, renameSheet, deleteSheet, sort, filter, removeFilter, addFilterView, removeFilterView, conditionalFormat, removeConditionalFormat, validation, clearValidation, pivot, updatePivot, removePivot, replace')
}

export const setupOf = (m) => setup(m)
