// API tokens, an agent's tokens, and the screen where a person lets another
// app (Claude, ChatGPT) use their account. A separate chunk: none of it is
// needed to paint the suite (see `Connect` in account.jsx).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { KeyRound, Plug, Plus, Copy, Trash2, Check } from 'lucide-preact'
import { user, toast } from '../lib/store.js'
import { query } from '../lib/router.js'
import { get, post, del } from '../lib/api.js'
import { signOut } from '../lib/session.js'
import { cx, when, copyText } from '../lib/util.js'
import { Button, Empty, Field, IconButton, Logo, Modal } from '../ui.jsx'
import './connect.css'

const DOCS = 'https://docs.opensuite.online/api'
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const day = (s) => dateFmt.format(new Date(s * 1000))
const copy = async (text) => (await copyText(text)) && toast('Copied')
const select = (e) => e.target.select()

// One token or connected app: what it may do and when it was last used.
function TokenRow({ t, onRevoke }) {
  const app = t.kind === 'connection'
  const expired = t.expires > 0 && t.expires * 1000 < Date.now()
  return (
    <div class="list-row">
      <span class={cx('kind-icon', app ? 'kind-meet' : 'kind-doc')}>{app ? <Plug size={16} /> : <KeyRound size={16} />}</span>
      <div class="grow">
        <div class="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{t.name}</span>
          {app && <span class="muted">connected app</span>}
          <span class={cx('badge', !t.readOnly && 'badge-accent')}>{t.readOnly ? 'Read only' : 'Full access'}</span>
          {expired && <span class="badge badge-warn">Expired</span>}
        </div>
        <div class="sub">
          {app ? 'Connected' : 'Created'} {day(t.created)}
          {' · '}{t.lastUsed ? 'Last used ' + when(t.lastUsed * 1000) : 'Never used'}
          {!app && !expired && (t.expires ? ' · Expires ' + day(t.expires) : ' · Never expires')}
          {!app && t.prefix && <> · <span class="cn-mono">{t.prefix}…</span></>}
        </div>
      </div>
      <IconButton icon={Trash2} label={(app ? 'Disconnect ' : 'Revoke ') + t.name} onClick={() => onRevoke(t)} />
    </div>
  )
}

function useTokens(base) {
  const [items, setItems] = useState(null)
  const load = () => get(base).then((r) => setItems(r.items || [])).catch((e) => toast(e.message, 'error'))
  useEffect(() => { load() }, [base])
  const revoke = async (t) => {
    try {
      await del(base + '/' + t.id)
      setItems((items || []).filter((x) => x.id !== t.id))
      toast(t.kind === 'connection' ? `${t.name} was disconnected` : 'Token revoked')
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  return { items, load, revoke }
}

// The dialog that makes a token, then shows its secret once. Closing it
// drops the secret: nothing keeps it.
function CreateToken({ base, title, onClose, onCancel = onClose, onDone = onClose, onCreated }) {
  const [f, setF] = useState({ name: '', readOnly: false, expiresInDays: 90 })
  const [made, setMade] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef()
  useLayoutEffect(() => first.current?.focus(), [made])
  const submit = async (e) => {
    e?.preventDefault()
    if (!f.name.trim()) return
    setBusy(true)
    setError('')
    try {
      const t = await post(base, { ...f, name: f.name.trim() })
      setMade(t)
      onCreated?.(t)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }
  if (made) {
    return (
      <Modal title="Token created" onClose={onDone} footer={<Button kind="primary" onClick={onDone}>Done</Button>}>
        <p>Copy it now and keep it somewhere safe. <b>You won't see it again.</b></p>
        <div class="row">
          <input ref={first} class="input grow cn-mono" readOnly value={made.secret} onFocus={select} aria-label="Token" />
          <Button icon={Copy} onClick={() => copy(made.secret)}>Copy</Button>
        </div>
        <p class="muted" style={{ fontSize: 13 }}>Send it in the <span class="cn-mono">Authorization: Bearer</span> header. <a href={DOCS} target="_blank" rel="noopener">How to use the API</a></p>
      </Modal>
    )
  }
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onCancel}>Cancel</Button><Button kind="primary" busy={busy} disabled={!f.name.trim()} onClick={submit}>Create token</Button></>}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        {error && <div class="form-error">{error}</div>}
        <Field label="Name" hint="So you can tell your tokens apart.">
          <input ref={first} class="input" value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} placeholder="Backup script" required />
        </Field>
        <Field label="Access">
          <select class="select" value={f.readOnly ? 'read' : 'full'} onChange={(e) => setF({ ...f, readOnly: e.target.value === 'read' })}>
            <option value="full">Full access: can read and change everything</option>
            <option value="read">Read only: can look but change nothing</option>
          </select>
        </Field>
        <Field label="Expires">
          <select class="select" value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: +e.target.value })}>
            <option value="0">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In 1 year</option>
          </select>
        </Field>
      </form>
    </Modal>
  )
}

