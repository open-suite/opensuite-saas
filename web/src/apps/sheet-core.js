// Spreadsheet controller: owns the calculation model, the canvas grid and the
// live sync. The view (sheet.jsx) only draws chrome around it.
//
// Sync model. Engine diffs are order-dependent, so the server's sequence is
// the truth: state = base snapshot + confirmed log (server order) + our own
// unconfirmed edits. Edits apply locally at once. If someone else's edit
// lands while ours are unconfirmed, the model is rebuilt in server order, so
// every participant converges on the same sheet.
import init, { Model } from '@ironcalc/wasm-xlsx'
import wasmUrl from '@ironcalc/wasm-xlsx/wasm_bg.wasm?url'
import { DocSocket, fetchState } from '../lib/sync.js'
import { whenCreated } from '../lib/docs.js'
import { kvGet, kvSet } from '../lib/idb.js'
import { csvSnapshot } from '../lib/csv.js'
import { colorFor, debounce } from '../lib/util.js'
import { blank, applyDiff, loadModel, xlsxSnapshot, colName, sheetText } from './sheet-data.js'

export { colName }

let ready
let engineUp = false
// The engine starts downloading as soon as this module is loaded in the
// background, well before a spreadsheet is opened.
export const engine = () => (ready ??= init({ module_or_path: wasmUrl }).then(() => (engineUp = true)))
engine()

// Device copies of recently used spreadsheets, held in memory so opening one
// does not wait even for local storage.
const warm = new Map() // doc id -> { seq, bytes }

function keepWarm(id, copy) {
  warm.delete(id)
  warm.set(id, copy)
  if (warm.size > 16) warm.delete(warm.keys().next().value)
}

// prewarmSheets runs while idle: device copies are read into memory, and a
// spreadsheet this device has never held is fetched and stored first.
export async function prewarmSheets(ids) {
  // Build and discard one workbook so the first real one runs on warm code.
  await engine()
  blank().free()
  for (const id of ids) {
    if (warm.has(id)) continue
    try {
      let copy = await kvGet('sheet:' + id)
      if (!copy?.bytes) {
        const state = await fetchState(id)
        await engine()
        const m = loadModel(state)
        copy = { seq: state.seq, bytes: m.toBytes() }
        m.free()
        kvSet('sheet:' + id, copy)
      }
      if (!warm.has(id)) keepWarm(id, copy)
    } catch {}
  }
}

export const HW = 46 // row header width
export const HH = 24 // column header height
const MAXR = 1048576
const MAXC = 16384
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Arial, sans-serif'

// Uploaded workbooks and .csv files are converted to the engine's own format.
export async function xlsxToSnapshot(bytes, name) {
  await engine()
  return xlsxSnapshot(bytes, name)
}

export async function csvToSnapshot(text, name) {
  await engine()
  return csvSnapshot(text, name)
}

export class Sheet {
  // frozen: { base, updates } shows a past version instead: the same grid,
  // read-only and with no live connection.
  constructor({ id, me, title, onChange, frozen = null }) {
    this.id = id
    this.me = me
    this.title = title
    this.onChange = onChange
    this.frozen = frozen
    this.model = null
    this.sheet = 0
    this.sheetId = null // the open sheet's own id, which survives reordering
    this.rev = 0 // goes up whenever the workbook's content may have changed
    this.sel = { row: 1, col: 1, r1: 1, c1: 1, r2: 1, c2: 1 }
    this.draft = null // text being typed, or null when not editing
    this.base = null // snapshot bytes the log builds on
    this.log = [] // confirmed diffs, server order
    this.mine = [] // our diffs not yet confirmed, send order
    this.cells = new Map()
    this.peers = new Map()
    this.online = false
    this.canEdit = true
    this.R = 0
    this.C = 0
    this.clip = null
    this.frame = 0
    this.closed = false
    this.saveLocal = debounce(() => this.cacheNow(), 1200)
    this.tell = debounce(() => this.sendPresence(), 60)
  }

  // --- lifecycle -----------------------------------------------------------

  open(wrap, canvas, scroll, spacer) {
    this.wrap = wrap
    this.canvas = canvas
    this.scroll = scroll
    this.spacer = spacer
    this.ctx = canvas.getContext('2d')
    if (this.frozen) {
      engine().then(() => this.closed || this.start(null))
      return
    }
    const hot = warm.get(this.id)
    // With the engine loaded and a copy in memory, the grid is drawn in the
    // same frame as the click that opened it.
    if (hot && engineUp) this.start(hot)
    else Promise.all([hot || kvGet('sheet:' + this.id), engine()]).then(([cached]) => this.closed || this.start(cached))
  }

