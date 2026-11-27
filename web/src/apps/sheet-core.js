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
import { blank, applyDiff, loadModel, colName, sheetText, timezone } from './sheet-data.js'
import { readMeta, refreshPivots, hiddenRows, filterOf, validationAt, listItems, valid, describeRule, clipped, setWrapping as wrapMode } from './sheet-meta.js'

export { colName }

// Engine calls that only read (or move the selection) and so make no undo step.
const READS = /^(get|can|flush|resolve|to[A-Z]|is[A-Z]|setSelected|setTopLeft|setWindow|evaluate|pauseEvaluation|resumeEvaluation|copyToClipboard|free|cycleReference)/

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
// The workbook's theme font draws in the app's own; a font picked by name is
// asked for by name, falling back to the app's.
const fontCss = (name, scheme) => (!name || (scheme && scheme !== 'none') ? FONT : `"${name.replace(/"/g, '')}", ${FONT}`)

// wrapLines breaks text into lines that fit width, at spaces where it can.
function wrapLines(ctx, text, width) {
  const out = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const next = line + word
      if (!line || ctx.measureText(next).width <= width) {
        line = next
        continue
      }
      out.push(line.trimEnd())
      line = word.trimStart()
      // A single word wider than the cell is broken where it must be.
      while (line && ctx.measureText(line).width > width) {
        let n = line.length
        while (n > 1 && ctx.measureText(line.slice(0, n)).width > width) n--
        out.push(line.slice(0, n))
        line = line.slice(n)
      }
    }
    out.push(line)
  }
  return out
}

