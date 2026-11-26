// Groups: creating them (organisation administrators) and managing their
// members (administrators, and each group's own admins). Used by Admin →
// Groups and by the group's entry in Mail.
import { useState } from 'preact/hooks'
import { Plus, Trash2, Users, Settings2, Mail as MailIcon } from 'lucide-preact'
import './groups.css'
import { boot, org, people, peopleById, toast } from '../lib/store.js'
import { groups, roleName, roleHelp, postingName, mayAppoint, createGroup, updateGroup, deleteGroup, setMember, removeMember } from '../lib/groups.js'
import { Avatar, Button, Empty, Field, IconButton, Modal } from '../ui.jsx'

function NewGroup({ domains, onClose, onCreated }) {
  const [f, setF] = useState({ name: '', username: '', domain: domains[0], description: '', posting: 'anyone' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const named = (e) => {
    const name = e.target.value
    const guess = name.trim().toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).join('-')
    setF({ ...f, name, username: f.touched ? f.username : guess })
  }
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { touched, ...body } = f
      onCreated(await createGroup(body))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return (
    <Modal title="New group" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={submit}>Create group</Button></>}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <p class="muted">A group is a shared inbox with its own address, like sales@ or orders@. Its members see its mail in Mail beside their own.</p>
        {error && <div class="form-error">{error}</div>}
        <Field label="Name" hint="Mail from the group is sent under this name."><input class="input" autofocus value={f.name} onInput={named} placeholder="Sales" required /></Field>
        <Field label="Address">
          <div class="input-group">
            <input class="input" autocapitalize="none" spellcheck={false} value={f.username} onInput={(e) => setF({ ...f, username: e.target.value, touched: true })} required />
            {domains.length > 1 ? (
              <select class="select" style={{ width: 'auto', borderRadius: '0 8px 8px 0', borderLeft: 0 }} value={f.domain} onChange={set('domain')}>{domains.map((d) => <option key={d} value={d}>@{d}</option>)}</select>
            ) : <span class="suffix">@{domains[0]}</span>}
          </div>
        </Field>
        <Field label="Description"><input class="input" value={f.description} onInput={set('description')} placeholder="Questions from customers about prices and orders" /></Field>
        <Field label="Who can send mail to it">
          <select class="select" value={f.posting} onChange={set('posting')}>
            {Object.entries(postingName(org.value.name)).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  )
}

// GroupSettings manages one group: its name and rules, and its members.
export function GroupSettings({ id, onClose }) {
  const g = groups.value.find((x) => x.id === id)
  const [f, setF] = useState(() => ({ name: g?.name || '', description: g?.description || '', posting: g?.posting || 'anyone' }))
  const [add, setAdd] = useState({ person: '', role: 'user' })
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState('')
  if (!g) return null
  const appoint = mayAppoint()
  const run = (what, fn, done) => async () => {
    setBusy(what)
    try {
      await fn()
      if (done) toast(done)
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }
  const changed = f.name.trim() !== g.name || f.description.trim() !== g.description || f.posting !== g.posting
  const members = new Set(g.members.map((m) => m.id))
  const candidates = people.value.filter((p) => p.status === 'active' && !members.has(p.id))
  const roles = appoint ? ['viewer', 'user', 'admin'] : ['viewer', 'user']
  if (confirm) {
    return (
      <Modal title={`Delete ${g.name}?`} onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button kind="danger" busy={busy === 'delete'} onClick={run('delete', async () => { await deleteGroup(g); onClose() }, `${g.name} was deleted`)}>Delete group</Button></>}>
        <p>Its mail is deleted with it, and {g.email} stops receiving mail.</p>
      </Modal>
    )
  }
  return (
    <Modal title={g.name} width={620} onClose={onClose} footer={<>{appoint && <Button kind="danger" icon={Trash2} onClick={() => setConfirm(true)}>Delete group</Button>}<span class="grow" /><Button kind="primary" onClick={onClose}>Done</Button></>}>
      <p class="muted" style={{ marginTop: -4 }}>{g.email}</p>
      <form class="gr-form" onSubmit={(e) => { e.preventDefault(); run('save', () => updateGroup(g, { name: f.name, description: f.description, posting: f.posting }), 'Saved')() }}>
        <Field label="Name"><input class="input" value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Description"><input class="input" value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Who can send mail to it">
          <select class="select" value={f.posting} onChange={(e) => setF({ ...f, posting: e.target.value })}>
            {Object.entries(postingName(org.value.name)).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        <div><Button kind="primary" type="submit" busy={busy === 'save'} disabled={!changed || !f.name.trim()}>Save</Button></div>
      </form>
      <h3 class="gr-head">Members <span class="muted">{g.members.length}</span></h3>
      <div class="gr-members">
        {g.members.length === 0 && <p class="muted">No members yet. Add the people who should read this group’s mail.</p>}
        {g.members.map((m) => {
          const p = peopleById.value[m.id]
          const locked = !appoint && m.role === 'admin'
          return (
            <div class="gr-member" key={m.id}>
              <Avatar name={p?.name} id={m.id} size={30} />
              <div class="grow" style={{ minWidth: 0 }}>
                <div class="ellipsis" style={{ fontWeight: 600 }}>{p?.name}{p?.agent && <span class="badge" style={{ marginLeft: 6 }}>Agent</span>}</div>
                <div class="muted ellipsis" style={{ fontSize: 12.5 }}>{p?.email}</div>
              </div>
              {locked ? <span class="badge badge-accent">{roleName.admin}</span> : (
                <select class="select" style={{ width: 150 }} aria-label={'Role of ' + p?.name} value={m.role} disabled={!!busy}
                  onChange={(e) => run('role', () => setMember(g, m.id, e.target.value), 'Role changed')()}>
                  {roles.map((r) => <option key={r} value={r} title={roleHelp[r]}>{roleName[r]}</option>)}
                </select>
              )}
              {!locked && <IconButton icon={Trash2} label={'Remove ' + p?.name} disabled={!!busy} onClick={run('remove', () => removeMember(g, m.id), `${p?.name} was removed`)} />}
            </div>
          )
        })}
      </div>
      {candidates.length > 0 && (
        <form class="row gr-add" onSubmit={(e) => { e.preventDefault(); add.person && run('add', async () => { await setMember(g, add.person, add.role); setAdd({ ...add, person: '' }) }, 'Member added')() }}>
          <select class="select grow" aria-label="Person to add" value={add.person} onChange={(e) => setAdd({ ...add, person: e.target.value })}>
            <option value="">Add someone…</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.email}</option>)}
          </select>
          <select class="select" style={{ width: 150 }} aria-label="Their role" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
            {roles.map((r) => <option key={r} value={r}>{roleName[r]}</option>)}
          </select>
          <Button type="submit" icon={Plus} busy={busy === 'add'} disabled={!add.person}>Add</Button>
        </form>
      )}
      <p class="muted gr-roles">{['viewer', 'user', 'admin'].map((r) => `${roleName[r]}: ${roleHelp[r].toLowerCase()}.`).join(' ')}</p>
    </Modal>
  )
}

