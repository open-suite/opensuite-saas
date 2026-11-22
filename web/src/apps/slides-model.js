// What a presentation is made of: slide size, themes, layouts and the small
// amount of geometry the editor, the renderer and the exporters share. Nothing
// here touches the DOM or the shared document.

export const W = 1280
export const H = 720

// Themes are built from the suite's own palette. A theme restyles every slide:
// elements refer to its colours by name ("ink", "accent", ...) unless someone
// picked a specific colour.
export const themes = {
  paper: { name: 'Paper', bg: '#ffffff', ink: '#102033', muted: '#617385', accent: '#1269e8', onAccent: '#ffffff', soft: '#e8f1fe', line: '#cbd5e0', font: 'sans' },
  midnight: { name: 'Midnight', bg: '#071c2f', ink: '#ffffff', muted: '#a9bccf', accent: '#ff5a1f', onAccent: '#ffffff', soft: '#12304d', line: '#2b4a68', font: 'sans' },
  ember: { name: 'Ember', bg: '#fff8f4', ink: '#2b1408', muted: '#8a6453', accent: '#ff5a1f', onAccent: '#ffffff', soft: '#ffe6da', line: '#f1cdbb', font: 'sans' },
  forest: { name: 'Forest', bg: '#f4f8f5', ink: '#0f2a20', muted: '#587467', accent: '#0e8a5f', onAccent: '#ffffff', soft: '#d8ece3', line: '#c2d8cd', font: 'sans' },
  graphite: { name: 'Graphite', bg: '#131c26', ink: '#e6edf5', muted: '#93a4b6', accent: '#4d94f7', onAccent: '#06121f', soft: '#17304e', line: '#34465a', font: 'sans' },
  editorial: { name: 'Editorial', bg: '#fbf9f4', ink: '#1f1b16', muted: '#756c5e', accent: '#c8321f', onAccent: '#ffffff', soft: '#f0eadd', line: '#dcd3c1', font: 'serif' },
}
export const themeIds = Object.keys(themes)
export const themeOf = (id) => themes[id] || themes.paper

