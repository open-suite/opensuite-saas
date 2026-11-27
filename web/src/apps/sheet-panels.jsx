// The spreadsheet's dialogs and side panels: filter menus, dropdown lists,
// sorting, data validation, conditional formatting, pivot tables, find and
// replace, row and column sizes, and the bar of an open filter view. Each
// change is one action on the controller (Sheet.act), so it syncs and undoes
// as a whole.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { X, Trash2, Plus, Link2, Crosshair, ArrowDownAZ, ArrowUpZA, Filter, Pencil } from 'lucide-preact'
import { Button, Field, IconButton, Modal, Swatches, inkColors, markColors } from '../ui.jsx'
import { cx } from '../lib/util.js'
import { colName } from './sheet-data.js'
import { parseRange, rangeText } from './sheet-charts.js'
import { TextField } from './charts.jsx'
import {
  readMeta, updateMeta, addMeta, removeMeta, setFilter, sortRange, columnValues, condOps, dataBlock, setValidation, clearValidation,
  describeRule, findAll, replaceAll, visibleSheets, addPivot, updatePivot, pivotFns, sheetById, MAXR, MAXC,
} from './sheet-meta.js'
import './sheet-panels.css'

const Check = ({ label, checked, onChange }) => (
  <label class="chart-check"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>
)

// A small panel floating over the grid at a cell, closed by a click outside or Escape.
function Floating({ rect, width = 280, onClose, children, label }) {
  const ref = useRef()
  const [pos, setPos] = useState({ left: rect.x + rect.w - width, top: rect.y + rect.h + 2 })
  useLayoutEffect(() => {
    const el = ref.current
    const box = el.parentElement.getBoundingClientRect()
    let left = Math.max(48, Math.min(rect.x + rect.w - width, box.width - width - 8))
    let top = rect.y + rect.h + 2
    if (top + el.offsetHeight > box.height - 8) top = Math.max(26, rect.y - el.offsetHeight - 2)
    setPos({ left, top })
  }, [rect.x, rect.y])
  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && onClose()
    const key = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    addEventListener('pointerdown', off, true)
    addEventListener('keydown', key, true)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('keydown', key, true)
    }
  }, [onClose])
  return <div ref={ref} class="menu sp-float" role="dialog" aria-label={label} style={{ left: pos.left, top: pos.top, width }}>{children}</div>
}

// --- filter heading menu ----------------------------------------------------

export function FilterMenu({ s, col, rect, onClose }) {
  const f = s.filter
  const crit = f?.criteria?.[col] || {}
  const values = f ? columnValues(s.model, f, col) : []
  const [hidden, setHidden] = useState(new Set(crit.hidden || []))
  const [cond, setCond] = useState(crit.cond || { op: '' })
  const [q, setQ] = useState('')
  if (!f) return null
  const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()))
  const apply = () => {
    const criteria = { ...(f.criteria || {}), [col]: { hidden: [...hidden], cond: cond.op ? cond : undefined } }
    s.act((m) => updateMeta(m, f, { criteria }))
    onClose()
  }
  const sort = (desc) => {
    s.act((m) => sortRange(m, f.ref, [{ col, desc }], true))
    onClose()
  }
  const two = cond.op === 'between'
  const needs = cond.op && !['empty', 'notEmpty'].includes(cond.op)
  return (
    <Floating rect={rect} onClose={onClose} label={`Filter ${colName(col)}`}>
      {s.canEdit && !s.view && <>
        <button type="button" class="menu-item" onClick={() => sort(false)}><ArrowDownAZ size={16} />Sort A → Z</button>
        <button type="button" class="menu-item" onClick={() => sort(true)}><ArrowUpZA size={16} />Sort Z → A</button>
        <div class="menu-sep" />
      </>}
      <div class="sp-sec">
        <div class="sp-h">Filter by condition</div>
        <select class="select" aria-label="Condition" value={cond.op || ''} onChange={(e) => setCond({ ...cond, op: e.target.value })}>
          <option value="">None</option>
          {Object.entries(condOps).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {needs && <input class="input" aria-label="Value" placeholder="Value" value={cond.a ?? ''} onInput={(e) => setCond({ ...cond, a: e.target.value })} />}
        {two && <input class="input" aria-label="Second value" placeholder="and" value={cond.b ?? ''} onInput={(e) => setCond({ ...cond, b: e.target.value })} />}
      </div>
      <div class="sp-sec">
        <div class="sp-h">Filter by values</div>
        <div class="sp-row">
          <button type="button" class="sp-link" onClick={() => setHidden(new Set())}>Select all</button>
          <button type="button" class="sp-link" onClick={() => setHidden(new Set(values.map((v) => v.text)))}>Clear</button>
        </div>
        <input class="input" aria-label="Search values" placeholder="Search" value={q} onInput={(e) => setQ(e.target.value)} />
        <div class="sp-values">
          {shown.slice(0, 500).map((v) => (
            <label key={v.text} class="chart-check">
              <input type="checkbox" checked={!hidden.has(v.text)} onChange={(e) => {
                const n = new Set(hidden)
                e.target.checked ? n.delete(v.text) : n.add(v.text)
                setHidden(n)
              }} />
              <span class="sp-val">{v.text || '(Blanks)'}</span><span class="sp-n">{v.n}</span>
            </label>
          ))}
        </div>
      </div>
      <div class="sp-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" onClick={apply}>OK</Button>
      </div>
    </Floating>
  )
}

