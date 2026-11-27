// Excel files in and out. The engine reads and writes cells, styles, frozen
// panes, conditional formatting and column widths itself; filters and data
// validation live in our hidden sheet (sheet-meta.js), so they are added to
// the file's XML on the way out and read from it on the way in. Shared with
// the server's headless engine.
import JSZip from 'jszip'
import { Model } from '@ironcalc/wasm-xlsx'
import { chartSheetsOf } from './sheet-charts.js'
import { colName, extent } from './sheet-data.js'
import { metaSheets, readMeta, hiddenRows, columnValues, setFilter, setValidation, filterRange, MAXR } from './sheet-meta.js'
import { parseRange } from './sheet-charts.js'

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const cells = (ref) => `${colName(ref.c1)}${ref.r1}:${colName(ref.c2)}${ref.r2}`
const quoted = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)

// Where each sheet's XML is in the package, by sheet name.
async function sheetFiles(zip) {
  const wb = await zip.file('xl/workbook.xml')?.async('string')
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!wb || !rels) return new Map()
  const targets = new Map()
  for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(r[0])?.[1]
    const t = /\bTarget="([^"]+)"/.exec(r[0])?.[1]
    if (id && t) targets.set(id, t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''))
  }
  const out = new Map()
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(s[0])?.[1]
    const rid = /\br:id="([^"]+)"/.exec(s[0])?.[1] || /\bid="([^"]+)"/.exec(s[0])?.[1]
    if (name != null && targets.has(rid)) out.set(unxml(name), targets.get(rid))
  }
  return out
}