  start(cached) {
    const { wrap, scroll } = this
    const t0 = performance.now()
    let since = 0
    if (cached?.bytes) {
      try {
        this.model = Model.fromBytes(cached.bytes, 'en')
        this.base = cached.bytes
        since = cached.seq
      } catch {}
    }
    if (this.frozen) {
      this.canEdit = false
      try {
        this.model = loadModel(this.frozen, this.title)
      } catch {}
    }
    if (!this.model) this.model = blank(this.title)
    const t1 = performance.now()
    this.afterLoad()
    const t2 = performance.now()

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(wrap)
    scroll.addEventListener('scroll', this.onScroll)
    scroll.addEventListener('pointerdown', this.onPointerDown)
    scroll.addEventListener('pointermove', this.onPointerMove)
    scroll.addEventListener('pointerup', this.onPointerUp)
    scroll.addEventListener('dblclick', this.onDblClick)
    document.addEventListener('copy', this.onCopy)
    document.addEventListener('cut', this.onCopy)
    document.addEventListener('paste', this.onPaste)
    this.dark = matchMedia('(prefers-color-scheme: dark)')
    this.dark.addEventListener('change', this.onTheme)
    this.readTheme()
    this.resize()
    if (!document.activeElement || document.activeElement === document.body) wrap.focus()
    // Where opening a sheet spends its time, for tests/perf.cjs.
    this.timing = { model: t1 - t0, layout: t2 - t1, paint: performance.now() - t2 }
    if (this.frozen) return
    window.__sheetTiming = this.timing

    this.sock = new DocSocket(this.id, {
      hello: (peer, canEdit) => {
        this.canEdit = canEdit
        this.onChange()
      },
      base: (seq, bytes) => {
        if (!bytes.length && !seq) return // a brand-new sheet: keep what is on screen
        // A base also arrives mid-session when a past version is restored.
        this.base = bytes.length ? bytes.slice() : null
        this.log = []
        this.rebuild()
      },
      update: (seq, bytes, mine) => {
        const diff = bytes.slice()
        if (mine) {
          // One of ours, confirmed during a replay after reconnecting.
          this.mine.shift()
          this.log.push(diff)
        } else if (this.mine.length === 0) {
          this.log.push(diff)
          this.apply(diff)
          this.changed(false)
        } else {
          this.log.push(diff)
          this.rebuild()
        }
        this.saveLocal()
      },
      ack: () => {
        const diff = this.mine.shift()
        if (diff) this.log.push(diff)
        this.saveLocal()
        this.onChange()
      },
      synced: () => {
        this.sendPresence()
        this.compact()
      },
      awareness: (peer, bytes) => {
        const known = this.peers.has(peer)
        try {
          const state = JSON.parse(new TextDecoder().decode(bytes))
          const was = this.peers.get(peer)
          // The name tag shows for a moment after someone moves, then gets
          // out of the way of the cell above it.
          state.at = was && was.r === state.r && was.c === state.c && was.s === state.s ? was.at : Date.now()
          this.peers.set(peer, state)
          setTimeout(() => this.draw(), 2600)
        } catch {}
        if (!known) this.sendPresence()
        this.draw()
        this.onChange()
      },
      leave: (peer) => {
        this.peers.delete(peer)
        this.draw()
        this.onChange()
      },
      title: (t) => this.onTitle?.(t),
      status: (online) => {
        this.online = online
        this.onChange()
      },
    }, since, whenCreated(this.id))
    // Search: the socket sends these words to the server's index (lib/sync.js).
    this.sock.text = () => sheetText(this.model)
  }

  close() {
    this.closed = true
    if (this.draft !== null) this.commit()
    this.cacheNow()
    this.sock?.close()
    this.ro?.disconnect()
    cancelAnimationFrame(this.frame)
    this.scroll?.removeEventListener('scroll', this.onScroll)
    document.removeEventListener('copy', this.onCopy)
    document.removeEventListener('cut', this.onCopy)
    document.removeEventListener('paste', this.onPaste)
    this.dark?.removeEventListener('change', this.onTheme)
    this.model?.free()
    this.model = null
  }

  afterLoad() {
    // Stay on the same sheet when others add, remove or reorder sheets, and
    // never land on a hidden one (the workbook keeps chart data in those).
    const all = this.model.getWorksheetsProperties()
    let i = all.findIndex((sh) => sh.sheet_id === this.sheetId && sh.state === 'visible')
    if (i < 0) i = all[this.sheet]?.state === 'visible' && this.sheetId === null ? this.sheet : all.findIndex((sh) => sh.state === 'visible')
    this.sheet = Math.max(0, i)
    this.sheetId = all[this.sheet]?.sheet_id ?? null
    this.model.setSelectedSheet(this.sheet)
    this.rev++
    this.cells.clear()
    this.measure()
    this.onChange()
    this.draw()
  }

  // --- sync ----------------------------------------------------------------

  apply(diff) {
    applyDiff(this.model, diff)
  }

  // rebuild replays everything in the order the server settled on.
  rebuild() {
    let m
    try {
      m = this.base ? Model.fromBytes(this.base, 'en') : blank(this.title)
    } catch {
      m = blank(this.title)
    }
    this.model?.free()
    this.model = m
    for (const d of this.log) this.apply(d)
    for (const d of this.mine) this.apply(d)
    this.afterLoad()
    this.pushSelection()
  }

