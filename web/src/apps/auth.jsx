import { useEffect, useRef, useState } from 'preact/hooks'
import { boot, setBoot, user } from '../lib/store.js'
import { get, post } from '../lib/api.js'
import { navigate } from '../lib/router.js'
import { Button, Field, Logo } from '../ui.jsx'

function Card({ title, children, foot }) {
  return (
    <div class="auth">
      <div class="auth-card">
        <div class="auth-brand"><Logo size={30} /> Open Suite</div>
        <h1>{title}</h1>
        {children}
        {foot && <div class="foot">{foot}</div>}
      </div>
    </div>
  )
}

// consentReturn keeps an app's connection request across signing up: the
// consent screen is the only page a new organisation returns to.
const consentReturn = () => (location.pathname === '/oauth/authorize' ? '?next=' + encodeURIComponent(location.pathname + location.search) : '')

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setBoot(await post('/api/login', { email, password }))
      if (location.pathname === '/signup') navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  const b = boot.value
  return (
    <Card title="Sign in" foot={b?.signup !== 'closed' && <>New here? <a href={'/signup' + consentReturn()}>Create an organisation</a></>}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        {error && <div class="form-error" role="alert">{error}</div>}
        <Field label="Address">
          <input class="input" autofocus autocomplete="username" value={email} onInput={(e) => setEmail(e.target.value)} placeholder={'you@' + (b?.mailDomain || 'example.com')} required />
        </Field>
        <Field label="Password">
          <input class="input" type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button kind="primary" class="btn-lg btn-block" type="submit" busy={busy}>Sign in</Button>
      </form>
    </Card>
  )
}

export function Signup() {
  const b = boot.value
  const [f, setF] = useState({ org: '', name: '', username: '', password: '', code: '' })
  const [avail, setAvail] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef()
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  useEffect(() => {
    clearTimeout(timer.current)
    setAvail(null)
    if (f.username.length < 3) return
    timer.current = setTimeout(async () => {
      try {
        setAvail(await get('/api/signup/check?username=' + encodeURIComponent(f.username.toLowerCase())))
      } catch {}
    }, 250)
  }, [f.username])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setBoot(await post('/api/signup', f))
      const next = new URLSearchParams(location.search).get('next') || ''
      navigate(next.startsWith('/oauth/authorize?') ? next : '/', { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  if (b?.signup === 'closed') {
    return <Card title="Sign-up is closed" foot={<a href="/">Back to sign in</a>}><p class="muted">Ask the person who runs this server for an account.</p></Card>
  }
  return (
    <Card title="Create your organisation" foot={<>Already have an account? <a href="/">Sign in</a></>}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        {error && <div class="form-error" role="alert">{error}</div>}
        <Field label="Organisation">
          <input class="input" autofocus value={f.org} onInput={set('org')} placeholder="Acme Ltd" required />
        </Field>
        <Field label="Your name">
          <input class="input" autocomplete="name" value={f.name} onInput={set('name')} required />
        </Field>
        <Field label="Your address" error={avail && !avail.available ? avail.reason : ''} hint={avail?.available ? 'Available. This is your sign-in and your email address.' : 'This is your sign-in and your email address.'}>
          <div class="input-group">
            <input class="input" autocomplete="username" autocapitalize="none" spellcheck={false} value={f.username} onInput={set('username')} required />
            <span class="suffix">@{b?.mailDomain}</span>
          </div>
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <input class="input" type="password" autocomplete="new-password" minlength={10} value={f.password} onInput={set('password')} required />
        </Field>
        {b?.signup === 'code' && (
          <Field label="Invitation code">
            <input class="input" value={f.code} onInput={set('code')} required />
          </Field>
        )}
        <Button kind="primary" class="btn-lg btn-block" type="submit" busy={busy}>Create organisation</Button>
      </form>
    </Card>
  )
}

// Shown on first sign-in with a temporary password from an administrator.
export function SetPassword() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await post('/api/account/password', { password })
      setBoot({ ...boot.value, user: { ...user.value, mustChange: false } })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return (
    <Card title="Choose your password">
      <p class="muted">Welcome, {user.value.name.split(' ')[0]}. Replace the temporary password you were given.</p>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        {error && <div class="form-error" role="alert">{error}</div>}
        <Field label="New password" hint="At least 10 characters.">
          <input class="input" type="password" autofocus autocomplete="new-password" minlength={10} value={password} onInput={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button kind="primary" class="btn-lg btn-block" type="submit" busy={busy}>Continue</Button>
      </form>
    </Card>
  )
}
