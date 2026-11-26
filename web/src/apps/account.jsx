import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { boot, user, org, patchBoot, toast } from '../lib/store.js'
import { post } from '../lib/api.js'
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