function RevokeBody(t) {
  return t.kind === 'connection'
    ? { title: `Disconnect ${t.name}?`, text: `${t.name} can no longer use this account. You can connect it again at any time.`, action: 'Disconnect' }
    : { title: `Revoke ${t.name}?`, text: 'Anything using this token stops working at once. This cannot be undone.', action: 'Revoke' }
}

function ConfirmRevoke({ t, onClose, onConfirm }) {
  const r = RevokeBody(t)
  return (
    <Modal title={r.title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="danger" onClick={() => { onConfirm(t); onClose() }}>{r.action}</Button></>}>
      <p>{r.text}</p>
    </Modal>
  )
}

// Your account → API tokens.
export function Tokens() {
  const base = '/api/v1/tokens'
  const { items, load, revoke } = useTokens(base)
  const [dialog, setDialog] = useState(null)
  const mcp = location.origin + '/mcp'
  return (
    <div class="card" style={{ marginBottom: 16 }}>
      <div class="card-head">
        <h2>API tokens</h2>
        <Button icon={Plus} onClick={() => setDialog({ type: 'create' })}>New token</Button>
      </div>
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14, borderBottom: '1px solid var(--line)' }}>
        <p class="muted">A token lets a script or another app use Open Suite as you. <a href={DOCS} target="_blank" rel="noopener">API documentation</a></p>
        <Field label="Connect Claude or ChatGPT" hint="Add this address as a connector in the app, then allow it here when asked.">
          <div class="row">
            <input class="input grow cn-mono" readOnly value={mcp} onFocus={select} aria-label="Connector address" />
            <Button icon={Copy} onClick={() => copy(mcp)}>Copy</Button>
          </div>
        </Field>
      </div>
      {items && items.length === 0 && <Empty icon={KeyRound} title="No tokens" text="Tokens you create and apps you connect appear here." />}
      {items?.map((t) => <TokenRow key={t.id} t={t} onRevoke={(t) => setDialog({ type: 'revoke', t })} />)}
      {dialog?.type === 'create' && <CreateToken base={base} title="New token" onClose={() => setDialog(null)} onCreated={load} />}
      {dialog?.type === 'revoke' && <ConfirmRevoke t={dialog.t} onClose={() => setDialog(null)} onConfirm={revoke} />}
    </div>
  )
}

// Admin → People → an agent's tokens. One dialog whose content changes, so
// Escape never closes two at once. `start: 'create'` opens straight on the
// form (right after the agent was added).
export function AgentTokens({ person, added, onClose }) {
  const base = `/api/v1/admin/people/${person.id}/tokens`
  const { items, load, revoke } = useTokens(base)
  const [step, setStep] = useState(added ? 'added' : 'list')
  const [first, setFirst] = useState(!!added)
  const back = () => { setFirst(false); setStep('list'); load() }
  if (step === 'added') {
    return (
      <Modal title="Agent added" onClose={onClose} footer={<><Button onClick={onClose}>Later</Button><Button kind="primary" icon={KeyRound} onClick={() => setStep('create')}>Create token</Button></>}>
        <p><b>{person.name}</b> · <span class="cn-mono">{person.email}</span></p>
        <p class="muted">An agent has no password and cannot sign in. It uses the API with a token. Create its first token now?</p>
      </Modal>
    )
  }
  if (step === 'create') return <CreateToken base={base} title={`New token for ${person.name}`} onClose={onClose} onCancel={first ? onClose : back} onDone={back} />
  if (step?.revoke) {
    const r = RevokeBody(step.revoke)
    return (
      <Modal title={r.title} onClose={back} footer={<><Button onClick={back}>Cancel</Button><Button kind="danger" onClick={async () => { await revoke(step.revoke); setStep('list') }}>{r.action}</Button></>}>
        <p>{r.text}</p>
      </Modal>
    )
  }
  return (
    <Modal title={`Tokens for ${person.name}`} width={560} onClose={onClose} footer={<><Button icon={Plus} onClick={() => setStep('create')}>New token</Button><Button kind="primary" onClick={onClose}>Done</Button></>}>
      <p class="muted">The agent uses Open Suite through the API with these. <a href={DOCS} target="_blank" rel="noopener">API documentation</a></p>
      <div class="card">
        {items && items.length === 0 && <Empty icon={KeyRound} title="No tokens" text="This agent cannot do anything until it has one." />}
        {items?.map((t) => <TokenRow key={t.id} t={t} onRevoke={(t) => setStep({ revoke: t })} />)}
      </div>
    </Modal>
  )
}

