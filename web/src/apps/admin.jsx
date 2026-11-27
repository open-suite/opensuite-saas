import { useEffect, useState } from 'preact/hooks'
import { UserPlus, Bot, MoreHorizontal, KeyRound, Ban, Trash2, CircleCheck, Globe, Copy, RefreshCw, RotateCcw, ShieldCheck, Check, X as XIcon } from 'lucide-preact'
import { boot, user, org, people, patchBoot, toast } from '../lib/store.js'
import { parts, navigate } from '../lib/router.js'
import { get, post, patch, del, refreshBoot } from '../lib/api.js'
import { cx, when, bytes, copyText } from '../lib/util.js'
import { Avatar, Button, Empty, Field, IconButton, Menu, Modal } from '../ui.jsx'
import { Connect } from './account.jsx'
import { GroupsAdmin } from './groups.jsx'
import { groups } from '../lib/groups.js'

const roleName = { owner: 'Owner', admin: 'Administrator', member: 'Member' }

function Secret({ title, email, password, onClose }) {
  const text = `Open Suite sign-in\nAddress: ${email}\nTemporary password: ${password}\n${location.origin}`
  return (
    <Modal title={title} onClose={onClose} footer={<><Button icon={Copy} onClick={async () => (await copyText(text)) && toast('Copied')}>Copy details</Button><Button kind="primary" onClick={onClose}>Done</Button></>}>
      <p class="muted">Pass these on securely. They'll be asked to choose their own password when they first sign in. This password is shown only once.</p>
      <div class="card" style={{ padding: 14, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.8 }}>
        <div>{email}</div>
        <div style={{ fontWeight: 700 }}>{password}</div>
      </div>
    </Modal>
  )
}

// Adds a person, or an agent: an account with no password that works
// through the API with tokens.
function AddPerson({ domains, agent, onClose, onCreated }) {
  const [f, setF] = useState({ name: '', username: '', domain: domains[0], role: 'member', ...(agent && { agent: true }) })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const suggest = (e) => {
    const name = e.target.value
    const guess = name.trim().toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).join('.')
    setF({ ...f, name, username: f.touched ? f.username : guess })
  }
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { touched, ...body } = f
      const res = await post('/api/admin/users', body)
      onCreated({ ...res, name: f.name })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return (
    <Modal title={agent ? 'Add an agent' : 'Add a person'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={submit}>{agent ? 'Add agent' : 'Add person'}</Button></>}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        {agent && <p class="muted">An agent has no password and works through the API with tokens. Agents count towards the plan's people limit.</p>}
        {error && <div class="form-error">{error}</div>}
        <Field label="Name"><input class="input" autofocus value={f.name} onInput={suggest} placeholder={agent ? 'Support assistant' : undefined} required /></Field>
        <Field label="Address" hint={agent ? 'Its email address.' : 'Their sign-in and email address.'}>
          <div class="input-group">
            <input class="input" autocapitalize="none" spellcheck={false} value={f.username} onInput={(e) => setF({ ...f, username: e.target.value, touched: true })} required />
            {domains.length > 1 ? (
              <select class="select" style={{ width: 'auto', borderRadius: '0 8px 8px 0', borderLeft: 0 }} value={f.domain} onChange={set('domain')}>{domains.map((d) => <option key={d} value={d}>@{d}</option>)}</select>
            ) : <span class="suffix">@{domains[0]}</span>}
          </div>
        </Field>
        <Field label="Role">
          <select class="select" value={f.role} onChange={set('role')}>
            <option value="member">Member</option>
            <option value="admin">Administrator: can manage people, groups and domains</option>
          </select>
        </Field>
      </form>
    </Modal>
  )
}

