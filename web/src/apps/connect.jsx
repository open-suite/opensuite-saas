// Public page for connecting an external Slack channel to an Open Suite Chat
// room. Opened by the external partner from a one-time invite link; no Open
// Suite account is needed.
import { useEffect, useState } from 'preact/hooks'
import { Link2, Link2Off, CheckCircle2, Hash, Lock, Plus, ArrowRight } from 'lucide-preact'
import './connect.css'
import { get, post } from '../lib/api.js'
import { Button, Empty, Field, Logo } from '../ui.jsx'

export function SlackConnect({ token }) {
  const params = new URLSearchParams(location.search)
  const oauthErr = params.get('error')
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [channels, setChannels] = useState(null)
  const [picked, setPicked] = useState('')
  const [mode, setMode] = useState('existing') // existing | new
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    document.title = 'Connect Slack · Open Suite'
    get('/api/slack/invite/' + encodeURIComponent(token), { quiet: true })
      .then((d) => {
        setInfo(d)
        if (d.authorized) {
          get('/api/slack/invite/' + encodeURIComponent(token) + '/channels', { quiet: true })
            .then((c) => {
              setChannels(c.channels || [])
              if (c.channels?.length) setPicked(c.channels[0].id)
            })
            .catch((e) => setError(e.message))
        }
      })
      .catch((e) => setError(e.message))
  }, [token])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const ch = channels?.find((c) => c.id === picked)
      const body = mode === 'new'
        ? { createName: newName.trim().toLowerCase() }
        : { channelId: picked, channelName: ch?.name || '' }
      const res = await post('/api/slack/invite/' + encodeURIComponent(token) + '/link', body, { quiet: true })
      setDone(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="slk-page">
      <div class="slk-card">
        <div class="slk-brand">
          <Logo size={32} />
          <span>Open Suite</span>
        </div>

        {done ? (
          <div class="slk-done">
            <CheckCircle2 size={36} class="slk-ok" />
            <h1>Channel connected</h1>
            <p class="muted">
              <b>#{done.channelName}</b> in <b>{done.teamName}</b> is now connected to{' '}
              <b>{done.roomName || done.org}</b> on Open Suite.
            </p>
            <p class="muted" style={{ fontSize: 13 }}>
              Messages, replies, reactions and files sent from now on will appear in both places. You can close this tab and return to Slack.
            </p>
          </div>
        ) : error && !info ? (
          <Empty icon={Link2Off} title="This invite isn't available" text={error} />
        ) : !info ? (
          <div class="slk-wait muted">Checking invite…</div>
        ) : info.authorized ? (
          <form onSubmit={submit}>
            <h1>Choose a Slack channel</h1>
            <p class="muted">
              Link a channel in <b>{info.teamName}</b> with <b>{info.roomName || 'this conversation'}</b> at <b>{info.org}</b>.
            </p>
            <div class="slk-tabs">
              <button type="button" class={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>Existing channel</button>
              <button type="button" class={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}><Plus size={14} /> New channel</button>
            </div>
            {mode === 'existing' ? (
              <Field label="Slack channel" hint="Private channels appear once the Open Suite app is invited to them.">
                {channels === null ? (
                  <div class="muted" style={{ padding: '8px 0' }}>Loading channels…</div>
                ) : channels.length === 0 ? (
                  <div class="muted" style={{ padding: '8px 0' }}>No channels found. Switch to “New channel” to create one.</div>
                ) : (
                  <div class="slk-list">
                    {channels.map((c) => (
                      <label key={c.id} class={picked === c.id ? 'on' : ''}>
                        <input type="radio" name="channel" value={c.id} checked={picked === c.id} onChange={() => setPicked(c.id)} />
                        {c.private ? <Lock size={14} /> : <Hash size={14} />}
                        <span class="ellipsis">{c.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </Field>
            ) : (
              <Field label="New channel name" hint="Lowercase letters, numbers, dashes or underscores.">
                <input class="input" placeholder="e.g. partner-opensuite" value={newName} onInput={(e) => setNewName(e.target.value)} />
              </Field>
            )}
            {error && <p class="field-error" style={{ marginTop: 8 }}>{error}</p>}
            <div class="slk-actions">
              <Button type="submit" kind="primary" busy={busy} disabled={mode === 'existing' ? !picked : !newName.trim()}>
                Connect channel <ArrowRight size={16} />
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <div class="slk-icon"><Link2 size={24} /></div>
            <h1>Connect a Slack channel</h1>
            <p class="muted">
              <b>{info.org}</b> invited your workspace to connect a Slack channel to{' '}
              <b>{info.roomName || 'a conversation'}</b> on Open Suite.
            </p>
            <ul class="slk-notes">
              <li>Works on any Slack plan, including Slack Free.</li>
              <li>Only messages sent after connecting are shared — past channel history is never read.</li>
              <li>Either organisation can disconnect the channel at any time.</li>
            </ul>
            {oauthErr && (
              <p class="field-error" style={{ marginBottom: 12 }}>
                {oauthErr === 'cancelled' ? 'Slack authorisation was cancelled. You can try again below.' : 'Slack authorisation did not finish. Please try again.'}
              </p>
            )}
            <div class="slk-actions">
              <a class="btn btn-primary" href={info.authorizeUrl}>
                Continue with Slack <ArrowRight size={16} />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