// /oauth/authorize: another app asks to use this account. The query string
// is the app's request, passed back to the server untouched.
export function Consent() {
  const q = query.value.replace(/^\?/, '')
  const [req, setReq] = useState(null)
  const [error, setError] = useState('')
  const [write, setWrite] = useState(true)
  const [busy, setBusy] = useState('')
  useEffect(() => {
    get('/api/oauth/request?' + q).then(setReq).catch((e) => setError(e.message))
  }, [q])
  const u = user.value
  const canWrite = req?.scopes?.includes('write')
  const changes = canWrite && write
  const answer = async (allow) => {
    setBusy(allow ? 'allow' : 'deny')
    try {
      const res = allow
        ? await post('/api/oauth/approve', { query: q, readOnly: !canWrite || !write })
        : await post('/api/oauth/deny', { query: q })
      location.href = res.redirect
    } catch (e) {
      toast(e.message, 'error')
      setBusy('')
    }
  }
  return (
    <div class="auth">
      <div class="auth-card">
        <div class="auth-brand"><Logo size={30} /> Open Suite</div>
        {error ? (
          <>
            <h1>This request can't be used</h1>
            <div class="form-error" role="alert">{error}</div>
            <p class="muted">Go back to the app and try connecting again.</p>
            <div class="foot"><a href="/">Go to Open Suite</a></div>
          </>
        ) : req && (
          <>
            <h1>{req.client.name} wants to use your Open Suite account</h1>
            <div class="cn-who">
              <span class="kind-icon kind-meet"><Plug size={16} /></span>
              <div class="grow">
                <div style={{ fontWeight: 600 }}>{req.client.name}</div>
                <div class="muted cn-mono ellipsis" style={{ fontSize: 12.5 }}>{req.redirectHost}</div>
              </div>
            </div>
            <div>
              <p style={{ marginBottom: 8 }}>It will be able to, as you:</p>
              <ul class="cn-can">
                <li><Check size={15} />{changes ? 'Read and change' : 'Read'} your mail, calendar and contacts</li>
                <li><Check size={15} />{changes ? 'Read and send' : 'Read'} chat messages</li>
                <li><Check size={15} />{changes ? 'Read and change' : 'Read'} your files and documents</li>
              </ul>
            </div>
            {canWrite && req.canChooseReadOnly && (
              <label class="cn-check">
                <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
                <span>Allow changes<span class="field-hint" style={{ display: 'block', fontWeight: 400 }}>Off: it can only read.</span></span>
              </label>
            )}
            <p class="muted" style={{ fontSize: 13 }}>Signed in as {u.email} (<a href="#" onClick={(e) => { e.preventDefault(); signOut({ to: location.pathname + location.search }) }}>not you?</a>). You can disconnect it at any time in Your account.</p>
            <div class="row">
              <Button class="btn-lg grow" busy={busy === 'deny'} disabled={!!busy} onClick={() => answer(false)}>Cancel</Button>
              <Button kind="primary" class="btn-lg grow" busy={busy === 'allow'} disabled={!!busy} onClick={() => answer(true)}>Allow</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
