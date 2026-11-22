// Presenting: the full-screen slide show, and the presenter's own window with
// the next slide, the notes and a clock. The two windows are on the same
// device and keep in step over a broadcast channel; no server is involved.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { ChevronLeft, ChevronRight, X, Pause, Play, RotateCcw, AArrowUp, AArrowDown } from 'lucide-preact'
import { cx } from '../lib/util.js'
import { IconButton, Button } from '../ui.jsx'
import { W, H } from './slides-model.js'
import { SlideView } from './slides-render.jsx'

export const showChannel = (id) => ('BroadcastChannel' in window ? new BroadcastChannel('os-deck-show-' + id) : null)

function useWindowSize() {
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => {
    const on = () => setSize({ w: innerWidth, h: innerHeight })
    addEventListener('resize', on)
    return () => removeEventListener('resize', on)
  }, [])
  return size
}

function Scaled({ deck, id, width }) {
  const s = width / W
  return (
    <div class="sl-fit" style={{ width, height: H * s }}>
      <div class="sl-scaled" style={`transform:scale(${s})`}>
        <SlideView deck={deck} id={id} v={deck.versions.get(id) || 0} themeId={deck.themeId()} mode="show" />
      </div>
    </div>
  )
}

// Show fills the screen with one slide at a time.
export function Show({ deck, start, onExit }) {
  const order = deck.order()
  const [at, setAt] = useState({ id: start, prev: null, dir: 1, n: 0 })
  const [over, setOver] = useState(false) // past the last slide
  const [awake, setAwake] = useState(false)
  const size = useWindowSize()
  const chan = useRef(null)
  const root = useRef()
  const state = useRef({})
  const started = useRef(Date.now())
  const id = order.includes(at.id) ? at.id : order[0]
  const index = order.indexOf(id)
  state.current = { id, index, order, over }

  const show = (next, quiet) => {
    const s = state.current
    if (!s.order.includes(next) || (next === s.id && !s.over)) return
    setOver(false)
    setAt((a) => ({ id: next, prev: s.id, dir: s.order.indexOf(next) >= s.index ? 1 : -1, n: a.n + 1 }))
    if (!quiet) chan.current?.postMessage({ t: 'at', id: next, started: started.current })
  }
  const go = (n) => {
    const s = state.current
    if (s.over) return n > 0 ? onExit() : setOver(false)
    const j = s.index + n
    if (j >= s.order.length) return setOver(true)
    if (j >= 0) show(s.order[j])
  }

  useEffect(() => {
    const c = (chan.current = showChannel(deck.id))
    if (c) {
      c.onmessage = (e) => {
        const m = e.data
        if (m.t === 'at') show(m.id, true)
        else if (m.t === 'hello') c.postMessage({ t: 'at', id: state.current.id, started: started.current })
        else if (m.t === 'end') onExit()
      }
      c.postMessage({ t: 'at', id: state.current.id, started: started.current })
    }
    const key = (e) => {
      if (['ArrowRight', 'ArrowDown', ' ', 'Enter', 'PageDown', 'n'].includes(e.key)) go(1)
      else if (['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp', 'p'].includes(e.key)) go(-1)
      else if (e.key === 'Home') show(state.current.order[0])
      else if (e.key === 'End') show(state.current.order[state.current.order.length - 1])
      else if (e.key === 'Escape') onExit()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    const full = () => !document.fullscreenElement && entered && onExit()
    let entered = !!document.fullscreenElement
    const mark = () => (entered ||= !!document.fullscreenElement)
    addEventListener('keydown', key, true)
    document.addEventListener('fullscreenchange', mark)
    document.addEventListener('fullscreenchange', full)
    return () => {
      removeEventListener('keydown', key, true)
      document.removeEventListener('fullscreenchange', mark)
      document.removeEventListener('fullscreenchange', full)
      c?.close()
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, [])

  // The controls show while the pointer moves and then get out of the way.
  const sleep = useRef()
  const wake = () => {
    setAwake(true)
    clearTimeout(sleep.current)
    sleep.current = setTimeout(() => setAwake(false), 2200)
  }
  useEffect(() => () => clearTimeout(sleep.current), [])

  const swipe = useRef(null)
  const down = (e) => (swipe.current = { x: e.clientX, y: e.clientY })
  const up = (e) => {
    const s = swipe.current
    swipe.current = null
    if (e.target.closest('a, button')) return
    const dx = s ? e.clientX - s.x : 0
    if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1)
    else if (e.pointerType === 'touch' && e.clientX < innerWidth * 0.3) go(-1)
    else go(1)
  }

  const s = Math.min(size.w / W, size.h / H)
  const trans = deck.meta.get('transition') || 'fade'
  const layer = (sid, cls) => (
    <div key={sid + ':' + at.n} class={cx('sl-show-layer', cls, at.dir < 0 && 'rev')}>
      <div class="sl-scaled" style={`transform:scale(${s})`}>
        <SlideView deck={deck} id={sid} v={deck.versions.get(sid) || 0} themeId={deck.themeId()} mode="show" />
      </div>
    </div>
  )
  return (
    <div class="sl-show" ref={root} onPointerDown={down} onPointerUp={up} onPointerMove={wake} role="document" aria-label="Slide show">
      <div class="sl-show-fit" style={{ width: W * s, height: H * s }}>
        {over ? <div class="sl-show-end">End of presentation<span>Click or press Esc to leave</span></div> : <>
          {at.prev && at.prev !== id && order.includes(at.prev) && layer(at.prev, 'out-' + trans)}
          {layer(id, at.prev ? 'in-' + trans : '')}
        </>}
      </div>
      <div class={cx('sl-show-bar', awake && 'on')} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <IconButton icon={ChevronLeft} label="Previous slide" onClick={() => go(-1)} />
        <span class="sl-show-count">{over ? order.length : index + 1} / {order.length}</span>
        <IconButton icon={ChevronRight} label="Next slide" onClick={() => go(1)} />
        <IconButton icon={X} label="End slide show" onClick={onExit} />
      </div>
    </div>
  )
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p = (n) => String(n).padStart(2, '0')
  return (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + p(Math.floor(s / 60) % 60) + ':' + p(s % 60)
}

// Presenter is the speaker's window: this slide, the next one, the notes and
// the time. It drives the slide show in the other window.
export function Presenter({ deck, title }) {
  const order = deck.order()
  const [cur, setCur] = useState(deck.cur)
  const [timer, setTimer] = useState({ base: 0, since: Date.now() }) // since = null while paused
  const [, beat] = useState(0)
  const [zoom, setZoom] = useState(1)
  const chan = useRef(null)
  const left = useRef()
  const [wide, setWide] = useState(0)
  const id = order.includes(cur) ? cur : order[0]
  const index = order.indexOf(id)
  const state = useRef({})
  state.current = { index, order }

  const show = (i) => {
    const s = state.current
    const next = s.order[Math.max(0, Math.min(s.order.length - 1, i))]
    if (!next) return
    setCur(next)
    chan.current?.postMessage({ t: 'at', id: next })
  }

  useEffect(() => {
    document.title = `Presenter view · ${title || 'Untitled'}`
    const c = (chan.current = showChannel(deck.id))
    if (c) {
      c.onmessage = (e) => {
        if (e.data.t !== 'at') return
        setCur(e.data.id)
        if (e.data.started) setTimer((t) => (t.synced ? t : { base: 0, since: e.data.started, synced: true }))
      }
      c.postMessage({ t: 'hello' })
    }
    const tick = setInterval(() => beat((n) => n + 1), 1000)
    const key = (e) => {
      if (['ArrowRight', 'ArrowDown', ' ', 'Enter', 'PageDown'].includes(e.key)) show(state.current.index + 1)
      else if (['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp'].includes(e.key)) show(state.current.index - 1)
      else if (e.key === 'Home') show(0)
      else if (e.key === 'End') show(state.current.order.length - 1)
      else return
      e.preventDefault()
    }
    addEventListener('keydown', key)
    return () => {
      clearInterval(tick)
      removeEventListener('keydown', key)
      c?.close()
    }
  }, [])

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setWide(left.current.clientWidth))
    ro.observe(left.current)
    setWide(left.current.clientWidth)
    return () => ro.disconnect()
  }, [])

  const running = timer.since != null
  const ms = timer.base + (running ? Date.now() - timer.since : 0)
  const next = order[index + 1]
  const notes = deck.notes(id)
  const end = () => {
    chan.current?.postMessage({ t: 'end' })
    window.close()
  }
  return (
    <div class="sl-presenter">
      <div class="sl-pr-main" ref={left}>
        <div class="sl-pr-label">Slide {index + 1} of {order.length}</div>
        {wide > 0 && <Scaled deck={deck} id={id} width={Math.min(wide, ((innerHeight - 170) * W) / H)} />}
        <div class="sl-pr-bar">
          <Button icon={ChevronLeft} disabled={index <= 0} onClick={() => show(index - 1)}>Previous</Button>
          <Button kind="primary" disabled={index >= order.length - 1} onClick={() => show(index + 1)}>Next<ChevronRight size={16} /></Button>
          <span class="grow" />
          <span class="sl-pr-time" aria-label="Time presenting">{elapsed(ms)}</span>
          <IconButton icon={running ? Pause : Play} label={running ? 'Pause timer' : 'Resume timer'} onClick={() => setTimer(running ? { base: ms, since: null, synced: true } : { base: ms, since: Date.now(), synced: true })} />
          <IconButton icon={RotateCcw} label="Reset timer" onClick={() => setTimer({ base: 0, since: running ? Date.now() : null, synced: true })} />
          <span class="sl-pr-clock">{clockFmt.format(new Date())}</span>
          <Button onClick={end}>End</Button>
        </div>
      </div>
      <div class="sl-pr-side">
        <div class="sl-pr-label">Next</div>
        {next ? <Scaled deck={deck} id={next} width={300} /> : <div class="sl-pr-last">Last slide</div>}
        <div class="sl-pr-label row">
          <span class="grow">Notes</span>
          <IconButton icon={AArrowDown} label="Smaller notes" onClick={() => setZoom((z) => Math.max(0.7, z - 0.15))} />
          <IconButton icon={AArrowUp} label="Larger notes" onClick={() => setZoom((z) => Math.min(2.2, z + 0.15))} />
        </div>
        <div class="sl-pr-notes" style={{ fontSize: 17 * zoom }}>{notes || <span class="muted">No notes for this slide.</span>}</div>
      </div>
    </div>
  )
}