// --- dropdown cell ----------------------------------------------------------------

export function ListMenu({ s, rect, onClose }) {
  const v = s.validationHere()
  const items = v ? s.listFor(v.rule) : []
  const now = s.model.getFormattedCellValue(s.sheet, s.sel.row, s.sel.col)
  const pick = (t) => {
    s.setValue(s.sel.row, s.sel.col, t)
    onClose()
    s.wrap?.focus()
  }
  return (
    <Floating rect={rect} width={Math.max(180, rect.w)} onClose={onClose} label="Choose a value">
      {items.map((t) => <button type="button" key={t} class={cx('menu-item', t === now && 'on')} onClick={() => pick(t)}>{t}</button>)}
      {now && <><div class="menu-sep" /><button type="button" class="menu-item" onClick={() => pick('')}>Clear</button></>}
      {!items.length && <div class="mb-none">This list has no items yet.</div>}
    </Floating>
  )
}

// --- sort range -----------------------------------------------------------------

export function SortDialog({ s, onClose }) {
  const block = dataBlock(s.model, s.sheet, s.sel)
  const [header, setHeader] = useState(false)
  const [keys, setKeys] = useState([{ col: block.c1, desc: false }])
  const cols = []
  for (let c = block.c1; c <= block.c2; c++) cols.push(c)
  const label = (c) => (header ? s.model.getFormattedCellValue(s.sheet, block.r1, c) || `Column ${colName(c)}` : `Column ${colName(c)}`)
  const go = () => {
    s.act((m) => sortRange(m, block, keys, header))
    onClose()
  }
  return (
    <Modal title={`Sort range ${rangeText(s.model, block, s.sheet)}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={go}>Sort</Button></>}>
      <Check label="Data has a header row" checked={header} onChange={setHeader} />
      {keys.map((k, i) => (
        <div class="sp-row" key={i}>
          <span class="sp-lbl">{i ? 'then by' : 'Sort by'}</span>
          <select class="select" aria-label="Column" value={k.col} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, col: +e.target.value } : x)))}>
            {cols.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
          <select class="select" aria-label="Order" value={k.desc ? 'za' : 'az'} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, desc: e.target.value === 'za' } : x)))}>
            <option value="az">A → Z</option>
            <option value="za">Z → A</option>
          </select>
          {i > 0 && <IconButton icon={X} label="Remove this column" onClick={() => setKeys(keys.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {keys.length < cols.length && <Button icon={Plus} onClick={() => setKeys([...keys, { col: cols.find((c) => !keys.some((k) => k.col === c)), desc: false }])}>Add another sort column</Button>}
    </Modal>
  )
}

// --- filter view bar ------------------------------------------------------------------

export function ViewBar({ s, onClose, onLink }) {
  const v = s.meta('view').find((x) => x.id === s.view)
  if (!v) return null
  const rename = (name) => s.act((m) => updateMeta(m, v, { name: name.trim() || v.name }))
  return (
    <div class="sp-viewbar" role="region" aria-label="Filter view">
      <Filter size={15} />
      <span>Filter view</span>
      <TextField aria-label="Filter view name" class="input sp-viewname" value={v.name} onCommit={rename} />
      <span class="sp-range">{v.ref ? rangeText(s.model, v.ref, s.sheet) : ''}</span>
      <span class="grow" />
      <span class="sp-note">Only you see this filter while the view is open.</span>
      <IconButton icon={Link2} label="Copy link to this filter view" onClick={() => onLink(v)} />
      {s.canEdit && <IconButton icon={Trash2} label="Delete filter view" onClick={() => { s.act((m) => removeMeta(m, v)); onClose() }} />}
      <IconButton icon={X} label="Close filter view" onClick={onClose} />
    </div>
  )
}

// newView makes a filter view over the data around the selection (or the
// range the sheet's filter covers), with the filter's criteria if any.
export function newView(s) {
  const f = s.meta('filter').find((x) => x.ref?.sheet === s.sheet)
  const ref = f?.ref || dataBlock(s.model, s.sheet, s.sel)
  const n = s.meta('view').length + 1
  return s.act((m) => addMeta(m, { kind: 'view', name: `Filter ${n}`, owner: s.me.id, ownerName: s.me.name, criteria: f?.criteria || {} }, ref))
}

// --- data validation ----------------------------------------------------------------

const ruleTypes = [
  ['list', 'Dropdown (from a list)'],
  ['range', 'Dropdown (from a range)'],
  ['checkbox', 'Checkbox'],
  ['number', 'Number'],
  ['text', 'Text'],
]
const numberOps = ['between', 'gt', 'gte', 'lt', 'lte', 'eq', 'ne']
const textOps = ['contains', 'notContains', 'is']

export function ValidationPanel({ s, onClose }) {
  const here = s.validationHere(s.sel.r1, s.sel.c1)
  const start = here?.ref || { sheet: s.sheet, r1: s.sel.r1, c1: s.sel.c1, r2: Math.min(s.sel.r2, s.R), c2: Math.min(s.sel.c2, s.C) }
  const [range, setRange] = useState(rangeText(s.model, start, s.sheet))
  const [rule, setRule] = useState(here?.rule || { type: 'list', values: ['Option 1', 'Option 2'] })
  const [strict, setStrict] = useState(here ? here.strict : true)
  const [help, setHelp] = useState(here?.help || '')
  const ref = parseRange(s.model, range, s.sheet)
  const rules = s.meta('validation').filter((v) => v.ref?.sheet === s.sheet)
  const save = () => {
    if (!ref) return
    s.act((m) => setValidation(m, ref, rule, rule.type === 'checkbox' ? true : strict, help))
    s.wrap?.focus()
  }
  const remove = () => {
    if (ref) s.act((m) => clearValidation(m, ref))
  }
  const setType = (type) => setRule(type === 'list' ? { type, values: ['Option 1', 'Option 2'] } : type === 'range' ? { type, source: '' } : type === 'number' ? { type, op: 'between', a: '1', b: '10' } : type === 'text' ? { type, op: 'contains', a: '' } : { type })
  return (
    <aside class="chart-panel" aria-label="Data validation">
      <header class="side-top"><h2>Data validation</h2><span class="grow" /><IconButton icon={X} label="Close data validation" onClick={onClose} /></header>
      <div class="chart-form">
        {rules.length > 0 && (
          <div class="sp-rules">
            {rules.map((v) => (
              <div key={v.id} class="sp-rule">
                <span class="sp-rule-range">{rangeText(s.model, v.ref, s.sheet)}</span>
                <span class="sp-rule-what">{describeRule(v.rule)}</span>
                <IconButton icon={Pencil} label="Edit rule" onClick={() => { setRange(rangeText(s.model, v.ref, s.sheet)); setRule(v.rule); setStrict(v.strict); setHelp(v.help || '') }} />
                <IconButton icon={Trash2} label="Remove rule" onClick={() => s.act((m) => removeMeta(m, v))} />
              </div>
            ))}
          </div>
        )}
        <Field label="Apply to range" error={ref ? '' : 'Enter a range such as A2:A100'}>
          <div class="row">
            <input class="input" aria-label="Apply to range" value={range} onInput={(e) => setRange(e.target.value)} />
            <IconButton icon={Crosshair} label="Use the selected cells" onClick={() => setRange(rangeText(s.model, { sheet: s.sheet, r1: s.sel.r1, c1: s.sel.c1, r2: Math.min(s.sel.r2, s.R), c2: Math.min(s.sel.c2, s.C) }, s.sheet))} />
          </div>
        </Field>
        <Field label="Criteria">
          <select class="select" aria-label="Criteria" value={rule.type} onChange={(e) => setType(e.target.value)}>
            {ruleTypes.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {rule.type === 'list' && (
          <Field label="Items" hint="One per line">
            <textarea class="input sp-items" aria-label="Items" value={(rule.values || []).join('\n')} onInput={(e) => setRule({ ...rule, values: e.target.value.split('\n') })} />
          </Field>
        )}
        {rule.type === 'range' && (
          <Field label="Items from range"><input class="input" aria-label="Items from range" placeholder="Sheet1!A2:A20" value={rule.source} onInput={(e) => setRule({ ...rule, source: e.target.value })} /></Field>
        )}
        {(rule.type === 'number' || rule.type === 'text') && (
          <div class="sp-row">
            <select class="select" aria-label="Condition" value={rule.op} onChange={(e) => setRule({ ...rule, op: e.target.value })}>
              {(rule.type === 'number' ? numberOps : textOps).map((k) => <option key={k} value={k}>{condOps[k]}</option>)}
            </select>
            <input class="input" aria-label="Value" value={rule.a ?? ''} onInput={(e) => setRule({ ...rule, a: e.target.value })} />
            {rule.op === 'between' && <input class="input" aria-label="Second value" value={rule.b ?? ''} onInput={(e) => setRule({ ...rule, b: e.target.value })} />}
          </div>
        )}
        {rule.type !== 'checkbox' && (
          <Field label="If the data is invalid">
            <select class="select" aria-label="If the data is invalid" value={strict ? 'reject' : 'warn'} onChange={(e) => setStrict(e.target.value === 'reject')}>
              <option value="reject">Reject the input</option>
              <option value="warn">Show a warning</option>
            </select>
          </Field>
        )}
        {rule.type !== 'checkbox' && <Field label="Help text (optional)"><input class="input" aria-label="Help text" value={help} onInput={(e) => setHelp(e.target.value)} /></Field>}
        <div class="sp-row">
          <Button kind="primary" disabled={!ref} onClick={save}>Save rule</Button>
          <Button onClick={remove} disabled={!ref}>Remove rules in range</Button>
        </div>
      </div>
    </aside>
  )
}

// --- conditional formatting -------------------------------------------------------

const cellOps = [
  ['GreaterThan', 'Greater than'], ['GreaterThanOrEqual', 'Greater than or equal to'], ['LessThan', 'Less than'],
  ['LessThanOrEqual', 'Less than or equal to'], ['Equal', 'Is equal to'], ['NotEqual', 'Is not equal to'],
  ['Between', 'Is between'], ['NotBetween', 'Is not between'],
]
const textOpsCf = [['Contains', 'Text contains'], ['DoesNotContain', 'Text does not contain'], ['BeginsWith', 'Text starts with'], ['EndsWith', 'Text ends with'], ['Equals', 'Text is exactly']]
const conditions = [
  ['Blanks', 'Is empty'], ['NotBlanks', 'Is not empty'], ...textOpsCf, ...cellOps, ['DuplicateValues', 'Is a duplicate'], ['Formula', 'Custom formula is'],
]

const literal = (v) => (v === '' || isFinite(Number(v)) ? String(v) : `"${String(v).replace(/"/g, '""')}"`)

function toRule(kind, cond, a, b, style, scale) {
  if (kind === 'scale') {
    const t = [{ cfvo: 'Min', color: scale.min }]
    if (scale.mid) t.push({ cfvo: { Percentile: 50 }, color: scale.mid })
    t.push({ cfvo: 'Max', color: scale.max })
    return { type: 'ColorScale', thresholds: t }
  }
  const format = {}
  if (style.b || style.i || style.strike || style.color) format.font = { ...(style.b && { b: true }), ...(style.i && { i: true }), ...(style.strike && { strike: true }), ...(style.color && { color: style.color }) }
  if (style.fill) format.fill = { color: style.fill }
  const base = { format, stop_if_true: false }
  if (textOpsCf.some(([k]) => k === cond)) return { type: 'Text', operator: cond, value: a, ...base }
  if (cellOps.some(([k]) => k === cond)) return { type: 'CellIs', operator: cond, formula: literal(a), formula2: cond.endsWith('Between') ? literal(b) : null, ...base }
  if (cond === 'Formula') return { type: 'Formula', formula: a.replace(/^=/, ''), ...base }
  return { type: cond, ...base }
}

function fromRule(rule, dxf) {
  if (rule.type === 'ColorScale') {
    const t = rule.thresholds
    return { kind: 'scale', scale: { min: t[0]?.color, mid: t.length > 2 ? t[1].color : '', max: t[t.length - 1]?.color } }
  }
  const style = { b: !!dxf?.font?.b, i: !!dxf?.font?.i, strike: !!dxf?.font?.strike, color: dxf?.font?.color || '', fill: dxf?.fill?.color || '' }
  const unq = (x) => String(x ?? '').replace(/^"(.*)"$/, '$1').replace(/""/g, '"')
  if (rule.type === 'Text') return { kind: 'single', cond: rule.operator, a: rule.value, style }
  if (rule.type === 'CellIs') return { kind: 'single', cond: rule.operator, a: unq(rule.formula), b: unq(rule.formula2), style }
  if (rule.type === 'Formula') return { kind: 'single', cond: 'Formula', a: '=' + rule.formula, style }
  return { kind: 'single', cond: rule.type, style }
}

const describeCf = (rule) => {
  if (rule.type === 'ColorScale') return 'Colour scale'
  const name = conditions.find(([k]) => k === (rule.operator || rule.type))?.[1] || rule.type
  const v = rule.value ?? rule.formula ?? ''
  return `${name}${v ? ' ' + v : ''}${rule.formula2 ? ' and ' + rule.formula2 : ''}`
}

export function CondPanel({ s, onClose }) {
  const m = s.model
  const list = m.getConditionalFormattingList(s.sheet)
  const sel = { sheet: s.sheet, r1: s.sel.r1, c1: s.sel.c1, r2: Math.min(s.sel.r2, s.R), c2: Math.min(s.sel.c2, s.C) }
  const blank = { index: null, range: rangeText(m, sel, s.sheet), kind: 'single', cond: 'GreaterThan', a: '', b: '', style: { b: false, i: false, strike: false, color: '', fill: '#d3f9d8' }, scale: { min: '#ffffff', mid: '', max: '#57bb8a' } }
  const [edit, setEdit] = useState(list.length ? null : blank)
  const set = (patch) => setEdit({ ...edit, ...patch })
  const save = () => {
    const ref = parseRange(m, edit.range, s.sheet)
    if (!ref) return
    const range = `${colName(ref.c1)}${ref.r1}:${colName(ref.c2)}${ref.r2}`
    const rule = toRule(edit.kind, edit.cond, edit.a, edit.b, edit.style, edit.scale)
    s.act((mm) => (edit.index === null ? mm.addConditionalFormatting(ref.sheet, range, rule) : mm.updateConditionalFormatting(s.sheet, edit.index, range, rule)))
    setEdit(null)
  }
  const needsA = edit && !['Blanks', 'NotBlanks', 'DuplicateValues'].includes(edit.cond)
  return (
    <aside class="chart-panel" aria-label="Conditional formatting">
      <header class="side-top"><h2>Conditional formatting</h2><span class="grow" /><IconButton icon={X} label="Close conditional formatting" onClick={onClose} /></header>
      <div class="chart-form">
        {!edit && <>
          <div class="sp-rules">
            {list.map((x) => {
              const dxf = m.getDxfForConditionalFormatting(s.sheet, x.index)
              const f = fromRule(x.cf_rule, dxf)
              return (
                <div key={x.index} class="sp-rule">
                  <span class="sp-swatch" style={f.kind === 'scale' ? { background: `linear-gradient(90deg, ${f.scale.min}, ${f.scale.mid || f.scale.min}, ${f.scale.max})` } : { background: f.style.fill || 'transparent', color: f.style.color || 'inherit', fontWeight: f.style.b ? 700 : 400 }}>123</span>
                  <span class="sp-rule-what">{describeCf(x.cf_rule)}<span class="sp-rule-range">{x.range}</span></span>
                  <IconButton icon={Pencil} label="Edit rule" onClick={() => setEdit({ ...blank, ...f, style: { ...blank.style, ...(f.style || {}) }, scale: { ...blank.scale, ...(f.scale || {}) }, index: x.index, range: x.range })} />
                  <IconButton icon={Trash2} label="Delete rule" onClick={() => s.act((mm) => mm.deleteConditionalFormatting(s.sheet, x.index))} />
                </div>
              )
            })}
          </div>
          <Button icon={Plus} onClick={() => setEdit(blank)}>Add another rule</Button>
        </>}
        {edit && <>
          <div class="sp-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={edit.kind === 'single'} class={cx('tab', edit.kind === 'single' && 'on')} onClick={() => set({ kind: 'single' })}>Single colour</button>
            <button type="button" role="tab" aria-selected={edit.kind === 'scale'} class={cx('tab', edit.kind === 'scale' && 'on')} onClick={() => set({ kind: 'scale' })}>Colour scale</button>
          </div>
          <Field label="Apply to range"><input class="input" aria-label="Apply to range" value={edit.range} onInput={(e) => set({ range: e.target.value })} /></Field>
          {edit.kind === 'single' ? <>
            <Field label="Format cells if">
              <select class="select" aria-label="Format cells if" value={edit.cond} onChange={(e) => set({ cond: e.target.value })}>
                {conditions.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            {needsA && <input class="input" aria-label="Value or formula" placeholder={edit.cond === 'Formula' ? '=B2>100' : 'Value'} value={edit.a} onInput={(e) => set({ a: e.target.value })} />}
            {edit.cond.endsWith('Between') && <input class="input" aria-label="Second value" placeholder="and" value={edit.b} onInput={(e) => set({ b: e.target.value })} />}
            <div class="sp-h">Formatting style</div>
            <div class="sp-row">
              <Check label="Bold" checked={edit.style.b} onChange={(v) => set({ style: { ...edit.style, b: v } })} />
              <Check label="Italic" checked={edit.style.i} onChange={(v) => set({ style: { ...edit.style, i: v } })} />
              <Check label="Strikethrough" checked={edit.style.strike} onChange={(v) => set({ style: { ...edit.style, strike: v } })} />
            </div>
            <div class="sp-h">Text colour</div>
            <Swatches colors={inkColors} clear="Default" onPick={(c) => set({ style: { ...edit.style, color: c || '' } })} />
            <div class="sp-h">Fill colour</div>
            <Swatches colors={markColors} clear="None" onPick={(c) => set({ style: { ...edit.style, fill: c || '' } })} />
            <span class="sp-swatch big" style={{ background: edit.style.fill || 'transparent', color: edit.style.color || 'inherit', fontWeight: edit.style.b ? 700 : 400, fontStyle: edit.style.i ? 'italic' : 'normal', textDecoration: edit.style.strike ? 'line-through' : 'none' }}>Preview 123</span>
          </> : <>
            {[['min', 'Lowest value'], ['mid', 'Midpoint (optional)'], ['max', 'Highest value']].map(([k, lbl]) => (
              <div class="sp-row" key={k}>
                <span class="sp-lbl">{lbl}</span>
                <input type="color" aria-label={lbl} value={edit.scale[k] || '#ffd666'} onInput={(e) => set({ scale: { ...edit.scale, [k]: e.target.value } })} />
                {k === 'mid' && edit.scale.mid && <IconButton icon={X} label="No midpoint" onClick={() => set({ scale: { ...edit.scale, mid: '' } })} />}
              </div>
            ))}
            <span class="sp-swatch big" style={{ background: `linear-gradient(90deg, ${edit.scale.min}, ${edit.scale.mid || edit.scale.min}, ${edit.scale.max})` }} />
          </>}
          <div class="sp-row">
            <Button onClick={() => setEdit(list.length ? null : blank)}>Cancel</Button>
            <Button kind="primary" disabled={!parseRange(m, edit.range, s.sheet)} onClick={save}>Done</Button>
          </div>
        </>}
      </div>
    </aside>
  )
}

// --- pivot tables -------------------------------------------------------------------

export function PivotCreate({ s, onClose, onMade }) {
  const block = dataBlock(s.model, s.sheet, s.sel)
  const [range, setRange] = useState(rangeText(s.model, block, -1))
  const ref = parseRange(s.model, range, s.sheet)
  const go = () => {
    const made = s.act((m) => addPivot(m, ref, {}))
    onClose()
    if (made) onMade(made)
  }
  return (
    <Modal title="Create pivot table" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!ref || ref.r2 <= ref.r1} onClick={go}>Create</Button></>}>
      <Field label="Data range" hint="The first row holds the column headings." error={ref ? '' : 'Enter a range such as Sheet1!A1:D100'}>
        <input class="input" aria-label="Data range" value={range} onInput={(e) => setRange(e.target.value)} />
      </Field>
      <p class="sp-note">The pivot table goes on a new sheet.</p>
    </Modal>
  )
}

