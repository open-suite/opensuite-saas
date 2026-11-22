// Contacts: the person's own address book beside the organisation's people.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ArrowLeft, Building2, Download, Mail as MailIcon, MapPin, MoreHorizontal, Pencil, Phone, Plus, Search, StickyNote, Trash2, Upload, Users, X } from 'lucide-preact'
import './contacts.css'
import { people, org, user, toast } from '../lib/store.js'
import { query, navigate } from '../lib/router.js'
import { cx, download, pickFile } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu } from '../ui.jsx'
import { cards, contactsReady, nameOf, emailsOf, phonesOf, companyOf, titleOf, toForm, fromForm, saveContact, deleteContact, importContacts, toVCard } from '../lib/contacts.js'

const LIMIT = 400
const blank = () => ({ given: '', surname: '', company: '', title: '', emails: [{ value: '', label: '' }], phones: [{ value: '', label: 'mobile' }], address: '', notes: '' })
const writeTo = (email) => navigate('/mail?compose=1&to=' + encodeURIComponent(email))

function Rows({ label, items, value, onChange, kinds, type, placeholder }) {
  const set = (i, patch) => onChange(value.map((x, n) => (n === i ? { ...x, ...patch } : x)))
  return (
    <div class="ct-field">
      <span class="field-label">{label}</span>
      {value.map((x, i) => (
        <div class="row" key={i}>
          <input class="input" type={type} placeholder={placeholder} value={x.value} onInput={(e) => set(i, { value: e.target.value })} aria-label={label} />
          <select class="select" style={{ width: 110 }} value={x.label} onChange={(e) => set(i, { label: e.target.value })} aria-label={label + ' kind'}>
            {kinds.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <IconButton icon={X} label={'Remove ' + items} onClick={() => onChange(value.filter((_, n) => n !== i))} />
        </div>
      ))}
      <button type="button" class="ct-add" onClick={() => onChange([...value, { value: '', label: kinds[0][0] }])}><Plus size={14} />Add {items}</button>
    </div>
  )
}

function Editor({ card, onDone }) {
  const [f, setF] = useState(() => {
    const form = card ? toForm(card) : blank()
    return { ...form, emails: form.emails.length ? form.emails : [{ value: '', label: '' }], phones: form.phones.length ? form.phones : [{ value: '', label: 'mobile' }] }
  })
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const first = useRef()
  useLayoutEffect(() => first.current?.focus(), [])
  const save = (e) => {
    e?.preventDefault()
    const bad = f.emails.find((x) => x.value.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.value.trim()))
    if (bad) return toast(`"${bad.value}" is not an email address.`, 'error')
    if (!f.given.trim() && !f.surname.trim() && !f.company.trim() && !f.emails.some((x) => x.value.trim())) return toast('Add a name, a company or an email address.', 'error')
    const { card: saved, done } = saveContact(fromForm(f), card || undefined)
    onDone(saved, done)
  }
  return (
    <form class="ct-edit" onSubmit={save}>
      <div class="ct-bar">
        <h2 class="grow">{card ? 'Edit contact' : 'New contact'}</h2>
        <Button onClick={() => onDone(card || null)}>Cancel</Button>
        <Button kind="primary" type="submit">Save</Button>
      </div>
      <div class="ct-form">
        <div class="two">
          <label class="field"><span class="field-label">First name</span><input ref={first} class="input" value={f.given} onInput={on('given')} autocomplete="off" /></label>
          <label class="field"><span class="field-label">Last name</span><input class="input" value={f.surname} onInput={on('surname')} autocomplete="off" /></label>
        </div>
        <div class="two">
          <label class="field"><span class="field-label">Company</span><input class="input" value={f.company} onInput={on('company')} autocomplete="off" /></label>
          <label class="field"><span class="field-label">Job title</span><input class="input" value={f.title} onInput={on('title')} autocomplete="off" /></label>
        </div>
        <Rows label="Email" items="email" type="email" placeholder="name@example.com" value={f.emails} onChange={(emails) => setF({ ...f, emails })} kinds={[['', 'Email'], ['work', 'Work'], ['home', 'Home']]} />
        <Rows label="Phone" items="phone" type="tel" placeholder="+31 6 1234 5678" value={f.phones} onChange={(phones) => setF({ ...f, phones })} kinds={[['mobile', 'Mobile'], ['work', 'Work'], ['home', 'Home'], ['', 'Other']]} />
        <label class="field"><span class="field-label">Address</span><textarea class="textarea" rows="2" value={f.address} onInput={on('address')} /></label>
        <label class="field"><span class="field-label">Notes</span><textarea class="textarea" rows="3" value={f.notes} onInput={on('notes')} /></label>
      </div>
    </form>
  )
}