const cfOps = { gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', eq: 'equal', ne: 'notEqual' }

function autoFilterXml(m, f) {
  const cols = []
  for (const [col, c] of Object.entries(f.criteria || {})) {
    const id = +col - f.ref.c1
    if (id < 0 || +col > f.ref.c2) continue
    let inner = ''
    if (c.hidden?.length) {
      const shown = columnValues(m, f, +col).filter((v) => !c.hidden.includes(v.text))
      inner = `<filters${shown.some((v) => v.text === '') ? ' blank="1"' : ''}>${shown.filter((v) => v.text !== '').map((v) => `<filter val="${xml(v.text)}"/>`).join('')}</filters>`
    } else if (c.cond?.op) {
      const { op, a = '', b = '' } = c.cond
      const one = (o, v) => `<customFilter${o ? ` operator="${o}"` : ''} val="${xml(v)}"/>`
      if (op === 'empty') inner = '<filters blank="1"/>'
      else if (op === 'notEmpty') inner = `<customFilters>${one('notEqual', ' ')}</customFilters>`
      else if (op === 'contains') inner = `<customFilters>${one('', `*${a}*`)}</customFilters>`
      else if (op === 'notContains') inner = `<customFilters>${one('notEqual', `*${a}*`)}</customFilters>`
      else if (op === 'starts') inner = `<customFilters>${one('', `${a}*`)}</customFilters>`
      else if (op === 'ends') inner = `<customFilters>${one('', `*${a}`)}</customFilters>`
      else if (op === 'is') inner = `<customFilters>${one('', a)}</customFilters>`
      else if (op === 'between') inner = `<customFilters and="1">${one('greaterThanOrEqual', a)}${one('lessThanOrEqual', b)}</customFilters>`
      else if (cfOps[op]) inner = `<customFilters>${one(cfOps[op], a)}</customFilters>`
    }
    if (inner) cols.push(`<filterColumn colId="${id}">${inner}</filterColumn>`)
  }
  return `<autoFilter ref="${cells(filterRange(m, f))}">${cols.join('')}</autoFilter>`
}

const dvOps = { between: 'between', gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', eq: 'equal', ne: 'notEqual' }

function validationXml(m, v) {
  const r = v.rule
  const base = `allowBlank="1" showErrorMessage="1" errorStyle="${v.strict ? 'stop' : 'warning'}"${v.help ? ` showInputMessage="1" prompt="${xml(v.help)}"` : ''} sqref="${cells(v.ref)}"`
  const f = (s) => `<formula1>${xml(s)}</formula1>`
  const first = `${colName(v.ref.c1)}${v.ref.r1}`
  switch (r.type) {
    case 'list': return `<dataValidation type="list" ${base}>${f(`"${(r.values || []).filter(Boolean).join(',').replace(/"/g, '""')}"`)}</dataValidation>`
    case 'range': {
      const ref = parseRange(m, r.source, v.ref.sheet)
      if (!ref) return ''
      return `<dataValidation type="list" ${base}>${f(`${quoted(m.getWorksheetsProperties()[ref.sheet].name)}!$${colName(ref.c1)}$${ref.r1}:$${colName(ref.c2)}$${ref.r2}`)}</dataValidation>`
    }
    case 'checkbox': return `<dataValidation type="list" ${base}>${f('"TRUE,FALSE"')}</dataValidation>`
    case 'number': {
      const op = dvOps[r.op] || 'between'
      return `<dataValidation type="decimal" operator="${op}" ${base}>${f(r.a ?? '')}${op === 'between' ? `<formula2>${xml(r.b ?? '')}</formula2>` : ''}</dataValidation>`
    }
    case 'text': {
      const a = String(r.a ?? '').replace(/"/g, '""')
      const test = r.op === 'is' ? `EXACT(${first},"${a}")` : `${r.op === 'notContains' ? 'NOT(' : ''}ISNUMBER(SEARCH("${a}",${first}))${r.op === 'notContains' ? ')' : ''}`
      return `<dataValidation type="custom" ${base}>${f(test)}</dataValidation>`
    }
  }
  return ''
}

const AFTER_DV = /<(hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/
const AFTER_AF = /<(sortState|dataConsolidate|customSheetViews|mergeCells|phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|drawing|legacyDrawing|tableParts|extLst)\b|<\/worksheet>/

function insertBefore(text, re, add) {
  const at = text.search(re)
  return at < 0 ? text : text.slice(0, at) + add + text.slice(at)
}

// exportXlsx is the workbook as Excel should see it: without our hidden
// sheets, with filters (rows hidden as they are here) and data validation.
export async function exportXlsx(model) {
  const copy = Model.fromBytes(model.toBytes(), 'en')
  let bytes
  const extra = new Map() // sheet name -> { filter, validations }
  try {
    const props = copy.getWorksheetsProperties()
    for (const item of readMeta(copy)) {
      if (!item.ref || (item.kind !== 'filter' && item.kind !== 'validation')) continue
      const name = props[item.ref.sheet]?.name
      if (name == null || props[item.ref.sheet].state !== 'visible') continue
      const e = extra.get(name) || { filter: null, validations: [] }
      if (item.kind === 'filter') {
        e.filter = { xml: autoFilterXml(copy, item), ref: item.ref, hidden: hiddenRows(copy, item) }
      } else e.validations.push(validationXml(copy, item))
      extra.set(name, e)
    }
    for (const e of extra.values()) {
      for (const r of e.filter?.hidden || []) copy.setRowsHidden(e.filter.ref.sheet, r, r, true)
    }
    const drop = [...new Set([...chartSheetsOf(copy), ...metaSheets(copy)])].sort((a, b) => b - a)
    for (const i of drop) copy.deleteSheet(i)
    bytes = copy.toXlsx()
  } finally {
    copy.free()
  }
  if (!extra.size) return bytes
  const zip = await JSZip.loadAsync(bytes)
  const files = await sheetFiles(zip)
  for (const [name, e] of extra) {
    const path = files.get(name)
    const file = path && zip.file(path)
    if (!file) continue
    let text = await file.async('string')
    if (e.filter) text = insertBefore(text, AFTER_AF, e.filter.xml)
    const dv = e.validations.filter(Boolean)
    if (dv.length) text = insertBefore(text, AFTER_DV, `<dataValidations count="${dv.length}">${dv.join('')}</dataValidations>`)
    zip.file(path, text)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

// --- reading -----------------------------------------------------------------

const attr = (tag, name) => {
  const v = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
  return v == null ? null : unxml(v)
}

function parseArea(m, sheet, text) {
  const first = String(text).trim().split(/\s+/)[0]
  const ref = parseRange(m, first, sheet)
  return ref && ref.sheet === sheet ? ref : null
}

const fromCfOp = Object.fromEntries(Object.entries(cfOps).map(([k, v]) => [v, k]))

// importFilters reads filters and data validation from an Excel file into a
// workbook just made from it (Model.fromXlsx).
export async function importExtras(m, bytes) {
  let zip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return
  }
  const files = await sheetFiles(zip)
  const props = m.getWorksheetsProperties()
  for (const [name, path] of files) {
    const sheet = props.findIndex((p) => p.name === name)
    if (sheet < 0) continue
    const text = await zip.file(path)?.async('string')
    if (!text) continue
    const af = /<autoFilter\b[^>]*?(?:\/>|>([\s\S]*?)<\/autoFilter>)/.exec(text)
    if (af) {
      const ref = parseArea(m, sheet, attr(af[0], 'ref') || '')
      if (ref) {
        const criteria = {}
        for (const fc of (af[1] || '').matchAll(/<filterColumn\b[^>]*>([\s\S]*?)<\/filterColumn>/g)) {
          const col = ref.c1 + Number(attr(fc[0], 'colId') || 0)
          const body = fc[1]
          if (/<filters\b/.test(body)) {
            const keep = new Set([...body.matchAll(/<filter\b[^>]*\/?>/g)].map((x) => attr(x[0], 'val') ?? ''))
            if (/<filters\b[^>]*blank="(1|true)"/.test(body)) keep.add('')
            const all = columnValues(m, { ref }, col)
            criteria[col] = { hidden: all.map((v) => v.text).filter((t) => !keep.has(t)) }
          } else {
            const cfs = [...body.matchAll(/<customFilter\b[^>]*\/?>/g)].map((x) => ({ op: attr(x[0], 'operator') || 'equal', val: attr(x[0], 'val') ?? '' }))
            if (cfs.length === 2 && cfs[0].op === 'greaterThanOrEqual' && cfs[1].op === 'lessThanOrEqual') criteria[col] = { cond: { op: 'between', a: cfs[0].val, b: cfs[1].val } }
            else if (cfs.length) {
              const { op, val } = cfs[0]
              const star = /^\*(.*)\*$/.exec(val)
              const cond = op === 'notEqual' && val === ' ' ? { op: 'notEmpty' }
                : star ? { op: op === 'notEqual' ? 'notContains' : 'contains', a: star[1] }
                  : op === 'equal' && val.endsWith('*') ? { op: 'starts', a: val.slice(0, -1) }
                    : op === 'equal' && val.startsWith('*') ? { op: 'ends', a: val.slice(1) }
                      : fromCfOp[op] ? { op: fromCfOp[op], a: val } : null
              if (cond) criteria[col] = { cond }
            }
          }
        }
        // The engine kept the file's hidden rows; our filter decides now.
        const e = extent(m, sheet)
        if (e.rows > ref.r1) m.setRowsHidden(sheet, ref.r1 + 1, Math.min(MAXR, Math.max(ref.r2, e.rows)), false)
        setFilter(m, sheet, ref, criteria)
      }
    }
    for (const dv of text.matchAll(/<dataValidation\b[^>]*?(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
      const tag = dv[0].slice(0, dv[0].indexOf('>') + 1)
      const ref = parseArea(m, sheet, attr(tag, 'sqref') || '')
      if (!ref) continue
      const f1 = unxml(/<formula1>([\s\S]*?)<\/formula1>/.exec(dv[1] || '')?.[1] || '')
      const f2 = unxml(/<formula2>([\s\S]*?)<\/formula2>/.exec(dv[1] || '')?.[1] || '')
      const type = attr(tag, 'type')
      const strict = (attr(tag, 'errorStyle') || 'stop') === 'stop'
      const help = attr(tag, 'prompt') || ''
      let rule = null
      if (type === 'list') {
        if (/^".*"$/.test(f1)) {
          const values = f1.slice(1, -1).replace(/""/g, '"').split(',')
          rule = values.length === 2 && values.every((v) => /^(true|false)$/i.test(v)) ? { type: 'checkbox' } : { type: 'list', values }
        } else rule = { type: 'range', source: f1.replace(/\$/g, '') }
      } else if (type === 'decimal' || type === 'whole') {
        const op = Object.entries(dvOps).find(([, v]) => v === (attr(tag, 'operator') || 'between'))?.[0] || 'between'
        rule = { type: 'number', op, a: f1, b: f2 }
      }
      if (rule) setValidation(m, ref, rule, strict, help)
    }
  }
}

// importXlsx converts an Excel file to the engine's own format, with its
// filters and data validation.
export async function importXlsx(bytes, name, tz) {
  let m
  try {
    m = Model.fromXlsx(bytes, name, 'en', tz || 'UTC', 'en')
  } catch {
    m = Model.fromXlsx(bytes, name, 'en', 'UTC', 'en')
  }
  try {
    await importExtras(m, bytes)
    return m.toBytes()
  } finally {
    m.free()
  }
}