function People({ data, reload }) {
  const [dialog, setDialog] = useState(null)
  const me = user.value
  const limit = data?.limits?.maxUsers
  const list = data?.people || people.value
  const mailDomains = org.value.mailDomains || [boot.value.mailDomain]
  const act = async (p, body, done) => {
    try {
      const res = await patch('/api/admin/users/' + p.id, body)
      if (res.password) setDialog({ type: 'secret', title: 'Password reset', email: p.email, password: res.password })
      else if (done) toast(done)
      reload()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  const remove = async (p) => {
    try {
      await del('/api/admin/users/' + p.id)
      toast(`${p.name} was removed`)
      reload()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  return (
    <>
      <div class="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <span class="grow muted" style={{ minWidth: 180 }}>{list.length} of {limit ?? '…'} people on the {data?.limits?.label || ''} plan</span>
        <Button icon={Bot} onClick={() => setDialog({ type: 'add', agent: true })}>Add agent</Button>
        <Button kind="primary" icon={UserPlus} onClick={() => setDialog({ type: 'add' })}>Add person</Button>
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th>Name</th><th>Role</th><th>Last active</th><th /></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>
                  <div class="row" style={{ gap: 12 }}>
                    <Avatar name={p.name} id={p.id} size={32} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{p.name} {p.id === me.id && <span class="muted" style={{ fontWeight: 400 }}>(you)</span>}</div>
                      <div class="muted ellipsis" style={{ fontSize: 12.5 }}>{p.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {p.status === 'suspended' ? <span class="badge badge-warn">Suspended</span> : <span class={cx('badge', p.role !== 'member' && 'badge-accent')}>{roleName[p.role]}</span>}
                    {p.agent && <span class="badge" title="No password. Works through the API with tokens.">Agent</span>}                  </div>
                </td>
                <td class="muted">{p.seen ? when(p.seen * 1000) : 'Never'}</td>
                <td style={{ textAlign: 'right' }}>
                  {p.id !== me.id && (p.role !== 'owner' || me.role === 'owner') && (
                    <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label={'Manage ' + p.name} />} items={[
                      p.role !== 'member' && { label: 'Make member', icon: ShieldCheck, onSelect: () => act(p, { role: 'member' }, 'Role changed') },
                      p.role !== 'admin' && { label: 'Make administrator', icon: ShieldCheck, onSelect: () => act(p, { role: 'admin' }, 'Role changed') },
                      me.role === 'owner' && p.role !== 'owner' && !p.agent && { label: 'Make owner', icon: ShieldCheck, onSelect: () => act(p, { role: 'owner' }, 'Role changed') },
                      { divider: true },
                      p.agent
                        ? { label: 'Manage tokens', icon: KeyRound, onSelect: () => setDialog({ type: 'tokens', person: p }) }
                        : { label: 'Reset password', icon: KeyRound, onSelect: () => act(p, { resetPassword: true }) },
                      p.status === 'active'
                        ? { label: 'Suspend', icon: Ban, onSelect: () => act(p, { status: 'suspended' }, `${p.name} can no longer sign in`) }
                        : { label: 'Reactivate', icon: CircleCheck, onSelect: () => act(p, { status: 'active' }, `${p.name} can sign in again`) },
                      { divider: true },
                      { label: 'Remove', icon: Trash2, danger: true, onSelect: () => setDialog({ type: 'remove', person: p }) },
                    ]} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog?.type === 'add' && <AddPerson domains={mailDomains} agent={dialog.agent} onClose={() => setDialog(null)} onCreated={(res) => { setDialog(dialog.agent ? { type: 'tokens', person: res, added: true } : { type: 'secret', title: 'Person added', ...res }); reload() }} />}
      {dialog?.type === 'secret' && <Secret {...dialog} onClose={() => setDialog(null)} />}
      {dialog?.type === 'tokens' && <Connect view="AgentTokens" person={dialog.person} added={dialog.added} onClose={() => setDialog(null)} />}
      {dialog?.type === 'remove' && (
        <Modal title={`Remove ${dialog.person.name}?`} onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button kind="danger" onClick={() => { remove(dialog.person); setDialog(null) }}>Remove</Button></>}>
          <p>{dialog.person.agent
            ? 'Its mailbox and chat account are deleted and its tokens stop working. Its documents and meeting rooms stay with the organisation and become yours.'
            : 'Their mailbox and chat account are deleted. Their documents and meeting rooms stay with the organisation and become yours.'}</p>
        </Modal>
      )}
    </>
  )
}

function Domains({ data, setData }) {
  const [name, setName] = useState('')
  const [checks, setChecks] = useState({})
  const [busy, setBusy] = useState('')
  const all = data?.domains || []
  const own = all.find((d) => d.included)
  const domains = all.filter((d) => !d.included)
  const add = async (e) => {
    e.preventDefault()
    try {
      const res = await post('/api/admin/domains', { domain: name })
      setData({ ...data, domains: res.domains })
      setName('')
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const verify = async (d) => {
    setBusy(d.domain)
    try {
      const res = await post(`/api/admin/domains/${d.domain}/verify`)
      setData({ ...data, domains: res.domains })
      setChecks({ ...checks, [d.domain]: res.checks })
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy('')
  }
  const remove = async (d) => {
    try {
      const res = await del('/api/admin/domains/' + d.domain)
      setData({ ...data, domains: res.domains })
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  return (
    <>
      {own && (
        <div class="card" style={{ marginBottom: 18 }}>
          <div class="card-head">
            <h2>{own.domain}</h2>
            <span class="badge badge-ok">Email live</span>
            <span class="badge">Included</span>
          </div>
          <p class="muted" style={{ padding: '12px 16px' }}>Your organisation's own address on Open Suite. New people and groups get their addresses here unless you choose one of your own domains. It needs no setup and cannot be removed.</p>
        </div>
      )}
      <p class="muted" style={{ marginBottom: 14, maxWidth: 640 }}>
        Use your own domain for the suite's address, for email, or both. Add it here, publish the DNS records shown, then check. A domain works as soon as its records are live. Once email is live, two signing records (DKIM) are added to the list: publish those too so other providers trust your mail.
      </p>
      <form class="row" style={{ marginBottom: 18 }} onSubmit={add}>
        <input class="input" style={{ maxWidth: 320 }} placeholder="example.com" value={name} onInput={(e) => setName(e.target.value)} />
        <Button kind="primary" type="submit" icon={Globe} disabled={!name.trim()}>Add domain</Button>
        <span class="muted">{domains.length} of {data?.limits?.domains ?? '…'} on your plan</span>
      </form>
      {domains.length === 0 && <div class="card"><Empty icon={Globe} title="No custom domains" text={`Everyone signs in at ${boot.value.domain} with an @${own?.domain || boot.value.mailDomain} address until you add one.`} /></div>}
      {domains.map((d) => (
        <div class="card" style={{ marginBottom: 14 }} key={d.domain}>
          <div class="card-head">
            <h2>{d.domain}</h2>
            <span class={cx('badge', d.webOk ? 'badge-ok' : '')}>{d.webOk ? 'Web address live' : 'Web address not set'}</span>
            <span class={cx('badge', d.mailOk ? 'badge-ok' : '')}>{d.mailOk ? 'Email live' : 'Email not set'}</span>
            <Button icon={RefreshCw} busy={busy === d.domain} onClick={() => verify(d)}>Check DNS</Button>
            <IconButton icon={Trash2} label="Remove domain" onClick={() => remove(d)} />
          </div>
          {checks[d.domain] && (
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
              {checks[d.domain].map((c, i) => <div class="row" key={i} style={{ color: c.ok ? 'var(--ok)' : 'var(--muted)', padding: '2px 0' }}>{c.ok ? <Check size={15} /> : <XIcon size={15} />}{c.text}</div>)}
            </div>
          )}
          <table class="table">
            <thead><tr><th>Purpose</th><th>Type</th><th>Name</th><th>Value</th><th /></tr></thead>
            <tbody>
              {d.records.map((r, i) => (
                <tr key={i}>
                  <td>{r.purpose}</td>
                  <td><span class="badge">{r.type}</span></td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{r.name}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, maxWidth: 320 }}><div class="ellipsis" title={r.value}>{r.value}</div></td>
                  <td><IconButton icon={Copy} label="Copy value" onClick={async () => (await copyText(r.value)) && toast('Copied')} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

function Organisation({ data }) {
  const [name, setName] = useState(org.value.name)
  const save = async (e) => {
    e.preventDefault()
    try {
      await patch('/api/admin/org', { name })
      patchBoot({ org: { ...org.value, name: name.trim() } })
      toast('Saved')
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const lim = data?.limits
  const used = data?.usage?.storage || 0
  const pct = lim ? Math.min(100, (used / (lim.storageGB * 2 ** 30)) * 100) : 0
  return (
    <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <form class="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={save}>
        <h2>Organisation</h2>
        <Field label="Name"><input class="input" value={name} onInput={(e) => setName(e.target.value)} required /></Field>
        <div><Button kind="primary" type="submit" disabled={name.trim() === org.value.name}>Save</Button></div>
      </form>
      <div class="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div class="row"><h2 class="grow">Plan</h2><span class="badge badge-accent">{lim?.label || '…'}</span></div>
        <div class="row"><span class="grow">People</span><b>{(data?.people || people.value).length} / {lim?.maxUsers ?? '…'}</b></div>
        <div class="row"><span class="grow">Groups</span><b>{groups.value.length} /{lim?.maxGroups ?? '…'}</b></div>
        <div class="row"><span class="grow">Custom domains</span><b>{(data?.domains || []).filter((d) => !d.included).length} / {lim?.domains ?? '…'}</b></div>
        <div class="row"><span class="grow">Mail to other providers</span><b>{lim ? (lim.mailOutside ? 'Yes' : 'No, Open Suite addresses only') : '…'}</b></div>
        <div class="row"><span class="grow">Storage <span class="muted">· files {bytes(data?.usage?.files || 0)}, documents {bytes(Math.max(0, used - (data?.usage?.files || 0)))}</span></span><b>{bytes(used)} / {lim?.storageGB ?? '…'} GB</b></div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--sunken)', overflow: 'hidden' }}><div style={{ width: pct + '%', height: '100%', background: 'var(--accent)' }} /></div>
      </div>
    </div>
  )
}

function Operator() {
  const [orgs, setOrgs] = useState(null)
  const [resetting, setResetting] = useState(null) // the demo organisation, while asking
  const [busy, setBusy] = useState(false)
  const load = () => get('/api/operator/orgs').then(setOrgs).catch((e) => toast(e.message, 'error'))
  useEffect(() => { load() }, [])
  const setPlan = async (o, plan) => {
    await patch('/api/operator/orgs/' + o.id, { plan }).catch((e) => toast(e.message, 'error'))
    load()
  }
  const reset = async () => {
    setBusy(true)
    try {
      await post('/api/operator/demo-reset')
      toast(`${resetting.name} is back to its example content`)
      refreshBoot()
      load()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy(false)
    setResetting(null)
  }
  return (
    <div class="card">
      <table class="table">
        <thead><tr><th>Organisation</th><th>People</th><th>Documents</th><th>Created</th><th>Plan</th><th /></tr></thead>
        <tbody>
          {(orgs || []).map((o) => (
            <tr key={o.id}>
              <td><div style={{ fontWeight: 600 }}>{o.name} {o.demo && <span class="badge badge-accent">Demo</span>}</div>{o.domain && <div class="muted" style={{ fontSize: 12.5 }}>{o.domain}</div>}</td>
              <td>{o.users}</td>
              <td>{o.docs}</td>
              <td class="muted">{when(o.created * 1000)}</td>
              <td><select class="select" style={{ width: 110 }} value={o.plan} onChange={(e) => setPlan(o, e.target.value)}><option value="free">Free</option><option value="team">Team</option></select></td>
              <td style={{ textAlign: 'right' }}>{o.demo && <Button icon={RotateCcw} onClick={() => setResetting(o)}>Reset</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {resetting && (
        <Modal title={`Reset ${resetting.name}?`} onClose={() => !busy && setResetting(null)} footer={<><Button disabled={busy} onClick={() => setResetting(null)}>Cancel</Button><Button kind="danger" busy={busy} onClick={reset}>Reset now</Button></>}>
          <p>Everything its people have made is replaced by the example content: documents, files, mail, calendars, contacts, chats and meeting rooms. Anyone else added to it is removed. This happens every morning anyway.</p>
        </Modal>
      )}
    </div>
  )
}

export function Admin() {
  const tab = parts.value[1] || 'people'
  const [data, setData] = useState(null)
  const reload = () => {
    get('/api/admin/overview').then(setData).catch(() => {})
    refreshBoot()
  }
  useEffect(reload, [])
  const tabs = [['people', 'People'], ['groups', 'Groups'], ['domains', 'Domains'], ['organisation', 'Organisation'], user.value.operator && ['operator', 'All organisations']].filter(Boolean)
  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head"><h1>Admin</h1></div>
        <div class="tabs">{tabs.map(([k, label]) => <a key={k} href={'/admin/' + k} class={cx('tab', tab === k && 'on')}>{label}</a>)}</div>
        {tab === 'people' && <People data={data} reload={reload} />}
        {tab === 'groups' && <GroupsAdmin data={data} />}
        {tab === 'domains' && <Domains data={data} setData={setData} />}
        {tab === 'organisation' && <Organisation data={data} />}
        {tab === 'operator' && user.value.operator && <Operator />}
      </div>
    </div>
  )
}
