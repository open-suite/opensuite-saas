// Call backgrounds: blur what is behind a person, or replace it with a
// picture. Everything runs on the person's own device: the camera frames are
// separated into person and background by a small model on the graphics
// card, then recomposed, before any video leaves the browser.
//
// The model and its runtime are served from our own origin (see
// vite.config.js). They are 3 MB over the wire and are fetched only when
// someone first turns a background on.
import { signal } from '@preact/signals'
import { kvGet, kvSet, kvDel } from './idb.js'

const SEG = __SEG__ // eslint-disable-line no-undef
const BG = '/assets/bg/' // rename when the pictures change: /assets/ is cached for good

export const scenes = [
  { id: 'studio', name: 'Studio' },
  { id: 'daylight', name: 'Daylight' },
  { id: 'dusk', name: 'Dusk' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'lights', name: 'Lights' },
  { id: 'ember', name: 'Ember' },
].map((s) => ({ ...s, url: BG + s.id + '.webp' }))

// The same checks the engine makes, so the control is hidden where it cannot work.
export const supported = (() => {
  try {
    return typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof createImageBitmap !== 'undefined' &&
      !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
})()

// choice: { kind: 'none' | 'soft' | 'blur' | 'scene' | 'own', id? }
const KEY = 'os:backdrop'
function saved() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY))
    if (c && ['soft', 'blur', 'own'].includes(c.kind)) return c
    if (c?.kind === 'scene' && scenes.some((s) => s.id === c.id)) return c
  } catch {}
  return { kind: 'none' }
}
export const choice = signal(supported ? saved() : { kind: 'none' })
export const own = signal(null) // object URL of the person's own picture, once read from the device
export const failed = signal(false)
export const loading = signal(0) // changes in flight; the chosen tile shows it

const OWN = 'backdrop:own'
let ownRead = null
export function readOwn() {
  ownRead ??= kvGet(OWN).then((blob) => {
    if (blob instanceof Blob) own.value = URL.createObjectURL(blob)
  })
  return ownRead
}

// setOwn keeps a picture of the person's choosing, on this device only. It is
// scaled to what a camera frame needs first.
export async function setOwn(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1920 / bitmap.width, 1080 / bitmap.height)
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  await kvSet(OWN, blob)
  await readOwn()
  if (own.value) URL.revokeObjectURL(own.value)
  own.value = URL.createObjectURL(blob)
}

export async function removeOwn() {
  await kvDel(OWN)
  if (own.value) URL.revokeObjectURL(own.value)
  own.value = null
  if (choice.value.kind === 'own') choose({ kind: 'none' })
}

let lib = null
const engine = () => (lib ??= import('@livekit/track-processors'))

// warm fetches the engine ahead of the click that needs it.
let warmed = false
export function warm() {
  if (warmed || !supported) return
  warmed = true
  engine().catch(() => (warmed = false))
  for (const f of ['/vision_wasm_internal.js', '/vision_wasm_internal.wasm', '/selfie_segmenter.tflite']) fetch(SEG + f).catch(() => {})
}

async function modeFor(c) {
  if (c.kind === 'soft') return { mode: 'background-blur', blurRadius: 6 }
  if (c.kind === 'blur') return { mode: 'background-blur', blurRadius: 16 }
  if (c.kind === 'scene') return { mode: 'virtual-background', imagePath: BG + c.id + '.webp' }
  if (c.kind === 'own') {
    await readOwn()
    if (own.value) return { mode: 'virtual-background', imagePath: own.value }
  }
  return null
}

// What the last frame cost, for the checks in tests/.
const timing = (window.__backdrop = { ms: 0, segment: 0 })

// One engine per camera track, and one change at a time: a second choice made
// while the first is still loading replaces it instead of racing it.
const state = new WeakMap() // track -> { proc, busy, want }

export function apply(track, c = choice.value) {
  if (!track || !supported) return Promise.resolve()
  let st = state.get(track)
  if (!st) state.set(track, (st = { proc: null, busy: null, want: null }))
  st.want = c
  st.busy ??= (async () => {
    loading.value++
    try {
      while (st.want) {
        const next = st.want
        st.want = null
        const mode = await modeFor(next)
        if (!mode) {
          if (st.proc) {
            st.proc = null
            await track.stopProcessor()
          }
        } else if (st.proc) {
          await st.proc.switchTo(mode)
        } else {
          const { BackgroundProcessor } = await engine()
          const proc = BackgroundProcessor({
            ...mode,
            assetPaths: { tasksVisionFileSet: SEG, modelAssetPath: SEG + '/selfie_segmenter.tflite' },
            onFrameProcessed: (s) => { timing.ms = s.processingTimeMs; timing.segment = s.segmentationTimeMs },
          }, 'backdrop')
          await track.setProcessor(proc)
          st.proc = proc
        }
      }
      failed.value = false
    } catch (e) {
      console.warn('backdrop', e)
      failed.value = true
      st.proc = null
      await track.stopProcessor().catch(() => {})
    } finally {
      st.busy = null
      loading.value--
    }
  })()
  return st.busy
}

// settled resolves once the chosen background is on the track (or has
// failed). The call screen waits for it before sending video, so nobody is
// shown the real room while the engine is still starting.
export const settled = (track) => state.get(track)?.busy || Promise.resolve()

// choose records what the person wants and applies it to their camera.
export function choose(c, track) {
  choice.value = c
  failed.value = false
  if (c.kind === 'none') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, JSON.stringify(c))
  return apply(track, c)
}