// Uploaded workbooks and .csv files are converted to the engine's own format.
export async function xlsxToSnapshot(bytes, name) {
  await engine()
  // The Excel reader (and its zip library) loads only when a file is imported.
  const { importXlsx } = await import('./sheet-xlsx.js')
  return importXlsx(bytes, name, timezone)
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
    this.undos = [] // engine steps per action, for Undo
    this.redos = []
    this.view = null // id of the filter view open on this screen only
    this.painter = null // styles picked up by Paint format, until used
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
    // A rebuilt workbook has no undo history.
    this.undos = []
    this.redos = []
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
    // What filters hide is drawn at no height; the filter in use is this
    // screen's filter view if one is open, otherwise the sheet's own filter.
    this.filter = this.activeFilter()
    this.hidden = hiddenRows(m, this.filter)
    this.sheetRules = this.meta('validation').filter((v) => v.ref?.sheet === s)
    this.hasClips = this.meta('clip').some((v) => v.ref?.sheet === s)
    this.fr = Math.min(m.getFrozenRowsCount(s), this.R - 1)
    this.fc = Math.min(m.getFrozenColumnsCount(s), this.C - 1)
    this.colX = new Float64Array(this.C + 1)
    this.rowY = new Float64Array(this.R + 1)
    for (let c = 1; c <= this.C; c++) this.colX[c] = this.colX[c - 1] + m.getColumnWidth(s, c)
    for (let r = 1; r <= this.R; r++) this.rowY[r] = this.rowY[r - 1] + (this.hidden.has(r) ? 0 : m.getRowHeight(s, r))
    this.FX = this.colX[this.fc]
    this.FY = this.rowY[this.fr]
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

  // Screen position of a column's left edge or a row's top edge. Frozen
  // columns and rows stay put; the rest move with the scroll.
  colLeft(c) {
    return HW + this.colX[Math.min(c - 1, this.C)] - (c > this.fc ? this.scroll.scrollLeft : 0)
  }

  rowTop(r) {
    return HH + this.rowY[Math.min(r - 1, this.R)] - (r > this.fr ? this.scroll.scrollTop : 0)
  }

  rect(row, col) {
    const g = this.covered?.get(row * 20000 + col)
    const r1 = g ? g.row : row
    const c1 = g ? g.column : col
    const r2 = g ? g.row + g.height - 1 : row
    const c2 = g ? g.column + g.width - 1 : col
    return { x: this.colLeft(c1), y: this.rowTop(r1), w: this.colX[Math.min(c2, this.C)] - this.colX[Math.min(c1, this.C) - 1], h: this.rowY[Math.min(r2, this.R)] - this.rowY[Math.min(r1, this.R) - 1] }
  }

  reveal(row = this.sel.row, col = this.sel.col) {
    if (row > this.R - 20 || col > this.C - 4) this.measure()
    const s = this.scroll
    const vw = s.clientWidth - HW
    const vh = s.clientHeight - HH
    if (col > this.fc) {
      const x0 = this.colX[col - 1] - this.FX
      const x1 = this.colX[col]
      if (x0 < s.scrollLeft) s.scrollLeft = x0
      else if (x1 > s.scrollLeft + vw) s.scrollLeft = x1 - vw
    }
    if (row > this.fr) {
      const y0 = this.rowY[row - 1] - this.FY
      const y1 = this.rowY[row]
      if (y0 < s.scrollTop) s.scrollTop = y0
      else if (y1 > s.scrollTop + vh) s.scrollTop = y1 - vh
    }
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
    const rule = this.sheetRules.length ? validationAt(m, this.sheet, row, col, this, this.rev)?.rule : null
    c = {
      text,
      bold: !!f.b, italic: !!f.i, under: !!f.u, strike: !!f.strike,
      px: Math.round((f.sz || 12) * 1.0834),
      family: fontCss(f.name, f.scheme),
      color: f.color ? m.resolveColor(f.color) : '',
      fill: st.fill?.color ? m.resolveColor(st.fill.color) : '',
      align: align === 'center' || align === 'right' ? align : 'left',
      valign: st.alignment?.vertical || 'bottom',
      wrap: !!st.alignment?.wrap_text,
      clip: this.hasClips && clipped(m, this.sheet, row, col, this, this.rev),
      border: st.border && (st.border.left || st.border.right || st.border.top || st.border.bottom) ? st.border : null,
      error: type === 16,
      check: rule?.type === 'checkbox' ? /^true$/i.test(text) : null,
      list: rule && (rule.type === 'list' || rule.type === 'range'),
      invalid: rule && text && !this.ruleOk(rule, text),
    }
    this.cells.set(key, c)
    return c
  }

  ruleOk(rule, text) {
    return valid(this.model, rule, text)
  }

  // --- filters, views and rules ------------------------------------------

  meta(kind) {
    return this.model ? readMeta(this.model, kind, this, this.rev) : []
  }

  activeFilter() {
    // A view not (yet) in the workbook leaves the sheet's own filter in use;
    // it may still arrive with the rest of the workbook.
    if (this.view) {
      const v = this.meta('view').find((x) => x.id === this.view)
      if (v?.ref?.sheet === this.sheet) return v
    }
    return this.model ? filterOf(this.model, this.sheet, this, this.rev) : null
  }

  // openView shows a filter view on this screen only (null closes it).
  openView(id) {
    this.view = id
    const v = id && this.meta('view').find((x) => x.id === id)
    if (v?.ref && v.ref.sheet !== this.sheet) this.useSheet(v.ref.sheet)
    this.changed(false)
  }

  validationHere(row = this.sel.row, col = this.sel.col) {
    return validationAt(this.model, this.sheet, row, col, this, this.rev)
  }

  listFor(rule) {
    return listItems(this.model, rule)
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

  // paint draws the grid in up to four parts: frozen rows and columns stay
  // where they are, the rest scrolls; each part draws its own cells, people
  // and selection, clipped to its own area.
  paint() {
    if (!this.model || !this.colX) return
    const ctx = this.ctx
    const T = this.theme
    const dpr = window.devicePixelRatio || 1
    const W = this.canvas.width / dpr
    const H = this.canvas.height / dpr
    const sx = this.scroll.scrollLeft
    const sy = this.scroll.scrollTop
    const { fc, fr, FX, FY } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = T.bg
    ctx.fillRect(0, 0, W, H)

    // The scrolling part's first and last visible column and row.
    const c0 = Math.max(fc + 1, this.at(this.colX, sx + FX))
    const r0 = Math.max(fr + 1, this.at(this.rowY, sy + FY))
    let c9 = c0
    while (c9 < this.C && HW + this.colX[c9] - sx < W) c9++
    let r9 = r0
    while (r9 < this.R && HH + this.rowY[r9] - sy < H) r9++
    const cols = fc ? [[1, fc, HW, FX], [c0, c9, HW + FX, W - HW - FX]] : [[c0, c9, HW, W - HW]]
    const rows = fr ? [[1, fr, HH, FY], [r0, r9, HH + FY, H - HH - FY]] : [[r0, r9, HH, H - HH]]
    for (const [ra, rb, y, h] of rows) {
      for (const [ca, cb, x, w] of cols) this.paintPart(ctx, ca, cb, ra, rb, x, y, w, h, W, H)
    }

    // headers
    const { r1, c1, r2, c2 } = this.sel
    const X = (c) => this.colLeft(c + 1) // right edge of column c
    const Y = (r) => this.rowTop(r + 1) // bottom edge of row r
    ctx.fillStyle = T.head
    ctx.fillRect(0, 0, W, HH)
    ctx.fillRect(0, 0, HW, H)
    ctx.font = `500 11.5px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    const colsShown = []
    for (let c = 1; c <= fc; c++) colsShown.push(c)
    for (let c = c0; c <= c9; c++) colsShown.push(c)
    const rowsShown = []
    for (let r = 1; r <= fr; r++) rowsShown.push(r)
    for (let r = r0; r <= r9; r++) if (!this.hidden.has(r)) rowsShown.push(r)
    const head = (x, y, w, h, fn) => {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, w, h)
      ctx.clip()
      fn()
      ctx.restore()
    }
    const colHeads = (list) => {
      for (const c of list) {
        const x0 = this.colLeft(c)
        const x1 = x0 + this.colX[c] - this.colX[c - 1]
        const on = c >= c1 && c <= c2
        if (on) {
          ctx.fillStyle = T.soft
          ctx.fillRect(x0, 0, x1 - x0, HH)
        }
        ctx.fillStyle = on ? T.accent : T.muted
        ctx.fillText(colName(c), (x0 + x1) / 2, HH / 2 + 1)
      }
    }
    const rowHeads = (list) => {
      for (const r of list) {
        const y0 = this.rowTop(r)
        const y1 = y0 + this.rowY[r] - this.rowY[r - 1]
        const on = r >= r1 && r <= r2
        if (on) {
          ctx.fillStyle = T.soft
          ctx.fillRect(0, y0, HW, y1 - y0)
        }
        ctx.fillStyle = on ? T.accent : T.muted
        ctx.fillText(String(r), HW / 2, (y0 + y1) / 2 + 1)
      }
    }
    head(HW, 0, FX, HH, () => colHeads(colsShown.filter((c) => c <= fc)))
    head(HW + FX, 0, W, HH, () => colHeads(colsShown.filter((c) => c > fc)))
    head(0, HH, HW, FY, () => rowHeads(rowsShown.filter((r) => r <= fr)))
    head(0, HH + FY, HW, H, () => rowHeads(rowsShown.filter((r) => r > fr)))
    ctx.textAlign = 'left'
    ctx.strokeStyle = T.strong
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const c of colsShown) {
      const x = Math.round(X(c)) - 0.5
      if (c > fc && x < HW + FX) continue
      ctx.moveTo(x, 0)
      ctx.lineTo(x, HH)
    }
    for (const r of rowsShown) {
      const y = Math.round(Y(r)) - 0.5
      if (r > fr && y < HH + FY) continue
      ctx.moveTo(0, y)
      ctx.lineTo(HW, y)
    }
    ctx.moveTo(HW - 0.5, 0)
    ctx.lineTo(HW - 0.5, H)
    ctx.moveTo(0, HH - 0.5)
    ctx.lineTo(W, HH - 0.5)
    ctx.stroke()
    // A hidden (filtered) run of rows shows as a double line in the headers.
    if (this.hidden.size) {
      ctx.strokeStyle = T.muted
      ctx.beginPath()
      for (const r of rowsShown) {
        if (!this.hidden.has(r + 1)) continue
        const y = Math.round(Y(r)) + 1.5
        if (r > fr && y < HH + FY) continue
        ctx.moveTo(0, y)
        ctx.lineTo(HW, y)
      }
      ctx.stroke()
    }
    // The edges of frozen rows and columns.
    if (fr || fc) {
      ctx.fillStyle = T.strong
      if (fc) ctx.fillRect(HW + FX - 2, 0, 3, H)
      if (fr) ctx.fillRect(0, HH + FY - 2, W, 3)
    }
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

  // paintPart draws columns ca..cb and rows ra..rb inside the area x,y,w,h.
  paintPart(ctx, ca, cb, ra, rb, x, y, w, h) {
    if (w <= 0 || h <= 0 || ca > cb || ra > rb) return
    const T = this.theme
    const X = (c) => this.colLeft(c + 1) // right edge of column c
    const Y = (r) => this.rowTop(r + 1) // bottom edge of row r
    const box = (r, c, g) => (g ? this.rect(r, c) : { x: this.colLeft(c), y: this.rowTop(r), w: this.colX[c] - this.colX[c - 1], h: this.rowY[r] - this.rowY[r - 1] })
    const shown = []
    for (let r = ra; r <= rb; r++) if (!this.hidden.has(r)) shown.push(r)
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()

    // fills
    for (const r of shown) {
      for (let c = ca; c <= cb; c++) {
        const g = this.covered.get(r * 20000 + c)
        if (g && (g.row !== r || g.column !== c)) continue
        const cell = this.cell(r, c)
        if (!cell.fill) continue
        const b = box(r, c, g)
        ctx.fillStyle = cell.fill
        ctx.fillRect(b.x, b.y, b.w, b.h)
      }
    }

    // grid
    if (this.gridLines) {
      ctx.strokeStyle = T.line
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let c = ca; c <= cb; c++) {
        const gx = Math.round(X(c)) - 0.5
        ctx.moveTo(gx, y)
        ctx.lineTo(gx, y + h)
      }
      for (const r of shown) {
        const gy = Math.round(Y(r)) - 0.5
        ctx.moveTo(x, gy)
        ctx.lineTo(x + w, gy)
      }
      ctx.stroke()
    }
    // merged areas hide the grid inside them
    for (const g of this.merged) {
      if (g.row > rb || g.row + g.height - 1 < ra || g.column > cb || g.column + g.width - 1 < ca) continue
      const b = this.rect(g.row, g.column)
      ctx.fillStyle = this.cell(g.row, g.column).fill || T.bg
      ctx.fillRect(b.x, b.y, b.w - 1, b.h - 1)
    }

    // text, borders and what rules add to a cell
    ctx.textBaseline = 'alphabetic'
    const f = this.filter?.ref
    for (const r of shown) {
      for (let c = ca; c <= cb; c++) {
        const g = this.covered.get(r * 20000 + c)
        if (g && (g.row !== r || g.column !== c)) continue
        const cell = this.cell(r, c)
        const b = box(r, c, g)
        if (cell.border) this.strokeBorder(ctx, cell.border, b)
        if (cell.check !== null) this.paintCheck(ctx, b, cell.check)
        else if (cell.text) this.paintText(ctx, cell, b, r, c, g, cb)
        if (cell.list && b.w > 30) this.paintArrow(ctx, b, false)
        if (cell.invalid) {
          ctx.fillStyle = T.danger
          ctx.beginPath()
          ctx.moveTo(b.x + b.w - 7, b.y)
          ctx.lineTo(b.x + b.w, b.y)
          ctx.lineTo(b.x + b.w, b.y + 7)
          ctx.fill()
        }
        if (f && r === f.r1 && c >= f.c1 && c <= f.c2) {
          const crit = this.filter.criteria?.[c]
          this.paintArrow(ctx, b, true, !!(crit && (crit.hidden?.length || crit.cond?.op)))
        }
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
      const tw = ctx.measureText(p.u.name).width + 10
      ctx.fillStyle = p.u.color
      ctx.fillRect(b.x - 1, b.y - 16, tw, 16)
      ctx.fillStyle = '#fff'
      ctx.fillText(p.u.name, b.x + 4, b.y - 4)
    }

    // selection
    const { r1, c1, r2, c2, row, col } = this.sel
    if (r1 !== r2 || c1 !== c2) {
      const sx0 = this.colLeft(Math.min(c1, this.C))
      const sy0 = this.rowTop(Math.min(r1, this.R))
      const sx1 = X(Math.min(c2, this.C))
      const sy1 = Y(Math.min(r2, this.R))
      ctx.fillStyle = T.accent
      ctx.globalAlpha = 0.1
      ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0)
      ctx.globalAlpha = 1
      ctx.strokeStyle = T.accent
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(sx0) - 0.5, Math.round(sy0) - 0.5, sx1 - sx0, sy1 - sy0)
    }
    if (this.painter) {
      const pb = this.painter.from
      const px0 = this.colLeft(pb.c1)
      const py0 = this.rowTop(pb.r1)
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = T.accent
      ctx.lineWidth = 1.5
      ctx.strokeRect(px0, py0, X(pb.c2) - px0, Y(pb.r2) - py0)
      ctx.setLineDash([])
    }
    const a = this.rect(row, col)
    ctx.strokeStyle = T.accent
    ctx.lineWidth = 2
    ctx.strokeRect(a.x, a.y, a.w - 1, a.h - 1)
    ctx.restore()
  }

  paintText(ctx, cell, b, r, c, g, cb) {
    const T = this.theme
    ctx.font = `${cell.italic ? 'italic ' : ''}${cell.bold ? '650 ' : ''}${cell.px}px ${cell.family}`
    ctx.fillStyle = cell.color || (cell.error ? T.danger : T.ink)
    const lh = Math.round(cell.px * 1.3)
    let lines = [cell.text]
    if (cell.wrap) lines = wrapLines(ctx, cell.text, Math.max(10, b.w - 10))
    const widths = lines.map((l) => ctx.measureText(l).width)
    const tw = Math.max(...widths)
    // Long text runs over empty neighbours to its right, unless it wraps or
    // is clipped.
    let right = b.x + b.w
    if (!cell.wrap && !cell.clip && cell.align === 'left' && tw > b.w - 8 && !g) {
      for (let n = c + 1; n <= cb + 1 && n <= this.C && right < b.x + tw + 8; n++) {
        const next = this.cell(r, n)
        if (next.text || next.fill || next.check !== null || this.covered.has(r * 20000 + n)) break
        right = this.colLeft(n + 1)
      }
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(b.x + 1, b.y, right - b.x - 2, b.h)
    ctx.clip()
    const block = lh * (lines.length - 1)
    let ty
    if (cell.valign === 'top') ty = b.y + cell.px + 3
    else if (cell.valign === 'center') ty = b.y + (b.h - block) / 2 + cell.px * 0.36
    else ty = b.y + b.h - Math.max(5, (Math.min(b.h, 25) - cell.px) / 2 + 2) - block
    lines.forEach((line, i) => {
      const lw = widths[i]
      const tx = cell.align === 'right' ? b.x + b.w - 5 - lw : cell.align === 'center' ? b.x + (b.w - lw) / 2 : b.x + 5
      const ly = ty + i * lh
      ctx.fillText(line, tx, ly)
      if (cell.under || cell.strike) {
        ctx.strokeStyle = ctx.fillStyle
        ctx.lineWidth = 1
        ctx.beginPath()
        const yy = Math.round(cell.under ? ly + 2 : ly - cell.px * 0.3) + 0.5
        ctx.moveTo(tx, yy)
        ctx.lineTo(tx + lw, yy)
        ctx.stroke()
      }
    })
    ctx.restore()
  }

  paintCheck(ctx, b, on) {
    const T = this.theme
    const s = 14
    const x = Math.round(b.x + (b.w - s) / 2) + 0.5
    const y = Math.round(b.y + (b.h - s) / 2) + 0.5
    ctx.lineWidth = 1.5
    if (on) {
      ctx.fillStyle = T.accent
      ctx.beginPath()
      ctx.roundRect(x, y, s, s, 3)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.beginPath()
      ctx.moveTo(x + 3.5, y + 7.5)
      ctx.lineTo(x + 6, y + 10)
      ctx.lineTo(x + 10.5, y + 4.5)
      ctx.stroke()
    } else {
      ctx.strokeStyle = T.muted
      ctx.beginPath()
      ctx.roundRect(x, y, s, s, 3)
      ctx.stroke()
    }
  }

  // paintArrow draws a dropdown's arrow, or (filter) a filter heading's
  // button, filled when the column is filtered.
  paintArrow(ctx, b, filter, active) {
    const T = this.theme
    const s = 16
    const x = b.x + b.w - s - 3
    const y = b.y + (b.h - s) / 2
    if (filter) {
      ctx.fillStyle = active ? T.accent : T.bg
      ctx.strokeStyle = active ? T.accent : T.strong
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(x + 0.5, y + 0.5, s - 1, s - 1, 3)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = active ? '#fff' : T.muted
      ctx.beginPath()
      ctx.moveTo(x + 4, y + 5)
      ctx.lineTo(x + 12, y + 5)
      ctx.lineTo(x + 9, y + 9)
      ctx.lineTo(x + 9, y + 12)
      ctx.lineTo(x + 7, y + 11)
      ctx.lineTo(x + 7, y + 9)
      ctx.fill()
      return
    }
    ctx.fillStyle = T.muted
    ctx.beginPath()
    ctx.moveTo(x + 4, y + 6)
    ctx.lineTo(x + 12, y + 6)
    ctx.lineTo(x + 8, y + 11)
    ctx.fill()
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
    // Data validation: a strict rule refuses other input and keeps the editor open.
    const v = this.validationHere()
    if (v && text !== '' && !text.startsWith('=') && !valid(this.model, v.rule, text)) {
      const what = v.help || `Enter ${describeRule(v.rule)}.`
      if (v.strict) {
        this.onToast?.(what, 'error')
        return
      }
      this.onToast?.(`That doesn't match the rule for this cell: ${what}`)
    }
    this.draft = null
    if (text !== this.content()) {
      this.act((m) => {
        m.setUserInput(this.sheet, this.sel.row, this.sel.col, text)
        if (this.cell(this.sel.row, this.sel.col).wrap) this.fitRowsIn(m, this.sel.row, this.sel.row, true)
      })
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

  // act runs one user action against the engine and sends what it changed.
  // The engine keeps one undo step per call, so the calls are counted and
  // Undo takes the whole action back at once (a sort is many pastes). Pivot
  // tables are brought up to date inside the same action. Returns what fn
  // returned; an error is shown and nothing of it is kept.
  act(fn, { quiet = false } = {}) {
    if (!this.canEdit || !this.model) return
    const m = this.model
    let steps = 0
    const counted = new Proxy(m, {
      get(t, k) {
        const v = t[k]
        if (typeof v !== 'function') return v
        if (READS.test(k)) return v.bind(t)
        return (...args) => {
          const r = v.apply(t, args)
          steps++
          return r
        }
      },
    })
    let out
    try {
      out = fn(counted)
      if (readMeta(m, 'pivot').length) refreshPivots(counted)
    } catch (e) {
      console.warn('sheet:', e)
      if (!quiet) this.onToast?.(e.message || String(e), 'error')
    }
    if (steps) {
      this.undos.push(steps)
      this.redos = []
    }
    this.push()
    return out
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

  // setValue types into one cell (a dropdown's choice, a checkbox).
  setValue(row, col, text) {
    this.act((m) => m.setUserInput(this.sheet, row, col, text))
  }

  // --- formatting ----------------------------------------------------------

  // The selection, cut down to where there is data when whole rows or
  // columns are selected, so a style per cell stays a sensible size.
  styledArea() {
    let { r1, c1, r2, c2 } = this.sel
    if (r2 >= MAXR || c2 >= MAXC) {
      let maxRow = 1
      let maxCol = 1
      for (let c = c1; c <= Math.min(c2, c1 + 200); c++) for (const r of this.model.getRowsWithData(this.sheet, c)) if (r > maxRow) maxRow = r
      for (let r = r1; r <= Math.min(r2, maxRow); r++) maxCol = Math.max(maxCol, this.model.getLastNonEmptyInRowBeforeColumn(this.sheet, r, 16385) ?? 0)
      r2 = Math.min(r2, Math.max(maxRow, r1))
      c2 = Math.min(c2, Math.max(maxCol, c1))
    }
    return { r1, c1, r2, c2 }
  }

  // setFont sets the font family. The engine has no style path for it, so
  // each cell's style is rewritten with the new name.
  setFont(name) {
    const { r1, c1, r2, c2 } = this.styledArea()
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200000) return this.onToast?.('Select fewer cells to change their font.', 'error')
    this.act((m) => {
      const styles = []
      for (let r = r1; r <= r2; r++) {
        const row = []
        for (let c = c1; c <= c2; c++) {
          const st = m.getCellStyle(this.sheet, r, c).style
          st.font = { ...st.font, name: name || 'Calibri', scheme: name ? 'none' : 'minor' }
          row.push(st)
        }
        styles.push(row)
      }
      m.setSelectedCell(r1, c1)
      m.setSelectedRange(r1, c1, r2, c2)
      m.onPasteStyles(styles)
    })
    this.pushSelection()
  }

  setSize(pt) {
    this.act((m) => {
      m.updateRangeStyle(this.area(), 'font.size', String(pt))
      this.fitRowsIn(m, this.sel.r1, Math.min(this.sel.r2, this.R), false)
    })
  }

  // setWrapping: 'overflow', 'wrap' or 'clip'.
  setWrapping(mode) {
    const { r1, c1, r2, c2 } = this.sel
    this.act((m) => {
      wrapMode(m, { sheet: this.sheet, r1, c1, r2: Math.min(r2, MAXR), c2: Math.min(c2, MAXC) }, mode)
      if (mode === 'wrap') {
        this.changedNow()
        this.fitRowsIn(m, r1, Math.min(r2, this.R), true)
      }
    })
  }

  // changedNow forgets cached cell looks inside an action, so the rest of the
  // action sees what it just did.
  changedNow() {
    this.rev++
    this.cells.clear()
  }

  // Paint format: pick up the selection's styles; the next selection gets them.
  pickPainter() {
    if (this.painter) {
      this.painter = null
      this.draw()
      this.onChange()
      return
    }
    const { r1, c1, r2, c2 } = this.styledArea()
    const rows = Math.min(r2 - r1 + 1, 200)
    const cols = Math.min(c2 - c1 + 1, 50)
    const styles = []
    for (let r = 0; r < rows; r++) {
      const row = []
      for (let c = 0; c < cols; c++) row.push(this.model.getCellStyle(this.sheet, r1 + r, c1 + c).style)
      styles.push(row)
    }
    this.painter = { styles, from: { r1, c1, r2: r1 + rows - 1, c2: c1 + cols - 1 } }
    this.draw()
    this.onChange()
  }

  applyPainter() {
    const p = this.painter
    this.painter = null
    const { r1, c1, r2, c2 } = this.styledArea()
    // The picked-up block repeats across the new selection.
    const styles = []
    for (let r = 0; r <= r2 - r1; r++) {
      const row = []
      for (let c = 0; c <= c2 - c1; c++) row.push(p.styles[r % p.styles.length][c % p.styles[0].length])
      styles.push(row)
    }
    this.act((m) => {
      m.setSelectedCell(r1, c1)
      m.setSelectedRange(r1, c1, r2, c2)
      m.onPasteStyles(styles)
    })
    this.pushSelection()
  }

  // Width a column's contents need, measured as drawn.
  fitColumns(a, b) {
    const ctx = this.ctx
    this.act((m) => {
      for (let c = a; c <= b; c++) {
        let w = 0
        for (const r of m.getRowsWithData(this.sheet, c)) {
          const cell = this.cell(r, c)
          if (!cell.text || cell.wrap) continue
          ctx.font = `${cell.italic ? 'italic ' : ''}${cell.bold ? '650 ' : ''}${cell.px}px ${cell.family}`
          w = Math.max(w, ctx.measureText(cell.text).width + 14 + (cell.list || (this.filter?.ref && r === this.filter.ref.r1) ? 20 : 0))
        }
        if (w) m.setColumnsWidth(this.sheet, c, c, Math.min(1000, Math.max(24, Math.ceil(w))))
      }
    })
  }

  fitRows(a, b) {
    this.act((m) => this.fitRowsIn(m, a, b, false))
  }

  // fitRowsIn sets rows to the height their wrapped or larger text needs
  // (grow: only ever taller, as typing into a wrapped cell does).
  fitRowsIn(m, a, b, grow) {
    const ctx = this.ctx
    if (!ctx) return
    for (let r = a; r <= Math.min(b, a + 2000); r++) {
      let need = 0
      for (const c of m.getColumnsWithData(this.sheet, r)) {
        const st = m.getCellStyle(this.sheet, r, c).style
        const f = st.font || {}
        const px = Math.round((f.sz || 12) * 1.0834)
        let lines = 1
        if (st.alignment?.wrap_text) {
          ctx.font = `${f.i ? 'italic ' : ''}${f.b ? '650 ' : ''}${px}px ${fontCss(f.name, f.scheme)}`
          lines = wrapLines(ctx, m.getFormattedCellValue(this.sheet, r, c), Math.max(10, m.getColumnWidth(this.sheet, c) - 10)).length
        }
        need = Math.max(need, Math.round(px * 1.3) * lines + 8)
      }
      const now = m.getRowHeight(this.sheet, r)
      const want = Math.max(25, need)
      if (grow ? want > now : want !== now && need) m.setRowsHeight(this.sheet, r, r, want)
    }
  }

  clearFormatting() {
    const { r1, c1, r2, c2 } = this.sel
    this.act((m) => m.rangeClearFormatting(this.sheet, r1, c1, Math.min(r2, MAXR), Math.min(c2, MAXC)))
  }

  selectAll() {
    this.sel = { row: 1, col: 1, r1: 1, c1: 1, r2: MAXR, c2: MAXC }
    this.pushSelection()
    this.draw()
    this.onChange()
  }

  // Edit > Paste: the system clipboard, read on request (the browser asks
  // first). Our own copy keeps formulas and formatting, as Ctrl+V does.
  async pasteFromSystem() {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return this.onToast?.(`Use ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'}V to paste.`)
    }
    if (!this.model || !this.canEdit) return
    this.pushSelection()
    const clip = this.clip
    if (clip && clip.csv === text) {
      this.act((m) => m.pasteFromClipboard(clip.sheet, clip.range, clip.data, clip.cut))
      if (clip.cut) this.clip = null
    } else if (text) this.act((m) => m.pasteCsvText(this.area(), text))
  }

  undo() {
    const m = this.model
    if (!this.canEdit || !m?.canUndo()) return
    const n = this.undos.pop() || 1
    let done = 0
    for (; done < n && m.canUndo(); done++) m.undo()
    this.redos.push(done)
    this.push()
  }

  redo() {
    const m = this.model
    if (!this.canEdit || !m?.canRedo()) return
    const n = this.redos.pop() || 1
    let done = 0
    for (; done < n && m.canRedo(); done++) m.redo()
    this.undos.push(done)
    this.push()
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
    // Inside the frozen part the grid does not scroll.
    const cx = x - HW < this.FX ? x - HW : x - HW + this.scroll.scrollLeft
    const cy = y - HH < this.FY ? y - HH : y - HH + this.scroll.scrollTop
    const col = Math.min(this.C, this.at(this.colX, cx))
    const row = Math.min(this.R, this.at(this.rowY, cy))
    return { x, y, cx, cy, inside, row, col, head: y < HH ? (x < HW ? 'corner' : 'col') : x < HW ? 'row' : null }
  }

  // edge finds a header border under the pointer, for resizing
  edge(h) {
    if (h.head === 'col') {
      for (const c of [h.col - 1, h.col]) if (c >= 1 && Math.abs(this.colX[c] - h.cx) <= 4) return { col: c }
    }
    if (h.head === 'row') {
      for (const r of [h.row - 1, h.row]) if (r >= 1 && Math.abs(this.rowY[r] - h.cy) <= 3) return { row: r }
    }
    return null
  }

  // What a click at h lands on besides the cell: a filter button, a
  // dropdown's arrow or a checkbox.
  widget(h) {
    if (h.head || !this.model) return null
    const b = this.rect(h.row, h.col)
    const f = this.filter?.ref
    const nearRight = h.x >= b.x + b.w - 21 && h.x <= b.x + b.w
    if (f && h.row === f.r1 && h.col >= f.c1 && h.col <= f.c2 && nearRight) return { kind: 'filter', col: h.col, rect: b }
    const cell = this.cell(h.row, h.col)
    if (cell.check !== null) return Math.abs(h.x - (b.x + b.w / 2)) <= 10 && Math.abs(h.y - (b.y + b.h / 2)) <= 10 ? { kind: 'check', on: cell.check } : null
    if (cell.list && nearRight) return { kind: 'list', rect: b }
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
    const w = this.widget(h)
    if (w) {
      this.select(h.row, h.col)
      if (w.kind === 'check') {
        if (this.canEdit) this.act((m) => m.setUserInput(this.sheet, h.row, h.col, w.on ? 'FALSE' : 'TRUE'))
      } else this.onWidget?.(w, h)
      return
    }
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
      this.scroll.style.cursor = edge ? (edge.col ? 'col-resize' : 'row-resize') : h.head ? 'default' : this.widget(h) ? 'pointer' : this.painter ? 'copy' : 'cell'
      return
    }
    if (d.resize) {
      this.guide = d.resize.col ? { x: Math.max(this.colLeft(d.resize.col) + 12, h.x) } : { y: Math.max(this.rowTop(d.resize.row) + 8, h.y) }
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
        const w = Math.max(12, g.x - this.colLeft(d.resize.col))
        const inSel = d.resize.col >= this.sel.c1 && d.resize.col <= this.sel.c2 && this.sel.r2 === MAXR
        this.act((m) => m.setColumnsWidth(this.sheet, inSel ? this.sel.c1 : d.resize.col, inSel ? this.sel.c2 : d.resize.col, w))
      } else {
        const hgt = Math.max(8, g.y - this.rowTop(d.resize.row))
        const inSel = d.resize.row >= this.sel.r1 && d.resize.row <= this.sel.r2 && this.sel.c2 === MAXC
        this.act((m) => m.setRowsHeight(this.sheet, inSel ? this.sel.r1 : d.resize.row, inSel ? this.sel.r2 : d.resize.row, hgt))
      }
    } else {
      this.guide = null
      this.pushSelection()
      // Paint format: the styles picked up go onto what was just selected.
      if (this.painter && (d.cells || d.cols || d.rows)) this.applyPainter()
      this.onChange()
    }
  }

  onDblClick = (e) => {
    const h = this.hit(e)
    const edge = h.inside && this.edge(h)
    // Double-clicking a header's edge fits the column or row to its contents.
    if (edge && this.canEdit) {
      if (edge.col) {
        const inSel = edge.col >= this.sel.c1 && edge.col <= this.sel.c2 && this.sel.r2 === MAXR
        this.fitColumns(inSel ? this.sel.c1 : edge.col, inSel ? this.sel.c2 : edge.col)
      } else this.fitRows(edge.row, edge.row)
      return
    }
    if (h.inside && !h.head && !this.widget(h)) this.startEdit()
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
    // Rows a filter hides are stepped over.
    const skip = (from, d) => {
      let to = from + d
      const dir = Math.sign(d) || 1
      while (this.hidden.has(to) && to > 1 && to < MAXR) to += dir
      return this.hidden.has(to) ? from : to
    }
    const move = (r, c) => {
      e.preventDefault()
      if (e.shiftKey) {
        const far = this.farCorner()
        this.select(r ? skip(far.row, r) : far.row, far.col + c, true)
      } else this.select(r ? skip(row, r) : row, col + c)
    }
    if (k === 'Escape' && this.painter) {
      e.preventDefault()
      return this.pickPainter()
    }
    if (k === ' ' && !mod && this.canEdit && this.cell(row, col).check !== null) {
      e.preventDefault()
      return this.setValue(row, col, this.cell(row, col).check ? 'FALSE' : 'TRUE')
    }
    if (k === 'ArrowDown' && e.altKey && this.cell(row, col).list) {
      e.preventDefault()
      return this.onWidget?.({ kind: 'list', rect: this.rect(row, col) })
    }
    if (mod) {
      const key = k.toLowerCase()
      if (key === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo() }
      else if (key === 'y') { e.preventDefault(); this.redo() }
      else if (key === 'b') { e.preventDefault(); this.toggle('font.b') }
      else if (key === 'i') { e.preventDefault(); this.toggle('font.i') }
      else if (key === 'u') { e.preventDefault(); this.toggle('font.u') }
      else if (key === 'x' && e.shiftKey) { e.preventDefault(); this.toggle('font.strike') }
      else if (key === 'l' && e.shiftKey) { e.preventDefault(); this.setStyle('alignment.horizontal', 'left') }
      else if (key === 'e' && e.shiftKey) { e.preventDefault(); this.setStyle('alignment.horizontal', 'center') }
      else if (key === 'r' && e.shiftKey) { e.preventDefault(); this.setStyle('alignment.horizontal', 'right') }
      else if (k === '\\') { e.preventDefault(); this.clearFormatting() }
      else if (key === 'a') { e.preventDefault(); this.selectAll() }
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
      case 'Enter': e.preventDefault(); return this.select(skip(row, e.shiftKey ? -1 : 1), col)
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