  // push sends whatever the last action changed and refreshes the screen.
  push() {
    const diff = this.model.flushSendQueue()
    if (diff.length > 1) {
      this.mine.push(diff)
      this.sock.sendUpdate(diff)
    }
    this.changed(true)
  }

  changed(local) {
    this.rev++
    this.cells.clear()
    this.measure()
    this.draw()
    this.onChange()
    if (local) this.saveLocal()
  }

  get saved() {
    return this.mine.length === 0
  }

  // The device copy is only written when it equals a known server sequence,
  // so reopening can resume from exactly that point.
  cacheNow() {
    if (!this.model || this.mine.length || !this.sock) return
    const copy = { seq: this.sock.seq, bytes: this.model.toBytes() }
    keepWarm(this.id, copy)
    kvSet('sheet:' + this.id, copy)
  }

  compact() {
    if (this.log.length < 150 || this.mine.length || !this.sock.online || !this.canEdit) return
    this.base = this.model.toBytes()
    this.log = []
    this.sock.sendSnapshot(this.sock.seq, this.base)
  }

  sendPresence() {
    if (!this.sock) return
    const state = { u: { id: this.me.id, name: this.me.name, color: colorFor(this.me.id) }, s: this.sheet, r: this.sel.row, c: this.sel.col }
    this.sock.sendAwareness(new TextEncoder().encode(JSON.stringify(state)))
  }

  // --- geometry ------------------------------------------------------------

  measure() {
    const m = this.model
    const s = this.sheet
    let maxRow = 0
    let maxCol = 0
    for (let c = 1; c <= 40; c++) for (const r of m.getRowsWithData(s, c)) if (r > maxRow) maxRow = r
    for (let r = 1; r <= 60; r++) for (const c of m.getColumnsWithData(s, r)) if (c > maxCol) maxCol = c
    this.R = Math.min(MAXR, Math.max(this.R, 300, maxRow + 100, this.sel.row + 60))
    this.C = Math.min(MAXC, Math.max(this.C, 40, maxCol + 12, this.sel.col + 12))
    this.colX = new Float64Array(this.C + 1)
    this.rowY = new Float64Array(this.R + 1)
    for (let c = 1; c <= this.C; c++) this.colX[c] = this.colX[c - 1] + m.getColumnWidth(s, c)
    for (let r = 1; r <= this.R; r++) this.rowY[r] = this.rowY[r - 1] + m.getRowHeight(s, r)
    this.merged = m.getMergedCells(s)
    this.covered = new Map()
    for (const g of this.merged) {
      for (let r = g.row; r < g.row + g.height; r++) for (let c = g.column; c < g.column + g.width; c++) this.covered.set(r * 20000 + c, g)
    }
    this.gridLines = m.getShowGridLines(s)
    if (this.spacer) {
      this.spacer.style.width = HW + this.colX[this.C] + 80 + 'px'
      this.spacer.style.height = HH + this.rowY[this.R] + 80 + 'px'
    }
  }

