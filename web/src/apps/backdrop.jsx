// The background chooser on the call screen: none, two strengths of blur, our
// own scenes, and a picture from the person's device.
import { useEffect } from 'preact/hooks'
import { Ban, Droplet, Droplets, ImagePlus, X } from 'lucide-preact'
import { scenes, choice, own, failed, loading, choose, readOwn, setOwn, removeOwn, warm } from '../lib/backdrop.js'
import { toast } from '../lib/store.js'
import { cx, pickFile } from '../lib/util.js'

export function BackdropTiles({ track }) {
  const c = choice.value
  useEffect(() => {
    readOwn()
    warm() // the chooser is open, so a click is likely: have the engine on hand
  }, [])
  const is = (kind, id) => c.kind === kind && (id === undefined || c.id === id)
  const tile = (key, on, label, body, pick) => (
    <button type="button" key={key} class={cx('fx-tile', on && 'on', on && loading.value > 0 && 'starting')} aria-pressed={on} aria-label={label} title={label} onClick={pick}>{body}</button>
  )
  const upload = async () => {
    const file = await pickFile('image/jpeg,image/png,image/webp')
    if (!file) return
    try {
      await setOwn(file)
      choose({ kind: 'own' }, track)
    } catch {
      toast("That picture couldn't be used.", 'error')
    }
  }
  return (
    <div class="fx-tiles" role="group" aria-label="Background">
      {tile('none', is('none'), 'No effect', <Ban size={20} />, () => choose({ kind: 'none' }, track))}
      {tile('soft', is('soft'), 'Blur slightly', <Droplet size={20} />, () => choose({ kind: 'soft' }, track))}
      {tile('blur', is('blur'), 'Blur', <Droplets size={20} />, () => choose({ kind: 'blur' }, track))}
      {scenes.map((s) => tile(s.id, is('scene', s.id), s.name, <img src={s.url} alt="" loading="lazy" />, () => choose({ kind: 'scene', id: s.id }, track)))}
      {own.value && (
        <span class="fx-own">
          {tile('own', is('own'), 'Your picture', <img src={own.value} alt="" />, () => choose({ kind: 'own' }, track))}
          <button type="button" class="fx-remove" aria-label="Remove your picture" title="Remove your picture" onClick={removeOwn}><X size={12} /></button>
        </span>
      )}
      {tile('add', false, own.value ? 'Use another picture' : 'Use your own picture', <ImagePlus size={20} />, upload)}
      {failed.value && <p class="fx-note">Backgrounds aren't available on this device.</p>}
    </div>
  )
}
