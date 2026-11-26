import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { boot, user, org, patchBoot, toast } from '../lib/store.js'
import { api, post, del, refreshBoot } from '../lib/api.js'
import { Avatar, Button, Field } from '../ui.jsx'
import { signOut } from '../lib/session.js'

// Tokens, agents' tokens and the connect-an-app screen are their own chunk
// (connect.jsx): fetched at idle after start, or when one of them is opened.
const connect = signal(null)
let loading = null
export function loadConnect() {
  loading ??= import('./connect.jsx').then((m) => (connect.value = m))
  return loading
}
export function Connect({ view, fallback = null, ...props }) {
  useEffect(() => { loadConnect() }, [])
  const View = connect.value?.[view]
  return View ? <View {...props} /> : fallback
}

// squarePicture crops a chosen picture to its middle square and shrinks it
// to 256 pixels, so what is stored is small whatever the camera made.
async function squarePicture(file) {
  const img = await createImageBitmap(file)
  const side = Math.min(img.width, img.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256)
  img.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That picture could not be read.'))), 'image/jpeg', 0.9))
}

function Picture({ u }) {
  const [busy, setBusy] = useState(false)
  const me = boot.value.people.find((p) => p.id === u.id)
  const choose = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      await api('PUT', '/api/v1/me/photo', await squarePicture(file), { type: 'image/jpeg' })
      await refreshBoot()
      toast('Picture updated')
    } catch (err) {
      toast(err.message || 'That picture could not be read.', 'error')
    }
    setBusy(false)
  }
  const remove = async () => {
    setBusy(true)
    try {
      await del('/api/v1/me/photo')
      await refreshBoot()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  return (
    <div class="row" style={{ gap: 14 }}>
      <Avatar name={u.name} id={u.id} size={64} />
      <label class={'btn btn-default' + (busy ? ' disabled' : '')} style={{ cursor: 'pointer' }}>
        {me?.photo ? 'Change picture' : 'Add a picture'}
        <input type="file" accept="image/*" hidden disabled={busy} onChange={choose} />
      </label>
      {me?.photo > 0 && <Button disabled={busy} onClick={remove}>Remove</Button>}
    </div>
  )
}

export function Account() {
  const u = user.value
  const [name, setName] = useState(u.name)
  const [pw, setPw] = useState({ current: '', password: '' })
  const [error, setError] = useState('')

  const saveName = async (e) => {
    e.preventDefault()
    try {
      await post('/api/account/profile', { name })
      patchBoot({ user: { ...u, name }, people: boot.value.people.map((p) => (p.id === u.id ? { ...p, name } : p)) })
      toast('Name updated')
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const savePw = async (e) => {
    e.preventDefault()
    setError('')
    try {
      await post('/api/account/password', pw)
      setPw({ current: '', password: '' })
      toast('Password changed. Other devices were signed out.')
    } catch (err) {
      setError(err.message)
    }
  }
  return (
    <div class="page">
      <div class="page-inner" style={{ maxWidth: 620 }}>
        <div class="page-head">
          <Avatar name={u.name} id={u.id} size={52} />
          <div class="grow">
            <h1>{u.name}</h1>
            <p class="muted">{u.email} · {org.value.name}</p>
          </div>
        </div>
        <form class="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }} onSubmit={saveName}>
          <h2>Profile</h2>
          <Picture u={u} />
          <Field label="Name"><input class="input" value={name} onInput={(e) => setName(e.target.value)} required /></Field>
          <div><Button kind="primary" type="submit" disabled={name.trim() === u.name}>Save</Button></div>
        </form>
        <form class="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }} onSubmit={savePw}>
          <h2>Password</h2>
          {error && <div class="form-error">{error}</div>}
          <Field label="Current password"><input class="input" type="password" autocomplete="current-password" value={pw.current} onInput={(e) => setPw({ ...pw, current: e.target.value })} required /></Field>
          <Field label="New password" hint="At least 10 characters."><input class="input" type="password" autocomplete="new-password" minlength={10} value={pw.password} onInput={(e) => setPw({ ...pw, password: e.target.value })} required /></Field>
          <div><Button kind="primary" type="submit">Change password</Button></div>
        </form>
        <Connect view="Tokens" />
        <Button kind="danger" onClick={signOut}>Sign out</Button>
      </div>
    </div>
  )
}