  // index of the row/column containing offset v (content coordinates)
  at(prefix, v) {
    let lo = 1
    let hi = prefix.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (prefix[mid] <= v) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  rect(row, col) {
    const g = this.covered?.get(row * 20000 + col)
    const r1 = g ? g.row : row
    const c1 = g ? g.column : col
    const r2 = g ? g.row + g.height - 1 : row
    const c2 = g ? g.column + g.width - 1 : col
    const x = HW + this.colX[Math.min(c1, this.C) - 1] - this.scroll.scrollLeft
    const y = HH + this.rowY[Math.min(r1, this.R) - 1] - this.scroll.scrollTop
    return { x, y, w: this.colX[Math.min(c2, this.C)] - this.colX[Math.min(c1, this.C) - 1], h: this.rowY[Math.min(r2, this.R)] - this.rowY[Math.min(r1, this.R) - 1] }
  }

  reveal(row = this.sel.row, col = this.sel.col) {
    if (row > this.R - 20 || col > this.C - 4) this.measure()
    const s = this.scroll
    const x0 = this.colX[col - 1]
    const x1 = this.colX[col]
    const y0 = this.rowY[row - 1]
    const y1 = this.rowY[row]
    const vw = s.clientWidth - HW
    const vh = s.clientHeight - HH
    if (x0 < s.scrollLeft) s.scrollLeft = x0
    else if (x1 > s.scrollLeft + vw) s.scrollLeft = x1 - vw
    if (y0 < s.scrollTop) s.scrollTop = y0
    else if (y1 > s.scrollTop + vh) s.scrollTop = y1 - vh
  }

  // --- cell data -----------------------------------------------------------

  cell(row, col) {
    const key = row * 20000 + col
    let c = this.cells.get(key)
    if (c) return c
    const m = this.model
    const text = m.getFormattedCellValue(this.sheet, row, col)
    const st = m.getCellStyle(this.sheet, row, col).style
    const f = st.font || {}
    const type = text ? m.getCellType(this.sheet, row, col) : 0
    let align = st.alignment?.horizontal || 'general'
    if (align === 'general') align = type === 1 ? 'right' : type === 4 || type === 16 ? 'center' : 'left'
    c = {
      text,
      bold: !!f.b, italic: !!f.i, under: !!f.u, strike: !!f.strike,
      px: Math.round((f.sz || 12) * 1.0834),
      color: f.color ? m.resolveColor(f.color) : '',
      fill: st.fill?.color ? m.resolveColor(st.fill.color) : '',
      align: align === 'center' || align === 'right' ? align : 'left',
      border: st.border && (st.border.left || st.border.right || st.border.top || st.border.bottom) ? st.border : null,
      error: type === 16,
    }
    this.cells.set(key, c)
    return c
  }

  style() {
    return this.model.getCellStyle(this.sheet, this.sel.row, this.sel.col).style
  }

  content(row = this.sel.row, col = this.sel.col) {
    return this.model.getCellContent(this.sheet, row, col)
  }

  get sheets() {
    return this.model ? this.model.getWorksheetsProperties() : []
  }

  area() {
    const { r1, c1, r2, c2 } = this.sel
    return { sheet: this.sheet, row: r1, column: c1, width: c2 - c1 + 1, height: r2 - r1 + 1 }
  }

  // --- drawing -------------------------------------------------------------

  readTheme() {
    const css = getComputedStyle(document.documentElement)
    const v = (n) => css.getPropertyValue(n).trim()
    this.theme = { bg: v('--bg'), head: v('--canvas'), line: v('--line'), strong: v('--line-strong'), ink: v('--ink'), muted: v('--muted'), accent: v('--accent'), soft: v('--accent-soft'), danger: v('--danger') }
  }

  onTheme = () => {
    this.readTheme()
    this.draw()
  }

  resize() {
    const dpr = window.devicePixelRatio || 1
    const w = this.wrap.clientWidth
    const h = this.wrap.clientHeight
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
    this.paint()
    this.onView?.()
  }

  draw() {
    if (this.frame || !this.model || !this.ctx) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  paint() {
    if (!this.model || !this.colX) return
    const ctx = this.ctx
    const T = this.theme
    const dpr = window.devicePixelRatio || 1
    const W = this.canvas.width / dpr
    const H = this.canvas.height / dpr
    const sx = this.scroll.scrollLeft
    const sy = this.scroll.scrollTop
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = T.bg
    ctx.fillRect(0, 0, W, H)

    const c0 = this.at(this.colX, sx)
    const r0 = this.at(this.rowY, sy)
    let c9 = c0
    while (c9 < this.C && HW + this.colX[c9] - sx < W) c9++
    let r9 = r0
    while (r9 < this.R && HH + this.rowY[r9] - sy < H) r9++
    const X = (c) => HW + this.colX[c] - sx // right edge of column c
    const Y = (r) => HH + this.rowY[r] - sy // bottom edge of row r

    ctx.save()
    ctx.beginPath()
    ctx.rect(HW, HH, W - HW, H - HH)
    ctx.clip()

    // fills
    for (let r = r0; r <= r9; r++) {
      for (let c = c0; c <= c9; c++) {
        const g = this.covered.get(r * 20000 + c)
        if (g && (g.row !== r || g.column !== c)) continue
        const cell = this.cell(r, c)
        if (!cell.fill) continue
        const b = g ? this.rect(r, c) : { x: X(c - 1), y: Y(r - 1), w: X(c) - X(c - 1), h: Y(r) - Y(r - 1) }
        ctx.fillStyle = cell.fill
        ctx.fillRect(b.x, b.y, b.w, b.h)
      }
    }

    // grid
    if (this.gridLines) {
      ctx.strokeStyle = T.line
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let c = c0; c <= c9; c++) {
        const x = Math.round(X(c)) - 0.5
        ctx.moveTo(x, HH)
        ctx.lineTo(x, H)
      }
      for (let r = r0; r <= r9; r++) {
        const y = Math.round(Y(r)) - 0.5
        ctx.moveTo(HW, y)
        ctx.lineTo(W, y)
      }
      ctx.stroke()
    }
    // merged areas hide the grid inside them
    for (const g of this.merged) {
      if (g.row > r9 || g.row + g.height - 1 < r0 || g.column > c9 || g.column + g.width - 1 < c0) continue
      const b = this.rect(g.row, g.column)
      ctx.fillStyle = this.cell(g.row, g.column).fill || T.bg
      ctx.fillRect(b.x, b.y, b.w - 1, b.h - 1)
    }

    // text and borders
    ctx.textBaseline = 'alphabetic'
    for (let r = r0; r <= r9; r++) {
      for (let c = c0; c <= c9; c++) {
        const g = this.covered.get(r * 20000 + c)
        if (g && (g.row !== r || g.column !== c)) continue
        const cell = this.cell(r, c)
        const b = g ? this.rect(r, c) : { x: X(c - 1), y: Y(r - 1), w: X(c) - X(c - 1), h: Y(r) - Y(r - 1) }
        if (cell.border) this.strokeBorder(ctx, cell.border, b)
        if (!cell.text) continue
        ctx.font = `${cell.italic ? 'italic ' : ''}${cell.bold ? '650 ' : ''}${cell.px}px ${FONT}`
        const tw = ctx.measureText(cell.text).width
        // Long text runs over empty neighbours to its right, as in any sheet.
        let right = b.x + b.w
        if (cell.align === 'left' && tw > b.w - 8 && !g) {
          for (let n = c + 1; n <= c9 + 1 && n <= this.C && right < b.x + tw + 8; n++) {
            const next = this.cell(r, n)
            if (next.text || next.fill || this.covered.has(r * 20000 + n)) break
            right = X(n)
          }
        }
        ctx.save()
        ctx.beginPath()
        ctx.rect(b.x + 1, b.y, right - b.x - 2, b.h)
        ctx.clip()
        const tx = cell.align === 'right' ? b.x + b.w - 5 - tw : cell.align === 'center' ? b.x + (b.w - tw) / 2 : b.x + 5
        const ty = b.y + b.h - Math.max(5, (Math.min(b.h, 25) - cell.px) / 2 + 2)
        ctx.fillStyle = cell.color || (cell.error ? T.danger : T.ink)
        ctx.fillText(cell.text, tx, ty)
        if (cell.under || cell.strike) {
          ctx.strokeStyle = ctx.fillStyle
          ctx.lineWidth = 1
          ctx.beginPath()
          const ly = Math.round(cell.under ? ty + 2 : ty - cell.px * 0.3) + 0.5
          ctx.moveTo(tx, ly)
          ctx.lineTo(tx + tw, ly)
          ctx.stroke()
        }
        ctx.restore()
      }
    }

    // other people
    for (const p of this.peers.values()) {
      if (p.s !== this.sheet || !p.r || p.r > this.R || p.c > this.C) continue
      const b = this.rect(p.r, p.c)
      ctx.strokeStyle = p.u.color
      ctx.lineWidth = 2
      ctx.strokeRect(b.x, b.y, b.w - 1, b.h - 1)
      if (Date.now() - p.at > 2500) continue
      ctx.font = `600 11px ${FONT}`
      const w = ctx.measureText(p.u.name).width + 10
      ctx.fillStyle = p.u.color
      ctx.fillRect(b.x - 1, b.y - 16, w, 16)
      ctx.fillStyle = '#fff'
      ctx.fillText(p.u.name, b.x + 4, b.y - 4)
    }

    // selection
    const { r1, c1, r2, c2, row, col } = this.sel
    const sx0 = X(Math.min(c1, this.C) - 1)
    const sy0 = Y(Math.min(r1, this.R) - 1)
    const sx1 = X(Math.min(c2, this.C))
    const sy1 = Y(Math.min(r2, this.R))
    if (r1 !== r2 || c1 !== c2) {
      ctx.fillStyle = T.accent
      ctx.globalAlpha = 0.1
      ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0)
      ctx.globalAlpha = 1
      ctx.strokeStyle = T.accent
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(sx0) - 0.5, Math.round(sy0) - 0.5, sx1 - sx0, sy1 - sy0)
    }
    const a = this.rect(row, col)
    ctx.strokeStyle = T.accent
    ctx.lineWidth = 2
    ctx.strokeRect(a.x, a.y, a.w - 1, a.h - 1)
    ctx.restore()