// GroupsAdmin is Admin → Groups.
export function GroupsAdmin({ data }) {
  const [dialog, setDialog] = useState(null)
  const list = groups.value
  const mailDomains = boot.value.org?.mailDomains || [boot.value.mailDomain]
  return (
    <>
      <div class="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <span class="grow muted" style={{ minWidth: 180 }}>{list.filter((g) => !g.example).length} of {data?.limits?.maxGroups ?? '…'} groups on the {data?.limits?.label || ''} plan{list.some((g) => g.example) ? ', not counting the example group' : ''}</span>
        <Button kind="primary" icon={Plus} onClick={() => setDialog({ type: 'new' })}>New group</Button>
      </div>
      {list.length === 0 ? (
        <div class="card"><Empty icon={Users} title="No groups yet" text="A group is a shared inbox such as sales@ or orders@: anyone can write to it, and its members answer from it." /></div>
      ) : (
        <div class="card">
          <table class="table">
            <thead><tr><th>Group</th><th>Members</th><th>Who can write</th><th /></tr></thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div class="row" style={{ gap: 12 }}>
                      <span class="gr-icon"><MailIcon size={16} /></span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{g.name}</div>
                        <div class="muted ellipsis" style={{ fontSize: 12.5 }}>{g.email}</div>
                      </div>
                    </div>
                  </td>
                  <td class="muted">{g.members.length}</td>
                  <td class="muted">{{ anyone: 'Anyone', organisation: 'Organisation', members: 'Members' }[g.posting]}</td>
                  <td style={{ textAlign: 'right' }}><IconButton icon={Settings2} label={'Manage ' + g.name} onClick={() => setDialog({ type: 'manage', id: g.id })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog?.type === 'new' && <NewGroup domains={mailDomains} onClose={() => setDialog(null)} onCreated={(g) => setDialog({ type: 'manage', id: g.id })} />}
      {dialog?.type === 'manage' && <GroupSettings id={dialog.id} onClose={() => setDialog(null)} />}
    </>
  )
}