export const fonts = {
  sans: { label: 'Sans', css: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif', office: 'Arial' },
  serif: { label: 'Serif', css: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif', office: 'Georgia' },
  mono: { label: 'Mono', css: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace', office: 'Courier New' },
}
export const fontKey = (css) => Object.keys(fonts).find((k) => fonts[k].css === css) || ''

export const tokens = ['ink', 'muted', 'accent', 'soft', 'bg', 'line', 'onAccent']
export const tokenLabels = { ink: 'Text', muted: 'Muted', accent: 'Accent', soft: 'Tint', bg: 'Background', line: 'Line', onAccent: 'On accent' }
export const palette = ['#102033', '#617385', '#c8321f', '#c2410c', '#a16207', '#15803d', '#0891b2', '#1269e8', '#4f46e5', '#7c3aed', '#be185d', '#ffffff']
export const fontSizes = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96]

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return 1
  const n = parseInt(m[1], 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export const isDark = (hex) => luminance(hex) < 0.4

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t)
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')
}

// slideColors gives the colours in force on one slide: the theme's, turned
// around on a section slide, and kept readable on a hand-picked background.
export function slideColors(theme, layout, bg) {
  let c = { bg: theme.bg, ink: theme.ink, muted: theme.muted, accent: theme.accent, onAccent: theme.onAccent, soft: theme.soft, line: theme.line }
  if (layout === 'section') {
    c = { bg: theme.accent, ink: theme.onAccent, muted: mix(theme.onAccent, theme.accent, 0.25), accent: theme.onAccent, onAccent: theme.accent, soft: mix(theme.accent, theme.onAccent, 0.18), line: mix(theme.accent, theme.onAccent, 0.35) }
  }
  if (bg && /^#[0-9a-f]{6}$/i.test(bg)) {
    const dark = isDark(bg)
    if (dark !== isDark(c.bg)) {
      c.ink = dark ? '#ffffff' : '#102033'
      c.muted = dark ? '#c3cfdc' : '#617385'
      c.line = dark ? mix(bg, '#ffffff', 0.25) : mix(bg, '#102033', 0.2)
      c.soft = dark ? mix(bg, '#ffffff', 0.12) : mix(bg, '#102033', 0.08)
    }
    c.bg = bg
  }
  return c
}

// What the slide hands down to everything drawn on it.
export const slideVars = (theme, colors) =>
  `--s-ink:${colors.ink};--s-muted:${colors.muted};--s-accent:${colors.accent};--s-line:${colors.line};color:${colors.ink};font-family:${fonts[theme.font].css};`

// resolve turns a stored colour (a theme name or a literal) into a literal.
// Anything that is not a plain colour is dropped: these values come from the
// shared document and end up inside style attributes.
export const resolve = (colors, v) => (tokens.includes(v) ? colors[v] : /^#[0-9a-f]{3,8}$/i.test(v || '') ? v : null)
const num = (v) => +v || 0

// Decoration a layout draws behind its content.
export function decor(layout, colors) {
  if (layout === 'title') return [{ x: 106, y: 112, w: 72, h: 8, r: 4, fill: colors.accent }]
  return []
}

// How text looks before anyone styles it, by the part it plays on the slide.
const roles = {
  title: { size: 40, weight: 700, lh: 1.15, color: 'ink', ls: -0.015 },
  subtitle: { size: 28, weight: 400, lh: 1.3, color: 'muted', ls: 0 },
  body: { size: 26, weight: 400, lh: 1.4, color: 'ink', ls: 0 },
  caption: { size: 20, weight: 400, lh: 1.4, color: 'muted', ls: 0 },
  text: { size: 24, weight: 400, lh: 1.35, color: 'ink', ls: 0 },
  shape: { size: 22, weight: 500, lh: 1.3, color: 'ink', ls: 0, align: 'center' },
}
export function roleStyle(layout, el) {
  const key = el.role || (el.shape && el.shape !== 'none' ? 'shape' : 'text')
  const r = { ...(roles[key] || roles.text) }
  if (key === 'title' && layout === 'title') Object.assign(r, { size: 68, lh: 1.05, ls: -0.025 })
  if (key === 'title' && layout === 'section') Object.assign(r, { size: 56, lh: 1.08, ls: -0.02 })
  return r
}

export const placeholders = { title: 'Click to add a title', subtitle: 'Click to add a subtitle', body: 'Click to add text', caption: 'Click to add a caption' }

export const layouts = {
  title: { name: 'Title', els: [
    { role: 'title', x: 96, y: 240, w: 1088, h: 160, valign: 'bottom' },
    { role: 'subtitle', x: 96, y: 416, w: 1088, h: 90, valign: 'top' },
  ] },
  titleBody: { name: 'Title and body', els: [
    { role: 'title', x: 80, y: 52, w: 1120, h: 104, valign: 'middle' },
    { role: 'body', x: 80, y: 176, w: 1120, h: 480, valign: 'top' },
  ] },
  twoCol: { name: 'Two columns', els: [
    { role: 'title', x: 80, y: 52, w: 1120, h: 104, valign: 'middle' },
    { role: 'body', slot: 1, x: 80, y: 176, w: 540, h: 480, valign: 'top' },
    { role: 'body', slot: 2, x: 660, y: 176, w: 540, h: 480, valign: 'top' },
  ] },
  section: { name: 'Section', els: [
    { role: 'title', x: 96, y: 232, w: 1088, h: 150, valign: 'bottom' },
    { role: 'subtitle', x: 96, y: 398, w: 1088, h: 80, valign: 'top' },
  ] },
  picture: { name: 'Picture with caption', els: [
    { role: 'picture', type: 'image', x: 64, y: 64, w: 720, h: 592 },
    { role: 'title', x: 832, y: 176, w: 384, h: 180, valign: 'bottom' },
    { role: 'caption', x: 832, y: 372, w: 384, h: 220, valign: 'top' },
  ] },
  blank: { name: 'Blank', els: [] },
}
export const layoutIds = Object.keys(layouts)

// --- geometry -------------------------------------------------------------

export const isLine = (el) => el.type === 'line'

export function bounds(el) {
  if (isLine(el)) {
    const x = Math.min(el.x1, el.x2), y = Math.min(el.y1, el.y2)
    return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) }
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}

export function rotate(px, py, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [px * c - py * s, px * s + py * c]
}

// outer is the axis-aligned box around an element after its rotation.
export function outer(el) {
  const b = bounds(el)
  if (isLine(el) || !el.rot) return b
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const xs = [], ys = []
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [rx, ry] = rotate((dx * b.w) / 2, (dy * b.h) / 2, el.rot)
    xs.push(cx + rx)
    ys.push(cy + ry)
  }
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function union(list) {
  if (!list.length) return null
  const x = Math.min(...list.map((b) => b.x)), y = Math.min(...list.map((b) => b.y))
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y }
}

