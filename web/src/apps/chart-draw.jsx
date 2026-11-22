// Chart drawing: plain SVG in the suite's own colours and type. Given a
// chart's settings and its data (labels + series of numbers), it lays out
// title, legend, axes and marks for one of six chart types.
export const chartTypes = [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['scatter', 'Scatter']]
export const palette = ['#1269e8', '#ff5a1f', '#0e9f6e', '#7c3aed', '#d4a106', '#0891b2', '#be185d', '#617385', '#4f46e5', '#15803d']
const hue = (i) => palette[i % palette.length]

const textW = (s, px = 11) => String(s).length * px * 0.56
const fit = (s, width, px = 11) => {
  s = String(s)
  const n = Math.max(1, Math.floor(width / (px * 0.56)))
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'
}

function ticks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1
  const raw = (hi - lo) / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out = []
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(+v.toFixed(10))
  return out
}

// Axis numbers follow the cells they came from: percentages stay
// percentages, and a currency sign is carried over.
function numberStyle(series) {
  const sample = series.flatMap((s) => s.texts.filter((t, i) => t && !isNaN(s.values[i])))
  const pct = sample.length > 0 && sample.every((t) => t.includes('%'))
  const prefix = sample.length > 0 ? (/^[^\d\-(.]{1,3}/.exec(sample[0]) || [''])[0] : ''
  const lead = prefix && sample.every((t) => t.startsWith(prefix)) ? prefix : ''
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
  const plain = new Intl.NumberFormat('en', { maximumSignificantDigits: 6 })
  // One style for a whole axis: short forms only once the numbers are long.
  return (v, top = v) => {
    if (pct) return +(v * 100).toPrecision(6) + '%'
    return lead + (Math.abs(top) >= 1e6 ? compact.format(v) : plain.format(v))
  }
}

function Legend({ items, x, y, width, side }) {
  const out = []
  let cx = 0
  let cy = 0
  items.forEach((name, i) => {
    const w = 18 + Math.min(textW(name, 12), side ? width - 18 : 170) + 14
    if (side) { if (i) cy += 18 } else if (cx && cx + w > width) { cx = 0; cy += 18 }
    out.push(
      <g key={i} transform={`translate(${x + cx},${y + cy})`}>
        <rect width="10" height="10" y="1" rx="2.5" fill={hue(i)} />
        <text class="ch-legend" x="16" y="10">{fit(name, side ? width - 18 : 170, 12)}</text>
      </g>,
    )
    if (!side) cx += w
  })
  return { nodes: out, height: cy + 18 }
}

const legendHeight = (items, width) => {
  let cx = 0
  let lines = 1
  for (const name of items) {
    const w = 18 + Math.min(textW(name, 12), 170) + 14
    if (cx && cx + w > width) { cx = 0; lines++ }
    cx += w
  }
  return lines * 18
}

function Message({ w, h, text }) {
  return <svg class="ch" width={w} height={h}><text class="ch-msg" x={w / 2} y={h / 2} text-anchor="middle">{fit(text, w - 24, 12.5)}</text></svg>
}

export function Chart({ chart, data, w, h }) {
  if (data.missing) return <Message w={w} h={h} text="The cells this chart was drawn from were deleted" />
  const type = chart.type
  let { labels, series } = data
  series = series.filter((s) => s.values.some((v) => !isNaN(v)))
  if (!series.length) return <Message w={w} h={h} text="Choose cells with numbers to draw this chart" />

  const pad = 12
  let top = pad
  const title = chart.title ? <text class="ch-title" x={pad} y={pad + 13}>{fit(chart.title, w - 2 * pad, 13.5)}</text> : null
  if (title) top += 26

  const pie = type === 'pie'
  let xs = null
  if (type === 'scatter') {
    if (data.xs?.some((v) => !isNaN(v))) xs = data.xs
    else if (series.length > 1) { xs = series[0].values; series = series.slice(1) } else xs = series[0].values.map((_, i) => i + 1)
  }
  const names = pie ? labels : series.map((s) => s.name)
  const where = chart.legend || 'bottom'
  const showLegend = where !== 'none' && (pie || series.length > 1)
  let right = w - pad
  let bottom = h - pad
  let legend = null
  if (showLegend && where === 'right') {
    const lw = Math.min(160, Math.max(...names.map((n) => textW(n, 12))) + 22, w * 0.34)
    legend = Legend({ items: names, x: w - pad - lw, y: top + 2, width: lw, side: true }).nodes
    right -= lw + 10
  } else if (showLegend) {
    const lh = Math.min(legendHeight(names, w - 2 * pad), 54)
    legend = Legend({ items: names, x: pad, y: h - pad - lh + 2, width: w - 2 * pad }).nodes
    bottom -= lh + 6
  }

  const body = []
  if (pie) {
    const vals = series[0].values.map((v) => (v > 0 ? v : 0))
    const sum = vals.reduce((a, b) => a + b, 0)
    const cx = (pad + right) / 2
    const cy = (top + bottom) / 2
    const r = Math.max(10, Math.min(right - pad, bottom - top) / 2 - 2)
    let a0 = -Math.PI / 2
    vals.forEach((v, i) => {
      if (!v || !sum) return
      const a1 = a0 + (v / sum) * Math.PI * 2
      const tip = `${labels[i]}: ${series[0].texts[i]} (${Math.round((v / sum) * 1000) / 10}%)`
      if (v === sum) body.push(<circle key={i} cx={cx} cy={cy} r={r} fill={hue(i)}><title>{tip}</title></circle>)
      else {
        const p = (a, rad = r) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`
        body.push(<path key={i} class="ch-slice" d={`M${cx},${cy} L${p(a0)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z`} fill={hue(i)}><title>{tip}</title></path>)
        if (chart.values && a1 - a0 > 0.3) {
          const [lx, ly] = p((a0 + a1) / 2, r * 0.64).split(',')
          body.push(<text key={'t' + i} class="ch-in" x={lx} y={+ly + 4} text-anchor="middle">{Math.round((v / sum) * 100)}%</text>)
        }
      }
      a0 = a1
    })
    return <svg class="ch" width={w} height={h} role="img" aria-label={chart.title || 'Pie chart'}>{title}{body}{legend}</svg>
  }

  const fmt = numberStyle(series)
  const horizontal = type === 'bar'
  const stacked = !!chart.stacked && (type === 'column' || type === 'bar' || type === 'area')
  const n = labels.length
  // Value range.
  let lo = Infinity
  let hi = -Infinity
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0
      let neg = 0
      for (const s of series) { const v = s.values[i]; if (v > 0) pos += v; else if (v < 0) neg += v }
      lo = Math.min(lo, neg)
      hi = Math.max(hi, pos)
    }
  } else for (const s of series) for (const v of s.values) if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  if (type !== 'line' && type !== 'scatter') { lo = Math.min(lo, 0); hi = Math.max(hi, 0) }
  const vt = ticks(lo, hi, horizontal ? Math.max(2, Math.floor((right - pad) / 90)) : Math.max(2, Math.floor((bottom - top) / 44)))
  lo = vt[0]
  hi = vt[vt.length - 1]
  const vfmt = (v) => fmt(v, Math.max(Math.abs(lo), Math.abs(hi)))
  let xt = null
  let xlo = 0
  let xhi = 1
  if (xs) {
    const real = xs.filter((v) => !isNaN(v))
    xt = ticks(Math.min(...real), Math.max(...real), Math.max(2, Math.floor((right - pad) / 90)))
    xlo = xt[0]
    xhi = xt[xt.length - 1]
  }

  const ytitle = chart.yTitle ? 16 : 0
  const xtitle = chart.xTitle ? 16 : 0
  const left = pad + ytitle + (horizontal ? Math.min(130, Math.max(...labels.map((l) => textW(l)), 12) + 8) : Math.max(...vt.map((v) => textW(vfmt(v)))) + 8)
  const base = bottom - 18 - xtitle
  const pw = Math.max(20, right - left - (horizontal || xs ? 10 : 0))
  const ph = Math.max(20, base - top - 6)
  const y0 = top + 6
  const val = horizontal ? (v) => left + ((v - lo) / (hi - lo)) * pw : (v) => y0 + ph - ((v - lo) / (hi - lo)) * ph
  const px = (v) => left + ((v - xlo) / (xhi - xlo)) * pw

  // Grid and value axis.
  for (const v of vt) {
    if (horizontal) {
      body.push(<line key={'g' + v} class={v === 0 ? 'ch-axis' : 'ch-grid'} x1={val(v)} x2={val(v)} y1={y0} y2={y0 + ph} />)
      body.push(<text key={'l' + v} class="ch-tick" x={val(v)} y={y0 + ph + 14} text-anchor="middle">{vfmt(v)}</text>)
    } else {
      body.push(<line key={'g' + v} class={v === 0 ? 'ch-axis' : 'ch-grid'} x1={left} x2={left + pw} y1={val(v)} y2={val(v)} />)
      body.push(<text key={'l' + v} class="ch-tick" x={left - 6} y={val(v) + 3.5} text-anchor="end">{vfmt(v)}</text>)
    }
  }
  // Category (or horizontal value) axis.
  const band = (horizontal ? ph : pw) / Math.max(1, n)
  if (xs) {
    const xf = numberStyle([{ values: xs, texts: labels }])
    for (const v of xt) {
      body.push(<line key={'xg' + v} class="ch-grid" x1={px(v)} x2={px(v)} y1={y0} y2={y0 + ph} />)
      body.push(<text key={'xl' + v} class="ch-tick" x={px(v)} y={y0 + ph + 14} text-anchor="middle">{xf(v, Math.max(Math.abs(xlo), Math.abs(xhi)))}</text>)
    }
  } else if (horizontal) {
    const every = Math.ceil(n / Math.max(1, Math.floor(ph / 16)))
    labels.forEach((l, i) => i % every === 0 && body.push(<text key={'c' + i} class="ch-tick" x={left - 6} y={y0 + band * (i + 0.5) + 3.5} text-anchor="end">{fit(l, left - pad - ytitle - 8)}</text>))
  } else {
    const every = Math.ceil(n / Math.max(1, Math.floor(pw / 56)))
    labels.forEach((l, i) => i % every === 0 && body.push(<text key={'c' + i} class="ch-tick" x={left + band * (i + 0.5)} y={y0 + ph + 14} text-anchor="middle">{fit(l, band * every - 6)}</text>))
  }
  if (chart.xTitle) body.push(<text key="xt" class="ch-axis-title" x={left + pw / 2} y={bottom - 2} text-anchor="middle">{fit(chart.xTitle, pw)}</text>)
  if (chart.yTitle) body.push(<text key="yt" class="ch-axis-title" transform={`translate(${pad + 10},${y0 + ph / 2}) rotate(-90)`} text-anchor="middle">{fit(chart.yTitle, ph)}</text>)

  const tip = (s, i) => `${s.name}\n${xs ? '' : labels[i] + ': '}${s.texts[i]}`
  if (type === 'column' || type === 'bar') {
    const group = band * 0.72
    const bw = Math.max(1, group / (stacked ? 1 : series.length))
    for (let i = 0; i < n; i++) {
      let pos = 0
      let neg = 0
      series.forEach((s, k) => {
        const v = s.values[i]
        if (isNaN(v)) return
        const from = stacked ? (v >= 0 ? pos : neg) : 0
        const to = from + v
        if (stacked) v >= 0 ? (pos = to) : (neg = to)
        const a = Math.min(val(from), val(to))
        const len = Math.max(1, Math.abs(val(to) - val(from)))
        const off = band * (i + 0.5) - group / 2 + (stacked ? 0 : k * bw)
        const rect = horizontal ? { x: a, y: y0 + off, width: len, height: Math.max(1, bw - 1) } : { x: left + off, y: a, width: Math.max(1, bw - 1), height: len }
        body.push(<rect key={`b${i}-${k}`} class="ch-bar" {...rect} rx={Math.min(2, bw / 4)} fill={hue(k)}><title>{tip(s, i)}</title></rect>)
        if (chart.values && stacked) {
          // Inside its own segment, when there is room for it.
          if (len > 15 && bw > 14) body.push(<text key={`v${i}-${k}`} class="ch-in" x={horizontal ? a + len / 2 : left + off + bw / 2} y={(horizontal ? y0 + off + bw / 2 : a + len / 2) + 4} text-anchor="middle">{fit(s.texts[i], horizontal ? len : Math.max(bw, 40), 11)}</text>)
        } else if (chart.values && bw > 14) {
          body.push(horizontal
            ? <text key={`v${i}-${k}`} class="ch-val" x={val(to) + (v >= 0 ? 4 : -4)} y={y0 + off + bw / 2 + 3} text-anchor={v >= 0 ? 'start' : 'end'}>{s.texts[i]}</text>
            : <text key={`v${i}-${k}`} class="ch-val" x={left + off + bw / 2} y={val(to) + (v >= 0 ? -4 : 12)} text-anchor="middle">{fit(s.texts[i], Math.max(bw, 40), 10.5)}</text>)
        }
      })
    }
  } else if (type === 'scatter') {
    series.forEach((s, k) => s.values.forEach((v, i) => {
      if (isNaN(v) || isNaN(xs[i])) return
      body.push(<circle key={`p${k}-${i}`} class="ch-dot" cx={px(xs[i])} cy={val(v)} r="4" fill={hue(k)}><title>{`${s.name}\n${labels[i]}, ${s.texts[i]}`}</title></circle>)
    }))
  } else {
    // Line and area: one path per series, broken where a value is missing.
    const sums = new Array(n).fill(0)
    const paths = []
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => {
        if (isNaN(v)) return null
        const from = stacked ? sums[i] : 0
        if (stacked) sums[i] += v
        return { x: left + band * (i + 0.5), y: val(from + v), y0: val(Math.max(lo, Math.min(hi, from))), i }
      })
      const runs = []
      let run = []
      for (const p of pts) { if (p) run.push(p); else if (run.length) { runs.push(run); run = [] } }
      if (run.length) runs.push(run)
      runs.forEach((r, j) => {
        const line = r.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')
        if (type === 'area') paths.push(<path key={`a${k}-${j}`} d={`${line} ${[...r].reverse().map((p) => `L${p.x},${p.y0}`).join(' ')} Z`} fill={hue(k)} opacity={stacked ? 0.55 : 0.2} />)
        paths.push(<path key={`l${k}-${j}`} class="ch-line" d={line} stroke={hue(k)} />)
      })
      for (const p of pts) {
        if (!p) continue
        if (n <= 60) paths.push(<circle key={`p${k}-${p.i}`} class="ch-dot" cx={p.x} cy={p.y} r={n > 30 ? 2 : 3} fill={hue(k)}><title>{tip(s, p.i)}</title></circle>)
        if (chart.values && band > 30) paths.push(<text key={`v${k}-${p.i}`} class="ch-val" x={p.x} y={p.y - 7} text-anchor="middle">{fit(s.texts[p.i], band, 10.5)}</text>)
      }
    })
    body.push(...paths)
  }
  return <svg class="ch" width={w} height={h} role="img" aria-label={chart.title || 'Chart'}>{title}{body}{legend}</svg>
}