function Line({ icon: Icon, children }) {
  return <div class="ct-line"><Icon size={17} /><div class="grow">{children}</div></div>
}

function Detail({ sel, onEdit, onBack, onGone }) {
  const mine = sel.kind === 'card'
  const c = sel.item
  const name = mine ? nameOf(c) : c.name
  const emails = mine ? emailsOf(c) : [c.email]
  const f = mine ? toForm(c) : null
  const sub = mine ? [titleOf(c), companyOf(c)].filter(Boolean).join(' · ') : org.value?.name
  const remove = () => {
    deleteContact(c)
    toast('Contact deleted')
    onGone()
  }
  return (
    <div class="ct-detail">
      <div class="ct-bar">
        <IconButton icon={ArrowLeft} label="Back to list" class="only-narrow" onClick={onBack} />
        <span class="grow" />
        {emails[0] && <Button icon={MailIcon} onClick={() => writeTo(emails[0])}>Write an email</Button>}
        {mine && <IconButton icon={Pencil} label="Edit" onClick={onEdit} />}
        {mine && <IconButton icon={Trash2} label="Delete" onClick={remove} />}
      </div>
      <div class="ct-body">
        <div class="ct-hero">
          <Avatar name={name} id={mine ? c.id : c.id} size={72} />
          <div style={{ minWidth: 0 }}>
            <h1>{name}</h1>
            {sub && <p class="muted">{sub}</p>}
            {!mine && <span class="badge badge-accent" style={{ marginTop: 6 }}>In your organisation{c.id === user.value.id ? ' · you' : ''}</span>}
          </div>
        </div>
        {emails.length > 0 && <Line icon={MailIcon}>{emails.map((e, i) => <div key={e}><a href={'/mail?compose=1&to=' + encodeURIComponent(e)}>{e}</a>{f?.emails[i]?.label && <span class="muted"> · {f.emails[i].label}</span>}</div>)}</Line>}
        {mine && f.phones.length > 0 && <Line icon={Phone}>{f.phones.map((p) => <div key={p.value}><a href={'tel:' + p.value.replace(/[^+\d]/g, '')}>{p.value}</a>{p.label && <span class="muted"> · {p.label}</span>}</div>)}</Line>}
        {mine && companyOf(c) && <Line icon={Building2}>{companyOf(c)}{titleOf(c) && <div class="muted">{titleOf(c)}</div>}</Line>}
        {mine && f.address && <Line icon={MapPin}><span style={{ whiteSpace: 'pre-wrap' }}>{f.address}</span></Line>}
        {mine && f.notes && <Line icon={StickyNote}><span style={{ whiteSpace: 'pre-wrap' }}>{f.notes}</span></Line>}
        {!mine && <Line icon={Users}>{c.role === 'owner' ? 'Owner' : c.role === 'admin' ? 'Administrator' : 'Member'} of {org.value?.name}</Line>}
      </div>
    </div>
  )
}