export function PivotPanel({ s, pivot, onClose }) {
  const m = s.model
  const src = pivot.ref
  const [filterCol, setFilterCol] = useState(null)
  if (!src) return null
  const heads = []
  for (let c = src.c1; c <= src.c2; c++) heads.push([c, m.getFormattedCellValue(src.sheet, src.r1, c) || `Column ${colName(c)}`])
  const name = (c) => heads.find(([k]) => k === c)?.[1] || colName(c)
  const set = (patch) => s.act((mm) => updatePivot(mm, pivot, patch))
  const unused = (list) => heads.filter(([c]) => !list.includes(c))
  const Fields = ({ title, list, max, onChange }) => (
    <div class="sp-sec">
      <div class="sp-h">{title}</div>
      {list.map((c) => (
        <div class="sp-chip" key={c}><span>{name(c)}</span><IconButton icon={X} label={`Remove ${name(c)}`} onClick={() => onChange(list.filter((x) => x !== c))} /></div>
      ))}
      {(!max || list.length < max) && (
        <select class="select" aria-label={`Add to ${title.toLowerCase()}`} value="" onChange={(e) => e.target.value && onChange([...list, +e.target.value])}>
          <option value="">Add…</option>
          {unused(list).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
      )}
    </div>
  )
  const values = pivot.values || []
  const filters = pivot.filters || {}
  const fvals = filterCol ? columnValues(m, { ref: src }, filterCol) : []
  const hiddenNow = new Set(filters[filterCol] || [])
  const del = () => {
    const at = sheetById(m, pivot.target)
    s.act((mm) => {
      removeMeta(mm, pivot)
      if (at >= 0 && visibleSheets(mm).length > 1) mm.deleteSheet(at)
    })
    onClose()
  }
  return (
    <aside class="chart-panel" aria-label="Pivot table editor">
      <header class="side-top"><h2>Pivot table</h2><span class="grow" /><IconButton icon={X} label="Close pivot table editor" onClick={onClose} /></header>
      <div class="chart-form">
        <Field label="Data range">
          <TextField aria-label="Pivot data range" value={rangeText(m, src, -1)} onCommit={(v) => { const r = parseRange(m, v, s.sheet); if (r) s.act((mm) => { updateMeta(mm, pivot, {}, r); updatePivot(mm, { ...pivot, ref: r }, {}) }) }} />
        </Field>
        <Fields title="Rows" list={pivot.rows || []} onChange={(rows) => set({ rows })} />
        <Fields title="Columns" list={pivot.cols || []} max={1} onChange={(cols) => set({ cols })} />
        <div class="sp-sec">
          <div class="sp-h">Values</div>
          {values.map((v, i) => (
            <div class="sp-row" key={i}>
              <select class="select" aria-label="Summarise by" value={v.fn} onChange={(e) => set({ values: values.map((x, j) => (j === i ? { ...x, fn: e.target.value } : x)) })}>
                {Object.entries(pivotFns).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <span class="sp-lbl">of {name(v.col)}</span>
              <IconButton icon={X} label="Remove value" onClick={() => set({ values: values.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <select class="select" aria-label="Add a value" value="" onChange={(e) => e.target.value && set({ values: [...values, { col: +e.target.value, fn: 'SUM' }] })}>
            <option value="">Add…</option>
            {heads.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </div>
        <div class="sp-sec">
          <div class="sp-h">Filters</div>
          {Object.keys(filters).filter((c) => filters[c]?.length).map((c) => (
            <div class="sp-chip" key={c}><button type="button" class="sp-link" onClick={() => setFilterCol(+c)}>{name(+c)}: {filters[c].length} hidden</button><IconButton icon={X} label={`Remove filter on ${name(+c)}`} onClick={() => { const f = { ...filters }; delete f[c]; set({ filters: f }) }} /></div>
          ))}
          <select class="select" aria-label="Filter by" value={filterCol || ''} onChange={(e) => setFilterCol(e.target.value ? +e.target.value : null)}>
            <option value="">Add a filter…</option>
            {heads.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
          {filterCol && (
            <div class="sp-values">
              {fvals.map((v) => {
                const key = v.v.blank ? '(blank)' : v.text
                return (
                  <label key={key} class="chart-check">
                    <input type="checkbox" checked={!hiddenNow.has(key)} onChange={(e) => {
                      const n = new Set(hiddenNow)
                      e.target.checked ? n.delete(key) : n.add(key)
                      set({ filters: { ...filters, [filterCol]: [...n] } })
                    }} />
                    <span class="sp-val">{key}</span><span class="sp-n">{v.n}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <Button kind="danger" icon={Trash2} onClick={del}>Delete pivot table</Button>
      </div>
    </aside>
  )
}

// --- find and replace -------------------------------------------------------------

export function FindDialog({ s, replace: withReplace, onClose }) {
  const [opts, setOpts] = useState({ find: '', replace: '', matchCase: false, wholeCell: false, regex: false, formulas: false, all: true })
  const [note, setNote] = useState('')
  const at = useRef(-1)
  const input = useRef()
  useLayoutEffect(() => input.current?.focus(), [])
  const set = (patch) => { setOpts({ ...opts, ...patch }); at.current = -1; setNote('') }
  let bad = false
  try { if (opts.regex && opts.find) new RegExp(opts.find) } catch { bad = true }
  const sheets = () => (opts.all ? visibleSheets(s.model) : [s.sheet])
  const next = () => {
    if (bad || !opts.find) return
    const hits = findAll(s.model, opts, sheets())
    if (!hits.length) return setNote('No matches.')
    // The first match after the selected cell, in reading order.
    const order = (h) => [visibleSheets(s.model).indexOf(h.sheet), h.r, h.c]
    const cur = [visibleSheets(s.model).indexOf(s.sheet), s.sel.row, s.sel.col]
    const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))
    const h = hits.find((x) => after(order(x), cur)) || hits[0]
    if (h.sheet !== s.sheet) s.useSheet(h.sheet)
    s.select(h.r, h.c)
    setNote(`${hits.indexOf(h) + 1} of ${hits.length}`)
    return h
  }
  const replaceOne = () => {
    const h = s.model.getCellContent(s.sheet, s.sel.row, s.sel.col)
    const one = findAll(s.model, opts, [s.sheet]).find((x) => x.r === s.sel.row && x.c === s.sel.col)
    if (one && (!one.formula || opts.formulas)) {
      const re = new RegExp(opts.regex ? opts.find : opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.matchCase ? 'g' : 'gi')
      const src = opts.wholeCell ? new RegExp(`^(?:${re.source})$`, re.flags) : re
      s.setValue(s.sel.row, s.sel.col, h.replace(src, opts.replace))
    }
    next()
  }
  const all = () => {
    const n = s.act((m) => replaceAll(m, opts, sheets())) || 0
    setNote(n ? `Replaced in ${n} cell${n === 1 ? '' : 's'}.` : 'Nothing to replace.')
  }
  return (
    <Modal title={withReplace ? 'Find and replace' : 'Find'} onClose={onClose} width={440} footer={<>
      {note && <span class="sp-note grow">{note}</span>}
      {withReplace && s.canEdit && <><Button onClick={replaceOne} disabled={bad || !opts.find}>Replace</Button><Button onClick={all} disabled={bad || !opts.find}>Replace all</Button></>}
      <Button kind="primary" onClick={next} disabled={bad || !opts.find}>Find</Button>
    </>}>
      <Field label="Find" error={bad ? 'That regular expression is not valid.' : ''}>
        <input ref={input} class="input" aria-label="Find" value={opts.find} onInput={(e) => set({ find: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), next())} />
      </Field>
      {withReplace && <Field label="Replace with"><input class="input" aria-label="Replace with" value={opts.replace} onInput={(e) => set({ replace: e.target.value })} /></Field>}
      <Field label="Search">
        <select class="select" aria-label="Search" value={opts.all ? 'all' : 'this'} onChange={(e) => set({ all: e.target.value === 'all' })}>
          <option value="all">All sheets</option>
          <option value="this">This sheet</option>
        </select>
      </Field>
      <div class="chart-checks">
        <Check label="Match case" checked={opts.matchCase} onChange={(v) => set({ matchCase: v })} />
        <Check label="Match entire cell contents" checked={opts.wholeCell} onChange={(v) => set({ wholeCell: v })} />
        <Check label="Search using regular expressions" checked={opts.regex} onChange={(v) => set({ regex: v })} />
        <Check label="Also search within formulas" checked={opts.formulas} onChange={(v) => set({ formulas: v })} />
      </div>
    </Modal>
  )
}

// --- row and column sizes ------------------------------------------------------------

export function SizeDialog({ s, kind, onClose }) {
  const cols = kind === 'col'
  const a = cols ? s.sel.c1 : s.sel.r1
  const b = Math.min(cols ? s.sel.c2 : s.sel.r2, cols ? s.C : s.R)
  const now = cols ? s.model.getColumnWidth(s.sheet, a) : s.model.getRowHeight(s.sheet, a)
  const [mode, setMode] = useState('set')
  const [px, setPx] = useState(String(Math.round(now)))
  const what = cols ? (a === b ? `column ${colName(a)}` : `columns ${colName(a)}–${colName(b)}`) : (a === b ? `row ${a}` : `rows ${a}–${b}`)
  const go = () => {
    if (mode === 'fit') cols ? s.fitColumns(a, b) : s.fitRows(a, b)
    else {
      const n = Math.max(cols ? 12 : 8, Math.min(2000, Number(px) || 0))
      s.act((m) => (cols ? m.setColumnsWidth(s.sheet, a, b, n) : m.setRowsHeight(s.sheet, a, b, n)))
    }
    onClose()
  }
  return (
    <Modal title={`Resize ${what}`} onClose={onClose} width={380} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={go}>OK</Button></>}>
      <label class="chart-check"><input type="radio" name="size" checked={mode === 'set'} onChange={() => setMode('set')} />Specify {cols ? 'width' : 'height'} in pixels</label>
      <input class="input" aria-label={cols ? 'Width in pixels' : 'Height in pixels'} inputMode="numeric" value={px} disabled={mode !== 'set'} onInput={(e) => setPx(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      <label class="chart-check"><input type="radio" name="size" checked={mode === 'fit'} onChange={() => setMode('fit')} />Fit to data</label>
    </Modal>
  )
}

export { MAXR, MAXC }