export const shifted = (el, dx, dy) => (isLine(el) ? { x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy } : { x: el.x + dx, y: el.y + dy })

export const round = (n) => Math.round(n * 10) / 10

// resized returns the frame after dragging handle (hx, hy) by (dx, dy) in
// slide coordinates. The opposite side stays where it is, also when rotated.
export function resized(start, hx, hy, dx, dy, keepRatio, min = 12) {
  const [lx, ly] = rotate(dx, dy, -(start.rot || 0))
  let w = hx ? Math.max(min, start.w + hx * lx) : start.w
  let h = hy ? Math.max(min, start.h + hy * ly) : start.h
  if (keepRatio && hx && hy) {
    const k = Math.max(w / start.w, h / start.h)
    w = start.w * k
    h = start.h * k
  }
  const cx = start.x + start.w / 2, cy = start.y + start.h / 2
  const [ax, ay] = rotate((-hx * start.w) / 2, (-hy * start.h) / 2, start.rot || 0)
  const [bx, by] = rotate((-hx * w) / 2, (-hy * h) / 2, start.rot || 0)
  const nx = cx + ax - bx, ny = cy + ay - by
  return { x: round(nx - w / 2), y: round(ny - h / 2), w: round(w), h: round(h) }
}

// snap moves a box by at most `reach` so one of its edges or its centre meets
// a line others already sit on. Returns the correction and the lines to show.
export function snap(box, xs, ys, reach, edges = { x: [0, 0.5, 1], y: [0, 0.5, 1] }) {
  const one = (start, size, lines, parts) => {
    let best = null
    for (const p of parts) {
      const at = start + size * p
      for (const l of lines) {
        const d = l - at
        if (Math.abs(d) <= reach && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, l }
      }
    }
    return best
  }
  const sx = one(box.x, box.w, xs, edges.x), sy = one(box.y, box.h, ys, edges.y)
  return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0, gx: sx ? [sx.l] : [], gy: sy ? [sy.l] : [] }
}

// --- how a box is drawn -----------------------------------------------------
// The drawn slide and the live text editor use the same strings, so text does
// not shift by a pixel when someone starts typing in it.

const vertical = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
export const isShape = (el) => !!el.shape && el.shape !== 'none'

export function frameCss(el) {
  return `left:${num(el.x)}px;top:${num(el.y)}px;width:${num(el.w)}px;${isShape(el) ? 'height' : 'min-height'}:${num(el.h)}px;` + (num(el.rot) ? `transform:rotate(${num(el.rot)}deg);` : '')
}

export function textColor(el, layout, colors) {
  if (el.fill === 'accent') return colors.onAccent
  const fill = resolve(colors, el.fill)
  if (fill) return isDark(fill) ? '#ffffff' : '#102033'
  return colors[roleStyle(layout, el).color]
}

export const textPad = (el) => (isShape(el) ? [12, 16] : [6, 10])

export function textCss(el, layout, colors) {
  const r = roleStyle(layout, el)
  const [py, px] = textPad(el)
  return `justify-content:${vertical[el.valign] || (isShape(el) ? 'center' : 'flex-start')};font-size:${r.size}px;font-weight:${r.weight};line-height:${r.lh};` +
    `letter-spacing:${r.ls}em;color:${textColor(el, layout, colors)};text-align:${r.align || 'left'};padding:${py}px ${px}px;`
}

export function shapeCss(el, colors) {
  const fill = resolve(colors, el.fill), stroke = resolve(colors, el.stroke)
  return `background:${fill || 'transparent'};` + (stroke && el.sw !== 0 ? `border:${num(el.sw) || 2}px solid ${stroke};` : '') +
    (el.shape === 'round' ? 'border-radius:20px;' : el.shape === 'ellipse' ? 'border-radius:50%;' : '')
}

// between returns a sort key that falls between two neighbours.
export const between = (a, b) => (a == null && b == null ? 1 : a == null ? b - 1 : b == null ? a + 1 : (a + b) / 2)