export default function Contacts() {
  const list = cards.value
  const folks = people.value
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null) // { kind: 'card' | 'person', id }
  const [editing, setEditing] = useState(null) // null | 'new' | card
  const [more, setMore] = useState(false)
  const s = q.trim().toLowerCase()
  const mine = useMemo(() => (s ? list.filter((c) => (nameOf(c) + ' ' + emailsOf(c).join(' ') + ' ' + companyOf(c) + ' ' + phonesOf(c).join(' ')).toLowerCase().includes(s)) : list), [list, s])
  const theirs = useMemo(() => folks.filter((p) => p.status !== 'suspended' && (!s || (p.name + ' ' + p.email).toLowerCase().includes(s))), [folks, s])
  const current = sel && (sel.kind === 'card' ? list.find((c) => c.id === sel.id) : folks.find((p) => p.id === sel.id))

  // A link from search names the contact to show.
  useEffect(() => {
    const open = new URLSearchParams(query.value).get('open')
    if (!open) return
    setSel({ kind: 'card', id: open })
    setEditing(null)
    navigate('/contacts', { replace: true })
  }, [query.value])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'c') { e.preventDefault(); setEditing('new') }
      else if (e.key === '/') { e.preventDefault(); document.querySelector('.ct-search input')?.focus() }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const doImport = async () => {
    const file = await pickFile('.vcf,text/vcard,text/x-vcard')
    if (!file) return
    try {
      const n = await importContacts(await file.text())
      toast(n ? `${n} contact${n === 1 ? '' : 's'} imported` : 'No new contacts in that file')
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  const doExport = () => download(new Blob([toVCard(list)], { type: 'text/vcard' }), 'contacts.vcf')
  const row = (kind, id, name, sub) => (
    <button key={kind + id} class={cx('ct-row', sel?.kind === kind && sel.id === id && !editing && 'on')} onClick={() => { setSel({ kind, id }); setEditing(null) }}>
      <Avatar name={name} id={id} size={34} />
      <span class="grow" style={{ minWidth: 0 }}><div class="ellipsis name">{name}</div><div class="ellipsis sub">{sub}</div></span>
    </button>
  )
  const shown = more ? mine : mine.slice(0, LIMIT)
  return (
    <div class={cx('ct', (current || editing) && 'reading')}>
      <section class="ct-list" aria-label="Contacts">
        <div class="ct-top">
          <div class="ct-search"><Search size={15} /><input class="input" type="search" placeholder="Search contacts" value={q} onInput={(e) => setQ(e.target.value)} /></div>
          <Button kind="primary" icon={Plus} onClick={() => setEditing('new')}>New</Button>
          <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" />} items={[
            { label: 'Import from a file', icon: Upload, onSelect: doImport },
            { label: 'Export all', icon: Download, onSelect: doExport, disabled: !list.length },
          ]} />
        </div>
        <div class="ct-rows">
          <div class="ct-head">My contacts<span>{mine.length}</span></div>
          {mine.length === 0 && (
            <div class="ct-none">{s ? 'No contacts match.' : contactsReady.value ? 'People you add appear here and complete as you type an address.' : ''}</div>
          )}
          {shown.map((c) => row('card', c.id, nameOf(c), emailsOf(c)[0] || companyOf(c) || phonesOf(c)[0] || ''))}
          {mine.length > shown.length && <div class="more-row"><Button onClick={() => setMore(true)}>Show all {mine.length}</Button></div>}
          <div class="ct-head">{org.value?.name}<span>{theirs.length}</span></div>
          {theirs.map((p) => row('person', p.id, p.name, p.email))}
        </div>
      </section>
      <section class="ct-pane">
        {editing ? (
          <Editor key={editing === 'new' ? 'new' : editing.id} card={editing === 'new' ? null : editing} onDone={(saved, done) => {
            setEditing(null)
            if (!saved) return
            setSel({ kind: 'card', id: saved.id })
            // A new contact gets its lasting id once the server has it.
            done?.then((id) => id && setSel((cur) => (cur?.id === saved.id ? { kind: 'card', id } : cur)))
          }} />
        ) : current ? (
          <Detail sel={{ kind: sel.kind, item: current }} onEdit={() => setEditing(current)} onBack={() => setSel(null)} onGone={() => setSel(null)} />
        ) : (
          <Empty icon={Users} title="Select a contact" text="Press c to add someone, / to search." />
        )}
      </section>
    </div>
  )
}
