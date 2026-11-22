// One slide drawn as plain elements at its natural size (1280 × 720). The
// stage, the thumbnails, the slide show and the printed pages all use this
// and scale it with CSS, so they can never disagree about what a slide looks
// like.
import { h } from 'preact'
import { ImagePlus } from 'lucide-preact'
import { cx } from '../lib/util.js'
import { themeOf, slideColors, slideVars, decor, resolve, placeholders, frameCss, textCss, shapeCss } from './slides-model.js'
import { textHTML } from './slides-text.js'

// memo: redraw only when a prop changed. Slides are pure functions of their
// props; the `v` prop counts changes to the slide's data.
function memo(View) {
  function Memo(props) {
    this.shouldComponentUpdate = (next) => {
      for (const k in next) if (next[k] !== this.props[k]) return true
      for (const k in this.props) if (!(k in next)) return true
      return false
    }
    return h(View, props)
  }
  return Memo
}

function Line({ e, colors }) {
  const sw = e.sw || 4
  const head = Math.max(12, sw * 3.5)
  const pad = head + sw
  const x = Math.min(e.x1, e.x2) - pad, y = Math.min(e.y1, e.y2) - pad
  const w = Math.abs(e.x2 - e.x1) + pad * 2, hh = Math.abs(e.y2 - e.y1) + pad * 2
  const stroke = resolve(colors, e.stroke) || colors.ink
  let ax = e.x1 - x, ay = e.y1 - y, bx = e.x2 - x, by = e.y2 - y
  const len = Math.hypot(bx - ax, by - ay) || 1
  const ux = (bx - ax) / len, uy = (by - ay) / len
  const tip = (px, py, dir) => {
    const cx0 = px - dir * ux * head, cy0 = py - dir * uy * head
    return `${px},${py} ${cx0 - uy * head * 0.45},${cy0 + ux * head * 0.45} ${cx0 + uy * head * 0.45},${cy0 - ux * head * 0.45}`
  }
  const heads = []
  if (e.head === 'end' || e.head === 'both') {
    heads.push(<polygon points={tip(bx, by, 1)} fill={stroke} />)
    bx -= ux * head * 0.8
    by -= uy * head * 0.8
  }
  if (e.head === 'both') {
    heads.push(<polygon points={tip(ax, ay, -1)} fill={stroke} />)
    ax += ux * head * 0.8
    ay += uy * head * 0.8
  }
  return (
    <svg class="sl-el sl-line" style={`left:${x}px;top:${y}px;width:${w}px;height:${hh}px`} viewBox={`0 0 ${w} ${hh}`}>
      <line data-el={e.id} class="sl-line-hit" x1={e.x1 - x} y1={e.y1 - y} x2={e.x2 - x} y2={e.y2 - y} stroke="transparent" stroke-width={Math.max(18, sw + 12)} stroke-linecap="round" />
      <g data-el={e.id}>
        <line x1={ax} y1={ay} x2={bx} y2={by} stroke={stroke} stroke-width={sw} stroke-linecap={heads.length ? 'butt' : 'round'} />
        {heads}
      </g>
    </svg>
  )
}

function Box({ e, layout, colors, mode, editing }) {
  const html = textHTML(e.text)
  const hint = !html && mode === 'edit' && placeholders[e.role]
  return (
    <div class={cx('sl-el sl-box', e.role && 'sl-role-' + e.role)} data-el={e.id} style={frameCss(e)}>
      {(e.shape !== 'none' || e.fill || e.stroke) && <div class="sl-shape" style={shapeCss(e, colors)} />}
      <div class="sl-box-text" style={textCss(e, layout, colors) + (editing ? 'visibility:hidden;' : '')}>
        {html ? <div class="sl-text" dangerouslySetInnerHTML={{ __html: html }} /> : hint ? <div class="sl-text sl-hint"><p>{hint}</p></div> : null}
      </div>
    </div>
  )
}

function Picture({ e, mode }) {
  return (
    <div class={cx('sl-el sl-img', !e.src && 'empty')} data-el={e.id} style={frameCss({ ...e, shape: 'rect' })}>
      {e.src ? <img src={e.src} alt={e.alt || ''} draggable={false} /> : mode === 'edit' ? <div class="sl-img-hint"><ImagePlus size={40} strokeWidth={1.5} /><span>Add a picture</span></div> : null}
    </div>
  )
}

// SlideView props: deck, id, v (change counter), themeId, mode (edit | thumb |
// show | print), live (geometry being dragged), editing (box being typed in).
export const SlideView = memo(function SlideView({ deck, id, themeId, mode = 'show', live, editing }) {
  const m = deck.slides.get(id)
  const theme = themeOf(themeId)
  if (!m) return <div class="sl-slide" style={`background:${theme.bg}`} />
  const layout = m.get('layout') || 'blank'
  const colors = slideColors(theme, layout, m.get('bg'))
  return (
    <div class={cx('sl-slide', 'sl-mode-' + mode)} style={slideVars(theme, colors) + `background:${colors.bg};`}>
      {decor(layout, colors).map((d, i) => <div key={'d' + i} class="sl-decor" style={`left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px;border-radius:${d.r}px;background:${d.fill}`} />)}
      {deck.els(id).map((raw) => {
        const e = live?.has(raw.id) ? { ...raw, ...live.get(raw.id) } : raw
        if (e.type === 'line') return <Line key={e.id} e={e} colors={colors} />
        if (e.type === 'image') return <Picture key={e.id} e={e} mode={mode} />
        return <Box key={e.id} e={e} layout={layout} colors={colors} mode={mode} editing={editing === e.id} />
      })}
    </div>
  )
})