    // headers
    ctx.fillStyle = T.head
    ctx.fillRect(0, 0, W, HH)
    ctx.fillRect(0, 0, HW, H)
    ctx.font = `500 11.5px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    for (let c = c0; c <= c9; c++) {
      const x0 = X(c - 1)
      const x1 = X(c)
      const on = c >= c1 && c <= c2
      if (on) {
        ctx.fillStyle = T.soft
        ctx.fillRect(x0, 0, x1 - x0, HH)
      }
      ctx.fillStyle = on ? T.accent : T.muted
      ctx.fillText(colName(c), (x0 + x1) / 2, HH / 2 + 1)
    }
    for (let r = r0; r <= r9; r++) {
      const y0 = Y(r - 1)
      const y1 = Y(r)
      const on = r >= r1 && r <= r2
      if (on) {
        ctx.fillStyle = T.soft
        ctx.fillRect(0, y0, HW, y1 - y0)
      }
      ctx.fillStyle = on ? T.accent : T.muted
      ctx.fillText(String(r), HW / 2, (y0 + y1) / 2 + 1)
    }
    ctx.textAlign = 'left'
    ctx.strokeStyle = T.strong
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let c = c0; c <= c9; c++) {
      const x = Math.round(X(c)) - 0.5
      ctx.moveTo(x, 0)
      ctx.lineTo(x, HH)
    }
    for (let r = r0; r <= r9; r++) {
      const y = Math.round(Y(r)) - 0.5
      ctx.moveTo(0, y)
      ctx.lineTo(HW, y)
    }
    ctx.moveTo(HW - 0.5, 0)
    ctx.lineTo(HW - 0.5, H)
    ctx.moveTo(0, HH - 0.5)
    ctx.lineTo(W, HH - 0.5)
    ctx.stroke()
    ctx.fillStyle = T.head
    ctx.fillRect(0, 0, HW - 1, HH - 1)

    if (this.guide) {
      ctx.strokeStyle = T.accent
      ctx.lineWidth = 1
      ctx.beginPath()
      if (this.guide.x !== undefined) {
        ctx.moveTo(this.guide.x + 0.5, 0)
        ctx.lineTo(this.guide.x + 0.5, H)
      } else {
        ctx.moveTo(0, this.guide.y + 0.5)
        ctx.lineTo(W, this.guide.y + 0.5)
      }
      ctx.stroke()
    }
  }

  strokeBorder(ctx, border, b) {
    const side = (item, x0, y0, x1, y1) => {
      if (!item) return
      ctx.strokeStyle = (item.color && this.model.resolveColor(item.color)) || this.theme.ink
      ctx.lineWidth = item.style === 'thick' ? 3 : item.style === 'medium' ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
    const l = Math.round(b.x) - 0.5
    const t = Math.round(b.y) - 0.5
    const r = Math.round(b.x + b.w) - 0.5
    const bt = Math.round(b.y + b.h) - 0.5
    side(border.top, l, t, r, t)
    side(border.bottom, l, bt, r, bt)
    side(border.left, l, t, l, bt)
    side(border.right, r, t, r, bt)
  }

  // --- selection and editing -----------------------------------------------

  pushSelection() {
    const { row, col, r1, c1, r2, c2 } = this.sel
    try {
      this.model.setSelectedCell(Math.min(row, MAXR), Math.min(col, MAXC))
      this.model.setSelectedRange(r1, c1, r2, c2)
    } catch {}
  }

  select(row, col, extend = false) {
    row = Math.max(1, Math.min(MAXR, row))
    col = Math.max(1, Math.min(MAXC, col))
    if (extend) {
      const a = this.anchor || { row: this.sel.row, col: this.sel.col }
      this.anchor = a
      this.sel = { row: a.row, col: a.col, r1: Math.min(a.row, row), c1: Math.min(a.col, col), r2: Math.max(a.row, row), c2: Math.max(a.col, col) }
    } else {
      const g = this.covered?.get(row * 20000 + col)
      if (g) {
        row = g.row
        col = g.column
      }
      this.anchor = { row, col }
      this.sel = { row, col, r1: row, c1: col, r2: g ? g.row + g.height - 1 : row, c2: g ? g.column + g.width - 1 : col }
    }
    this.pushSelection()
    this.reveal(row, col)
    this.draw()
    this.onChange()
    this.tell()
  }

  startEdit(text) {
    if (!this.canEdit) return
    this.draft = text ?? this.content()
    this.reveal()
    this.onChange()
  }

  setDraft(text) {
    this.draft = text
    this.onChange()
  }

  commit(dRow = 0, dCol = 0) {
    if (this.draft === null) return
    const text = this.draft
    this.draft = null
    if (text !== this.content()) {
      try {
        this.model.setUserInput(this.sheet, this.sel.row, this.sel.col, text)
      } catch (e) {
        console.warn(e)
      }
      this.push()
    }
    if (dRow || dCol) this.select(this.sel.row + dRow, this.sel.col + dCol)
    else this.onChange()
    this.wrap?.focus()
  }

  cancel() {
    this.draft = null
    this.onChange()
    this.wrap?.focus()
  }

  act(fn) {
    if (!this.canEdit || !this.model) return
    try {
      fn(this.model)
    } catch (e) {
      console.warn('sheet:', e)
    }
    this.push()
  }

  setStyle(path, value) {
    this.act((m) => m.updateRangeStyle(this.area(), path, String(value)))
  }

  toggle(path) {
    const f = this.style().font || {}
    const key = path.split('.')[1]
    this.setStyle(path, !f[key])
  }

  clear() {
    const { r1, c1, r2, c2 } = this.sel
    this.act((m) => m.rangeClearContents(this.sheet, r1, c1, r2, c2))
  }

  undo() {
    if (this.model?.canUndo()) this.act((m) => m.undo())
  }

  redo() {
    if (this.model?.canRedo()) this.act((m) => m.redo())
  }

  useSheet(i) {
    if (this.draft !== null) this.commit()
    this.sheet = i
    this.sheetId = this.sheets[i]?.sheet_id ?? null
    this.model.setSelectedSheet(i)
    this.R = 0
    this.C = 0
    this.cells.clear()
    this.measure()
    this.scroll.scrollLeft = 0
    this.scroll.scrollTop = 0
    this.select(1, 1)
  }

  // --- input ---------------------------------------------------------------

  onScroll = () => {
    this.draw()
    this.onView?.() // whatever floats over the grid moves with it
    if (this.draft !== null) this.onChange()
    // Grow the sheet as the reader approaches its edge.
    const s = this.scroll
    if (s.scrollTop + s.clientHeight > this.rowY[this.R] - 200 && this.R < MAXR) {
      this.R = Math.min(MAXR, this.R + 200)
      this.measure()
    }
    if (s.scrollLeft + s.clientWidth > this.colX[this.C] - 200 && this.C < MAXC) {
      this.C = Math.min(MAXC, this.C + 20)
      this.measure()
    }
  }

  hit(e) {
    const b = this.scroll.getBoundingClientRect()
    const x = e.clientX - b.left
    const y = e.clientY - b.top
    const inside = x < this.scroll.clientWidth && y < this.scroll.clientHeight
    const col = Math.min(this.C, this.at(this.colX, x - HW + this.scroll.scrollLeft))
    const row = Math.min(this.R, this.at(this.rowY, y - HH + this.scroll.scrollTop))
    return { x, y, inside, row, col, head: y < HH ? (x < HW ? 'corner' : 'col') : x < HW ? 'row' : null }
  }

  // edge finds a header border under the pointer, for resizing
  edge(h) {
    if (h.head === 'col') {
      const cx = h.x - HW + this.scroll.scrollLeft
      for (const c of [h.col - 1, h.col]) if (c >= 1 && Math.abs(this.colX[c] - cx) <= 4) return { col: c }
    }
    if (h.head === 'row') {
      const cy = h.y - HH + this.scroll.scrollTop
      for (const r of [h.row - 1, h.row]) if (r >= 1 && Math.abs(this.rowY[r] - cy) <= 3) return { row: r }
    }
    return null
  }

  onPointerDown = (e) => {
    if (e.button !== 0 || !this.model) return
    const h = this.hit(e)
    if (!h.inside) return // scrollbars
    this.onGridDown?.()
    const edge = this.edge(h)
    if (edge && this.canEdit) {
      e.preventDefault()
      this.drag = { resize: edge }
      this.scroll.setPointerCapture(e.pointerId)
      return
    }
    // While typing a formula, clicking a cell inserts its reference.
    if (this.draft !== null && /^=/.test(this.draft) && /[=+\-*/(,:&<>^]$/.test(this.draft.trim()) && !h.head) {
      e.preventDefault()
      this.setDraft(this.draft + colName(h.col) + h.row)
      return
    }
    if (this.draft !== null) this.commit()
    e.preventDefault()
    this.wrap.focus()
    if (h.head === 'corner') {
      this.sel = { row: 1, col: 1, r1: 1, c1: 1, r2: MAXR, c2: MAXC }
    } else if (h.head === 'col') {
      this.anchor = { row: 1, col: h.col }
      this.sel = { row: 1, col: h.col, r1: 1, c1: h.col, r2: MAXR, c2: h.col }
      this.drag = { cols: h.col }
    } else if (h.head === 'row') {
      this.anchor = { row: h.row, col: 1 }
      this.sel = { row: h.row, col: 1, r1: h.row, c1: 1, r2: h.row, c2: MAXC }
      this.drag = { rows: h.row }
    } else {
      this.select(h.row, h.col, e.shiftKey)
      this.drag = { cells: true }
    }
    this.scroll.setPointerCapture(e.pointerId)
    this.pushSelection()
    this.draw()
    this.onChange()
    this.tell()
  }

  onPointerMove = (e) => {
    if (!this.model) return
    const h = this.hit(e)
    const d = this.drag
    if (!d) {
      const edge = this.edge(h)
      this.scroll.style.cursor = edge ? (edge.col ? 'col-resize' : 'row-resize') : h.head ? 'default' : 'cell'
      return
    }
    if (d.resize) {
      this.guide = d.resize.col ? { x: Math.max(HW + this.colX[d.resize.col - 1] - this.scroll.scrollLeft + 12, h.x) } : { y: Math.max(HH + this.rowY[d.resize.row - 1] - this.scroll.scrollTop + 8, h.y) }
      this.draw()
    } else if (d.cells) {
      if (h.row !== this.lastHit?.row || h.col !== this.lastHit?.col) this.select(h.row, h.col, true)
      this.lastHit = h
    } else if (d.cols) {
      this.sel = { ...this.sel, c1: Math.min(d.cols, h.col), c2: Math.max(d.cols, h.col) }
      this.draw()
    } else if (d.rows) {
      this.sel = { ...this.sel, r1: Math.min(d.rows, h.row), r2: Math.max(d.rows, h.row) }
      this.draw()
    }
  }

  onPointerUp = (e) => {
    const d = this.drag
    this.drag = null
    this.lastHit = null
    if (!d) return
    try {
      this.scroll.releasePointerCapture(e.pointerId)
    } catch {}
    if (d.resize && this.guide) {
      const g = this.guide
      this.guide = null
      if (d.resize.col) {
        const w = Math.max(12, g.x - (HW + this.colX[d.resize.col - 1] - this.scroll.scrollLeft))
        const inSel = d.resize.col >= this.sel.c1 && d.resize.col <= this.sel.c2 && this.sel.r2 === MAXR
        this.act((m) => m.setColumnsWidth(this.sheet, inSel ? this.sel.c1 : d.resize.col, inSel ? this.sel.c2 : d.resize.col, w))
      } else {
        const hgt = Math.max(8, g.y - (HH + this.rowY[d.resize.row - 1] - this.scroll.scrollTop))
        this.act((m) => m.setRowsHeight(this.sheet, d.resize.row, d.resize.row, hgt))
      }
    } else {
      this.guide = null
      this.pushSelection()
      this.onChange()
    }
  }

  onDblClick = (e) => {
    const h = this.hit(e)
    if (h.inside && !h.head) this.startEdit()
  }

  // keys pressed while the grid (not an input) has focus
  onKey(e) {
    if (!this.model) return
    if (this.draft !== null) {
      // An edit has begun but the cell editor takes focus on the next frame.
      // Keys that arrive in between belong to the edit; none may be lost.
      const k = e.key
      if (k === 'Enter') { e.preventDefault(); this.commit(e.shiftKey ? -1 : 1, 0) }
      else if (k === 'Tab') { e.preventDefault(); this.commit(0, e.shiftKey ? -1 : 1) }
      else if (k === 'Escape') { e.preventDefault(); this.cancel() }
      else if (k === 'Backspace') { e.preventDefault(); this.setDraft(this.draft.slice(0, -1)) }
      else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.setDraft(this.draft + k) }
      return
    }
    const mod = e.metaKey || e.ctrlKey
    const { row, col } = this.sel
    const k = e.key
    const move = (r, c) => {
      e.preventDefault()
      if (e.shiftKey) {
        const far = this.farCorner()
        this.select(far.row + r, far.col + c, true)
      } else this.select(row + r, col + c)
    }
    if (mod) {
      const key = k.toLowerCase()
      if (key === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo() }
      else if (key === 'y') { e.preventDefault(); this.redo() }
      else if (key === 'b') { e.preventDefault(); this.toggle('font.b') }
      else if (key === 'i') { e.preventDefault(); this.toggle('font.i') }
      else if (key === 'u') { e.preventDefault(); this.toggle('font.u') }
      else if (key === 'a') { e.preventDefault(); this.sel = { row: 1, col: 1, r1: 1, c1: 1, r2: MAXR, c2: MAXC }; this.pushSelection(); this.draw(); this.onChange() }
      else if (k.startsWith('Arrow')) {
        e.preventDefault()
        try {
          this.model.onNavigateToEdgeInDirection(k)
          const v = this.model.getSelectedView()
          this.select(v.row, v.column)
        } catch {}
      } else if (k === 'Home') { e.preventDefault(); this.select(1, 1) }
      return
    }
    switch (k) {
      case 'ArrowDown': return move(1, 0)
      case 'ArrowUp': return move(-1, 0)
      case 'ArrowLeft': return move(0, -1)
      case 'ArrowRight': return move(0, 1)
      case 'PageDown': return move(Math.max(1, Math.floor((this.scroll.clientHeight - HH) / 25) - 1), 0)
      case 'PageUp': return move(-Math.max(1, Math.floor((this.scroll.clientHeight - HH) / 25) - 1), 0)
      case 'Home': e.preventDefault(); return this.select(row, 1)
      case 'Tab': e.preventDefault(); return this.select(row, col + (e.shiftKey ? -1 : 1))
      case 'Enter': e.preventDefault(); return this.select(row + (e.shiftKey ? -1 : 1), col)
      case 'F2': e.preventDefault(); return this.startEdit()
      case 'Delete':
      case 'Backspace': e.preventDefault(); return this.clear()
    }
    if (k.length === 1 && !e.altKey && this.canEdit) {
      // Typing replaces the cell, starting with the key just pressed.
      e.preventDefault()
      this.startEdit(k)
    }
  }

  farCorner() {
    const a = this.anchor || this.sel
    const s = this.sel
    return { row: a.row === s.r1 ? s.r2 : s.r1, col: a.col === s.c1 ? s.c2 : s.c1 }
  }

  gridHasFocus() {
    return document.activeElement === this.wrap
  }

  onCopy = (e) => {
    if (!this.gridHasFocus() || !this.model) return
    e.preventDefault()
    this.pushSelection()
    const clip = this.model.copyToClipboard()
    this.clip = { ...clip, sheet: this.sheet, cut: e.type === 'cut' }
    e.clipboardData.setData('text/plain', clip.csv)
  }

  onPaste = (e) => {
    if (!this.gridHasFocus() || !this.model || !this.canEdit) return
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    const clip = this.clip
    this.pushSelection()
    if (clip && clip.csv === text) {
      // Our own copy: keep formulas and formatting.
      this.act((m) => m.pasteFromClipboard(clip.sheet, clip.range, clip.data, clip.cut))
      if (clip.cut) this.clip = null
    } else if (text) {
      this.act((m) => m.pasteCsvText(this.area(), text))
    }
  }
}
