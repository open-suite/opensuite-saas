// Charts on a spreadsheet: the layer that floats them over the grid, and the
// panel that edits one. Definitions and data come from sheet-charts.js.
import { Component } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { X, Trash2, Crosshair, ChartColumn, ChartBar, ChartLine, ChartArea, ChartPie, ChartScatter } from 'lucide-preact'
import './side-panel.css'
import './charts.css'
import { cx } from '../lib/util.js'
import { Button, IconButton, Field } from '../ui.jsx'
import { HW, HH } from './sheet-core.js'
import { Chart, chartTypes } from './chart-draw.jsx'
import { readCharts, addChart, updateChart, removeChart, chartData, guessChart, parseRange, rangeText } from './sheet-charts.js'

const MIN_W = 220
const MIN_H = 150
const icons = { column: ChartColumn, bar: ChartBar, line: ChartLine, area: ChartArea, pie: ChartPie, scatter: ChartScatter }

// insertChart draws the selection (or the block of data around the selected
// cell) as a column chart placed beside it, and returns the new chart's id.
export function insertChart(s) {
  const { ref, headers, labels } = guessChart(s)
  let x = Math.round(s.colX[Math.min(ref.c2, s.C)] + 24)
  let y = Math.round(s.rowY[Math.min(ref.r1, s.R) - 1] + 8)
  // Never exactly on top of a chart that is already there.
  const here = readCharts(s).filter((c) => c.sheet === s.sheetId)
  while (here.some((c) => Math.abs(c.x - x) < 16 && Math.abs(c.y - y) < 16)) {
    x += 28
    y += 28
  }
  return addChart(s, { type: 'column', sheet: s.sheetId, x, y, w: 480, h: 300, headers, labels, legend: 'bottom', title: '' }, ref)
}

// Redrawn only when the workbook or the chart's size changes, not on every
// movement of the selection.
class Drawn extends Component {
  shouldComponentUpdate(next) {
    const p = this.props
    return next.rev !== p.rev || next.w !== p.w || next.h !== p.h || next.s !== p.s
  }

  render({ s, chart, w, h }) {
    return <Chart chart={chart} data={chartData(s, chart)} w={w} h={h} />
  }
}

export function ChartLayer({ s, selected, onSelect, onEdit }) {
  const layer = useRef()
  const pan = useRef()
  const [drag, setDrag] = useState(null) // { id, x, y, w, h } while moving or resizing
  // The layer follows the grid's scrolling directly, without a re-render.
  useLayoutEffect(() => {
    const place = () => {
      if (!layer.current) return
      layer.current.style.width = Math.max(0, s.scroll.clientWidth - HW) + 'px'
      layer.current.style.height = Math.max(0, s.scroll.clientHeight - HH) + 'px'
      pan.current.style.transform = `translate(${-s.scroll.scrollLeft}px, ${-s.scroll.scrollTop}px)`
    }
    s.onView = place
    place()
    return () => {
      if (s.onView === place) s.onView = null
    }
  })

  const charts = readCharts(s).filter((c) => c.sheet === s.sheetId)
  const grab = (e, c, mode) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onSelect(c.id)
    s.wrap.focus()
    if (!s.canEdit) return
    const from = { x: c.x, y: c.y, w: c.w, h: c.h }
    let to = null
    const move = (ev) => {
      const dx = ev.clientX - e.clientX
      const dy = ev.clientY - e.clientY
      if (!to && Math.abs(dx) + Math.abs(dy) < 3) return
      to = { ...from }
      if (mode === 'move') {
        to.x = Math.max(0, from.x + dx)
        to.y = Math.max(0, from.y + dy)
      } else {
        if (mode.includes('e')) to.w = Math.max(MIN_W, from.w + dx)
        if (mode.includes('s')) to.h = Math.max(MIN_H, from.h + dy)
        if (mode.includes('w')) { to.w = Math.max(MIN_W, from.w - dx); to.x = Math.max(0, from.x + from.w - to.w) }
        if (mode.includes('n')) { to.h = Math.max(MIN_H, from.h - dy); to.y = Math.max(0, from.y + from.h - to.h) }
      }
      for (const k in to) to[k] = Math.round(to[k])
      setDrag({ id: c.id, ...to })
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      if (to) updateChart(s, c.id, to)
      setDrag(null)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  return (
    <div class="chart-layer" ref={layer} style={{ left: HW, top: HH }} onWheel={(e) => { s.scroll.scrollLeft += e.deltaX; s.scroll.scrollTop += e.deltaY }}>
      <div class="chart-pan" ref={pan}>
        {charts.map((c) => {
          const box = drag?.id === c.id ? drag : c
          const on = selected === c.id
          return (
            <div key={c.id} class={cx('chart', on && 'on', drag?.id === c.id && 'moving')} data-chart={c.id} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              onPointerDown={(e) => grab(e, c, 'move')} onDblClick={() => s.canEdit && onEdit(c.id)}>
              <Drawn s={s} chart={c} rev={s.rev} w={box.w - 2} h={box.h - 2} />
              {on && s.canEdit && ['nw', 'ne', 'sw', 'se', 'e', 's'].map((m) => <span key={m} class={'chart-grip grip-' + m} onPointerDown={(e) => grab(e, c, m)} />)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// A text box that commits on Enter or when left, and is never overwritten
// while someone is typing in it.
export function TextField({ value, onCommit, error, ...rest }) {
  const [v, setV] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setV(value)
  }, [value])
  const commit = () => v !== value && onCommit(v)
  return (
    <input class="input" {...rest} value={v} aria-invalid={error || undefined}
      onInput={(e) => setV(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={() => { focused.current = false; commit() }}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
  )
}

const Check = ({ label, checked, onChange }) => (
  <label class="chart-check"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>
)

export function ChartPanel({ s, chart, onClose, onDelete }) {
  const [bad, setBad] = useState(false)
  const set = (patch) => updateChart(s, chart.id, patch)
  const setRange = (text) => {
    const ref = parseRange(s.model, text, s.sheet)
    setBad(!ref)
    if (ref) updateChart(s, chart.id, {}, ref)
  }
  const useSelection = () => {
    setBad(false)
    updateChart(s, chart.id, {}, { sheet: s.sheet, r1: s.sel.r1, c1: s.sel.c1, r2: Math.min(s.sel.r2, s.R), c2: Math.min(s.sel.c2, s.C) })
  }
  const stackable = ['column', 'bar', 'area'].includes(chart.type)
  return (
    <aside class="chart-panel" aria-label="Chart options">
      <header class="side-top">
        <h2>Chart</h2>
        <span class="grow" />
        <IconButton icon={X} label="Close chart options" onClick={onClose} />
      </header>
      <div class="chart-form">
        <div class="chart-types" role="radiogroup" aria-label="Chart type">
          {chartTypes.map(([t, label]) => {
            const Icon = icons[t]
            return <button type="button" key={t} role="radio" aria-checked={chart.type === t} title={label} class={cx('chart-type', chart.type === t && 'on')} onClick={() => set({ type: t })}><Icon size={18} />{label}</button>
          })}
        </div>
        <Field label="Data range" error={bad ? 'Enter a range such as A1:C8' : ''}>
          <div class="row">
            <TextField aria-label="Data range" key={chart.id} spellcheck={false} value={chart.ref ? rangeText(s.model, chart.ref, s.sheet) : ''} error={bad} onCommit={setRange} />
            <IconButton icon={Crosshair} label="Use the selected cells" onClick={useSelection} />
          </div>
        </Field>
        <div class="chart-checks">
          <Check label="First row is headers" checked={chart.headers} onChange={(v) => set({ headers: v })} />
          <Check label="First column is labels" checked={chart.labels} onChange={(v) => set({ labels: v })} />
          <Check label="Switch rows and columns" checked={chart.byRows} onChange={(v) => set({ byRows: v })} />
        </div>
        <Field label="Title"><TextField aria-label="Chart title" key={chart.id} value={chart.title || ''} placeholder="Add a title" onCommit={(v) => set({ title: v.trim() })} /></Field>
        {chart.type !== 'pie' && <>
          <Field label="Horizontal axis"><TextField aria-label="Horizontal axis title" key={chart.id} value={chart.xTitle || ''} placeholder="Add an axis title" onCommit={(v) => set({ xTitle: v.trim() })} /></Field>
          <Field label="Vertical axis"><TextField aria-label="Vertical axis title" key={chart.id} value={chart.yTitle || ''} placeholder="Add an axis title" onCommit={(v) => set({ yTitle: v.trim() })} /></Field>
        </>}
        <Field label="Legend">
          <select class="select" aria-label="Legend" value={chart.legend || 'bottom'} onChange={(e) => set({ legend: e.target.value })}>
            <option value="bottom">Below the chart</option>
            <option value="right">To the right</option>
            <option value="none">Hidden</option>
          </select>
        </Field>
        <div class="chart-checks">
          {stackable && <Check label="Stack the series" checked={chart.stacked} onChange={(v) => set({ stacked: v })} />}
          <Check label="Show values" checked={chart.values} onChange={(v) => set({ values: v })} />
        </div>
        <Button kind="danger" icon={Trash2} onClick={onDelete}>Delete chart</Button>
      </div>
    </aside>
  )
}

export { readCharts, removeChart }
