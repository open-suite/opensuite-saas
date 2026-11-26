import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Inbox, Send, FileEdit, Archive, Trash2, ShieldAlert, Folder, PenSquare, Search, Reply, ReplyAll, Forward, Star,
  MailOpen, Paperclip, X, ArrowLeft, Image as ImageIcon, Bold, Italic, List, Mail as MailIcon, FolderDown, FolderOpen,
  Users, Settings2, Eye, CornerUpLeft,
} from 'lucide-preact'
import { saveAttachment, attachFile, pickFromFiles } from '../lib/files.js'
import './mail.css'
import './groups.css'
import { toast, boot, user, peopleById } from '../lib/store.js'
import { query, navigate } from '../lib/router.js'
import { own, boxFor, myGroups, mailReady, listKey, readMark, replyMark, groupQuery } from '../lib/mail.js'
import { mayManage } from '../lib/groups.js'
import { cx, when, whenFull, bytes, escapeHtml, debounce } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu } from '../ui.jsx'
import { Invitation, notCalendar } from './agenda.jsx'
import { GroupSettings } from './groups.jsx'
import { addressBook } from '../lib/contacts.js'

const folderIcon = { inbox: Inbox, sent: Send, drafts: FileEdit, archive: Archive, trash: Trash2, junk: ShieldAlert }
const folderName = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash', junk: 'Spam' }
const label = (m) => folderName[m.role] || m.name
const person = (a) => a?.name || a?.email || ''
const addrList = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
const blobURL = (a, group, extra = '') => `/api/mail/blob/${a.blobId}/${encodeURIComponent(a.name || 'attachment')}?type=${encodeURIComponent(a.type)}${extra}${groupQuery(group, '&')}`

function parseAddrs(text) {
  const out = []
  for (const raw of text.split(/[,;]/)) {
    const s = raw.trim()
    if (!s) continue
    const m = s.match(/^(.*)<([^>]+)>$/)
    const email = (m ? m[2] : s).trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${s}" is not an email address.`)
    out.push(m && m[1].trim() ? { name: m[1].trim().replace(/^"|"$/g, ''), email } : { email })
  }
  return out
}

// --- reading -------------------------------------------------------------

// buildFrame turns a message into a self-contained page for a script-less
// frame: active content is removed, inline images are wired to their
// attachments, and remote images load only when the reader asks.
function buildFrame(email, showRemote, group) {
  const part = email.htmlBody?.[0]
  const html = part && email.bodyValues?.[part.partId]?.value
  let body
  let blocked = 0
  if (html && part.type === 'text/html') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script,iframe,object,embed,form,base,meta,link,frame,frameset,noscript').forEach((n) => n.remove())
    const cids = Object.fromEntries((email.attachments || []).filter((a) => a.cid).map((a) => [a.cid, a]))
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on') || (/^(href|src|action|background)$/.test(attr.name) && /^\s*(javascript|vbscript):/i.test(attr.value))) el.removeAttribute(attr.name)
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || ''
        if (src.startsWith('cid:')) {
          const a = cids[src.slice(4)]
          if (a) el.setAttribute('src', blobURL({ ...a, name: a.name || 'image' }, group))
        } else if (/^https?:/i.test(src) && !showRemote) {
          el.removeAttribute('src')
          el.removeAttribute('srcset')
          blocked++
        }
      }
    }
    body = doc.body.innerHTML
  } else {
    const tp = email.textBody?.[0]
    const text = (tp && email.bodyValues?.[tp.partId]?.value) || email.preview || ''
    body = '<div style="white-space:pre-wrap;word-break:break-word">' + escapeHtml(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>') + '</div>'
  }
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src 'self' data:${showRemote ? ' https: http:' : ''}`
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html{color-scheme:light}body{margin:0;padding:12px 4px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#102033;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#1269e8}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #cbd5e0;color:#617385}table{max-width:100%}pre{white-space:pre-wrap}</style>
</head><body>${body}</body></html>`
  return { page, blocked }
}

function MessageBody({ email, group }) {
  const [remote, setRemote] = useState(false)
  const ref = useRef()
  const { page, blocked } = useMemo(() => buildFrame(email, remote, group), [email.id, !!email.bodyValues, remote])
  const fit = () => {
    const f = ref.current
    const d = f?.contentDocument
    if (d?.documentElement) f.style.height = Math.max(40, d.documentElement.scrollHeight) + 'px'
  }
  useEffect(() => {
    const f = ref.current
    if (!f) return
    const onLoad = () => {
      fit()
      const ro = new ResizeObserver(fit)
      if (f.contentDocument?.body) ro.observe(f.contentDocument.body)
      f._ro = ro
    }
    f.addEventListener('load', onLoad)
    return () => {
      f.removeEventListener('load', onLoad)
      f._ro?.disconnect()
    }
  }, [page])
  return (
    <>
      {blocked > 0 && (
        <div class="msg-note">
          <ImageIcon size={15} />
          <span class="grow">Remote images are hidden to protect your privacy.</span>
          <Button class="btn-ghost" onClick={() => setRemote(true)}>Show images</Button>
        </div>
      )}
      <div class="msg-body">
        <iframe ref={ref} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc={page} />
      </div>
    </>
  )
}

function Message({ email, open, onToggle, group }) {
  const from = email.from?.[0]
  const files = (email.attachments || []).filter((a) => !(a.cid && a.disposition === 'inline')).filter(notCalendar)
  return (
    <article class="msg">
      <div class={cx('msg-head', 'fold')} onClick={onToggle}>
        <Avatar name={person(from)} email={from?.email} size={34} />
        <div class="meta">
          <div class="from ellipsis">{person(from)} {from?.name && <span class="muted" style={{ fontWeight: 400 }}>&lt;{from.email}&gt;</span>}</div>
          <div class="to ellipsis">{open ? 'to ' + addrList([...(email.to || []), ...(email.cc || [])]) : email.preview}</div>
        </div>
        <div class="date" title={whenFull(new Date(email.receivedAt).getTime())}>{when(new Date(email.receivedAt).getTime())}</div>
      </div>
      {open && !group && <Invitation email={email} />}
      {open && (email.bodyValues ? <MessageBody email={email} group={group} /> : <div class="msg-body muted">{email.preview}</div>)}
      {open && files.length > 0 && (
        <div class="atts">
          {files.map((a) => (
            <span class="row" style={{ gap: 2 }} key={a.blobId}>
              <a class="att" href={blobURL(a, group, '&dl=1')} download={a.name}>
                <Paperclip size={14} /><span class="ellipsis">{a.name || 'attachment'}</span><span class="muted">{bytes(a.size || 0)}</span>
              </a>
              <IconButton icon={FolderDown} label="Save to Files" onClick={() => saveAttachment(a, group).then((n) => toast(`Saved "${n.name}" to Files`), (e) => toast(e.message, 'error'))} />
            </span>
          ))}
        </div>
      )}
    </article>
  )
}

// Activity says who in a group has read a conversation and who answered it,
// from the marks members leave on its messages.
function Activity({ thread }) {
  const me = user.value.id
  const ids = (prefix) => [...new Set(thread.flatMap((e) => Object.keys(e.keywords || {}).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))))]
  const names = (list) => list.map((id) => (id === me ? 'you' : peopleById.value[id]?.name)).filter(Boolean).join(', ')
  const read = names(ids(readMark('')))
  const answered = names(ids(replyMark('')))
  if (!read && !answered) return null
  return (
    <div class="gr-activity">
      {read && <span><Eye size={14} />Read by {read}</span>}
      {answered && <span><CornerUpLeft size={14} />Answered by {answered}</span>}
    </div>
  )
}

// --- composing -----------------------------------------------------------

const DRAFT = 'os:draft'
const saveDraft = debounce((d) => {
  try {
    localStorage.setItem(DRAFT, JSON.stringify(d))
  } catch {}
}, 400)

// The mailboxes a person may send from: their own, and the groups where they
// are a user or a group admin.
const senders = () => [own, ...myGroups.value.filter((g) => g.role !== 'viewer').map(boxFor)]

function Compose({ init, onClose }) {
  const [f, setF] = useState(init)
  const [showCc, setShowCc] = useState(!!(init.cc || init.bcc))
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const body = useRef()
  const fileInput = useRef()
  const from = senders().find((b) => (b.group?.id || '') === (f.from || '')) || own
  useEffect(() => {
    body.current.innerHTML = init.html || ''
    if (init.to) body.current.focus()
  }, [])
  const set = (k) => (e) => {
    const next = { ...f, [k]: e.target.value }
    setF(next)
    saveDraft({ ...next, html: body.current.innerHTML })
  }
  const close = (discard) => {
    if (discard) localStorage.removeItem(DRAFT)
    onClose()
  }
  // Attachments live in the mailbox the message is sent from; each keeps
  // where it came from, so it can follow a change of sender.
  const upload = async (source, box) => {
    const tmp = { name: source.file?.name || source.node.name, size: source.file?.size ?? source.node.size, uploading: true, source }
    setFiles((x) => [...x, tmp])
    try {
      const up = source.file ? await box.uploadAttachment(source.file) : await attachFile(source.node, box.group)
      setFiles((x) => x.map((y) => (y === tmp ? { ...up, source } : y)))
    } catch (e) {
      setFiles((x) => x.filter((y) => y !== tmp))
      toast(e.message, 'error')
    }
  }
  const attach = (list) => [...list].forEach((file) => upload({ file }, from))
  const attachFromFiles = async () => {
    const node = await pickFromFiles({ title: 'Attach from Files', action: 'Attach' })
    if (node) upload({ node }, from)
  }
  const changeFrom = (e) => {
    const next = { ...f, from: e.target.value }
    setF(next)
    saveDraft({ ...next, html: body.current.innerHTML })
    const box = senders().find((b) => (b.group?.id || '') === next.from) || own
    const again = files.map((a) => a.source)
    setFiles([])
    again.forEach((source) => upload(source, box))
  }
  const submit = async () => {
    let to, cc, bcc
    try {
      to = parseAddrs(f.to)
      cc = parseAddrs(f.cc || '')
      bcc = parseAddrs(f.bcc || '')
    } catch (e) {
      return toast(e.message, 'error')
    }
    if (!to.length && !cc.length && !bcc.length) return toast('Add at least one recipient.', 'error')
    if (files.some((x) => x.uploading)) return toast('Wait for attachments to finish uploading.', 'error')
    setBusy(true)
    try {
      const html = body.current.innerHTML
      // Only a reply sent from the group it came to marks who answered it.
      const answers = from.group && from.group.id === init.from ? init.answers : undefined
      await from.send({ to, cc, bcc, subject: f.subject, html: `<div>${html}</div>`, text: body.current.innerText, attachments: files, inReplyTo: f.inReplyTo, references: f.references, answers })
      toast('Sent')
      close(true)
    } catch (e) {
      toast(e.message, 'error')
      setBusy(false)
    }
  }
  const cmd = (c) => () => {
    body.current.focus()
    document.execCommand(c)
  }
  const choices = senders()
  return (
    <div class="compose" role="dialog" aria-label="New message" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submit()}>
      <header><span class="grow">{f.subject || 'New message'}</span><IconButton icon={X} label="Save and close" onClick={() => close(false)} /></header>
      {choices.length > 1 && (
        <div class="line">
          <label for="c-from">From</label>
          <select id="c-from" class="gr-from" value={from.group?.id || ''} onChange={changeFrom}>
            {choices.map((b) => <option key={b.group?.id || ''} value={b.group?.id || ''}>{b.group ? `${b.group.name} <${b.group.email}>` : `${user.value.name} <${b.address()}>`}</option>)}
          </select>
        </div>
      )}
      <div class="line">
        <label for="c-to">To</label>
        <input id="c-to" list="c-people" autofocus={!init.to} value={f.to} onInput={set('to')} autocomplete="off" />
        {!showCc && <button onClick={() => setShowCc(true)}>Cc Bcc</button>}
      </div>
      {showCc && <div class="line"><label for="c-cc">Cc</label><input id="c-cc" list="c-people" value={f.cc} onInput={set('cc')} autocomplete="off" /></div>}
      {showCc && <div class="line"><label for="c-bcc">Bcc</label><input id="c-bcc" list="c-people" value={f.bcc} onInput={set('bcc')} autocomplete="off" /></div>}
      <div class="line"><label for="c-subj">Subject</label><input id="c-subj" value={f.subject} onInput={set('subject')} /></div>
      <datalist id="c-people">{addressBook.value.map((a) => <option key={a.email} value={a.name ? `${a.name} <${a.email}>` : a.email} />)}</datalist>
      <div class="compose-body" ref={body} contentEditable role="textbox" aria-multiline="true" aria-label="Message"
        onInput={() => saveDraft({ ...f, html: body.current.innerHTML })}
        onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(e.dataTransfer.files) } }} />
      {files.length > 0 && (
        <div class="atts" style={{ paddingTop: 10 }}>
          {files.map((a, i) => (
            <span class="att" key={i}>
              <Paperclip size={14} /><span class="ellipsis">{a.name}</span><span class="muted">{a.uploading ? 'Uploading' : bytes(a.size)}</span>
              <button class="x" aria-label="Remove" onClick={() => setFiles(files.filter((x) => x !== a))}><X size={14} /></button>
            </span>
          ))}
        </div>
      )}
      <footer>
        <Button kind="primary" icon={Send} busy={busy} onClick={submit}>Send</Button>
        <IconButton icon={Bold} label="Bold" onClick={cmd('bold')} />
        <IconButton icon={Italic} label="Italic" onClick={cmd('italic')} />
        <IconButton icon={List} label="Bulleted list" onClick={cmd('insertUnorderedList')} />
        <IconButton icon={Paperclip} label="Attach files" onClick={() => fileInput.current.click()} />
        <IconButton icon={FolderOpen} label="Attach from Files" onClick={attachFromFiles} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = '' }} />
        <span class="grow" />
        <IconButton icon={Trash2} label="Discard" onClick={() => close(true)} />
      </footer>
    </div>
  )
}

function quote(email) {
  const part = email.htmlBody?.[0]
  const html = part && email.bodyValues?.[part.partId]?.value
  const tp = email.textBody?.[0]
  const text = tp && email.bodyValues?.[tp.partId]?.value
  let inner = html ? new DOMParser().parseFromString(html, 'text/html').body.innerHTML : escapeHtml(text || '').replace(/\n/g, '<br>')
  // Quoted mail is inert content inside our own page: strip anything active.
  const doc = new DOMParser().parseFromString(inner, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta,img').forEach((n) => n.remove())
  doc.querySelectorAll('*').forEach((el) => [...el.attributes].forEach((a) => (a.name.startsWith('on') || a.name === 'style' || /^\s*javascript:/i.test(a.value)) && el.removeAttribute(a.name)))
  inner = doc.body.innerHTML
  return `<br><br><div>On ${whenFull(new Date(email.receivedAt).getTime())}, ${escapeHtml(person(email.from?.[0]))} wrote:</div><blockquote>${inner}</blockquote>`
}

const blank = (from = '') => ({ from, to: '', cc: '', bcc: '', subject: '', html: '' })

// draftFor starts a reply or a forward. A reply to a group's mail is sent as
// the group; a forward from a group someone only views goes from their own
// address.
function draftFor(mode, email, box) {
  const from = box.maySend() ? box.group?.id || '' : ''
  const me = box.address()
  const re = (p, s = '') => (new RegExp('^' + p + ':', 'i').test(s) ? s : `${p}: ${s}`)
  const refs = [...(email.references || []), ...(email.messageId || [])]
  if (mode === 'forward') return { ...blank(from), subject: re('Fwd', email.subject), html: quote(email) }
  const replyTo = email.replyTo?.length ? email.replyTo : email.from || []
  const all = mode === 'all' ? [...(email.to || []), ...(email.cc || [])].filter((a) => a.email !== me && !replyTo.find((r) => r.email === a.email)) : []
  return { ...blank(from), to: addrList(replyTo), cc: addrList(all), subject: re('Re', email.subject), html: quote(email), inReplyTo: email.messageId, references: refs, answers: email.id }
}

// --- the mail screen -----------------------------------------------------

export function Mail() {
  const params = new URLSearchParams(query.value)
  const [groupId, setGroupId] = useState('')
  const group = myGroups.value.find((g) => g.id === groupId) || null
  const box = boxFor(group)
  const inbox = box.byRole('inbox')
  const [boxId, setBoxId] = useState(null)
  const [search, setSearch] = useState('')
  const [typed, setTyped] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])
  const [openId, setOpenId] = useState(params.get('open'))
  const [expanded, setExpanded] = useState({})
  const [compose, setCompose] = useState(null)
  const [settings, setSettings] = useState(null) // the group whose settings are open
  const current = boxId || inbox?.id
  const key = listKey(current, search)
  const list = box.lists.value[key]
  const folder = box.mailboxes.value.find((m) => m.id === current)
  const writer = box.maySend()

  useEffect(() => {
    if (params.get('compose')) {
      let saved = null
      try {
        saved = JSON.parse(localStorage.getItem(DRAFT))
      } catch {}
      // A link that names the recipient (from search or Contacts) starts a fresh message.
      setCompose(params.get('to') ? { ...blank(), to: params.get('to') } : saved || blank())
      navigate('/mail', { replace: true })
    } else if (params.get('open')) {
      setGroupId('')
      setOpenId(params.get('open'))
      navigate('/mail', { replace: true })
    }
  }, [query.value])

  useEffect(() => {
    if (current) box.loadList(current, { search }).catch(() => {})
  }, [box, current, search])

  const rows = (list?.ids || []).map((id) => box.emails.value[id]).filter(Boolean)
  const threadIds = openId ? box.threads.value[openId] || [] : []
  const thread = threadIds.map((id) => box.emails.value[id]).filter(Boolean)
  const last = thread[thread.length - 1]

  useEffect(() => {
    if (!openId) return
    box.loadThread(openId).catch((e) => toast(e.message, 'error'))
  }, [box, openId])

  useEffect(() => {
    // Opening a conversation marks it read; in a group, as read by me.
    const mark = readMark(user.value.id)
    const unseen = thread.filter((e) => !e.keywords?.$draft && (!e.keywords?.$seen || (group && !e.keywords?.[mark]))).map((e) => e.id)
    if (unseen.length) box.markRead(unseen).catch(() => {})
  }, [box, openId, thread.length])

  const choose = (g, folderId = null) => {
    setGroupId(g?.id || '')
    setBoxId(folderId)
    setTyped('')
    setSearch('')
    setOpenId(null)
  }
  const open = (e) => {
    setOpenId(e.threadId)
    setExpanded({})
  }
  const step = (d) => {
    const i = rows.findIndex((e) => e.threadId === openId)
    const next = rows[i + d]
    if (next) open(next)
    else setOpenId(null)
  }
  const fileAway = async (role, name) => {
    const ids = [...threadIds]
    const dest = await box.ensureMailbox(role, name)
    step(1)
    box.moveTo(ids, dest).catch((e) => toast(e.message, 'error'))
  }
  const remove = () => {
    if (folder?.role === 'trash') {
      const ids = [...threadIds]
      step(1)
      box.destroy(ids).catch((e) => toast(e.message, 'error'))
    } else fileAway('trash', 'Trash')
  }
  const startCompose = (init) => setCompose(init || blank(writer ? group?.id || '' : ''))

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'c') { e.preventDefault(); startCompose() }
      else if (e.key === 'j') openId ? step(1) : rows[0] && open(rows[0])
      else if (e.key === 'k') openId && step(-1)
      else if (!last || !writer) return
      else if (e.key === 'e') fileAway('archive', 'Archive')
      else if (e.key === '#') remove()
      else if (e.key === 'r') { e.preventDefault(); startCompose(draftFor('reply', last, box)) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (!boot.value?.mail?.ready && !mailReady.value) {
    return <div class="page"><Empty icon={MailIcon} title="Your mailbox is being prepared" text="This takes a few seconds the first time. It will appear here on its own." /></div>
  }

  const folders = (b, list, sub) => list.map((m) => {
    const Icon = folderIcon[m.role] || Folder
    const n = m.role === 'drafts' ? m.totalEmails : m.unreadEmails
    return (
      <button key={m.id} class={cx('folder', sub && 'gr-sub', b === box && current === m.id && !search && 'on')} onClick={() => choose(b.group, m.id)} title={label(m)}>
        <Icon size={sub ? 15 : 17} /><span class="label">{label(m)}</span>{n > 0 && <span class="n">{n}</span>}
      </button>
    )
  })
  const sentView = folder?.role === 'sent' || folder?.role === 'drafts'
  return (
    <div class={cx('mail', openId && 'reading')}>
      <aside class="mail-side">
        <Button kind="primary" icon={PenSquare} onClick={() => startCompose()}><span>Compose</span></Button>
        {folders(own, own.mailboxes.value, false)}
        {myGroups.value.length > 0 && <div class="gr-side">Groups</div>}
        {myGroups.value.map((g) => {
          const gb = boxFor(g)
          const n = gb.byRole('inbox')?.unreadEmails || 0
          return (
            <div key={g.id}>
              <div class="gr-box">
                <button class={cx('folder', box === gb && !boxId && !search && 'on')} onClick={() => choose(g)} title={`${g.name} <${g.email}>`}>
                  <Users size={17} /><span class="label">{g.name}</span>{n > 0 && <span class="n">{n}</span>}
                </button>
                {mayManage(g) && <IconButton icon={Settings2} size={15} label={'Manage ' + g.name} onClick={() => setSettings(g.id)} />}
              </div>
              {box === gb && folders(gb, gb.mailboxes.value.filter((m) => m.role !== 'inbox'), true)}
            </div>
          )
        })}
      </aside>

      <section class="mail-list" aria-label="Messages">
        {myGroups.value.length > 0 && (
          <div class="gr-narrow">
            <select class="select" aria-label="Mailbox" value={groupId} onChange={(e) => choose(myGroups.value.find((g) => g.id === e.target.value))}>
              <option value="">My mail</option>
              {myGroups.value.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        )}
        <div class="mail-search">
          <Search size={15} />
          <input class="input" type="search" placeholder={group ? 'Search ' + group.name : 'Search mail'} value={typed} onInput={(e) => setTyped(e.target.value)} />
        </div>
        <div class="mail-rows">
          {rows.length === 0 && list && <Empty icon={search ? Search : group ? Users : Inbox} title={search ? 'No results' : 'Nothing here'} text={search ? 'Try different words.' : folder?.role === 'inbox' ? (group ? `Mail to ${group.email} arrives here.` : "You're all caught up.") : ''} />}
          {rows.map((e) => {
            const count = box.threads.value[e.threadId]?.length || 1
            const who = sentView ? 'To: ' + ((e.to || []).map(person).join(', ') || '(nobody)') : person(e.from?.[0])
            return (
              <button key={e.id} class={cx('mrow', !e.keywords?.$seen && 'unread', openId === e.threadId && 'on')} onClick={() => open(e)}>
                <div class="top">
                  <span class="who ellipsis">{who}{count > 1 && <span class="muted" style={{ fontWeight: 400 }}> {count}</span>}</span>
                  <span class="marks">
                    {e.keywords?.$answered && group && <CornerUpLeft size={13} />}
                    {e.keywords?.$flagged && <Star size={13} class="star" fill="currentColor" />}
                    {e.hasAttachment && <Paperclip size={13} />}
                  </span>
                  <span class="date">{when(new Date(e.receivedAt).getTime())}</span>
                </div>
                <div class="subj ellipsis">{e.subject || '(no subject)'}</div>
                <div class="prev ellipsis">{e.preview}</div>
              </button>
            )
          })}
          {list && list.ids.length < list.total && <div class="more-row"><Button onClick={() => box.loadList(current, { search, more: true })}>Load more</Button></div>}
        </div>
      </section>

      <section class="mail-read" aria-label="Conversation">
        {!openId || !last ? (
          <Empty icon={MailOpen} title={openId ? '' : 'Select a conversation'} text={openId ? '' : group && !writer ? `You can read ${group.name}'s mail. Its users answer it.` : 'Press c to write, j and k to move through the list.'} />
        ) : (
          <>
            <div class="read-bar">
              <IconButton icon={ArrowLeft} label="Back to list" class="only-narrow" onClick={() => setOpenId(null)} />
              {writer && <IconButton icon={Reply} label="Reply (r)" onClick={() => startCompose(draftFor('reply', last, box))} />}
              {writer && <IconButton icon={ReplyAll} label="Reply all" onClick={() => startCompose(draftFor('all', last, box))} />}
              <IconButton icon={Forward} label="Forward" onClick={() => startCompose(draftFor('forward', last, box))} />
              {writer && <span class="sep" style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 6px' }} />}
              {writer && <IconButton icon={Archive} label="Archive (e)" onClick={() => fileAway('archive', 'Archive')} />}
              {writer && <IconButton icon={Trash2} label={folder?.role === 'trash' ? 'Delete for ever' : 'Delete (#)'} onClick={remove} />}
              {writer && <IconButton icon={Star} label="Star" active={!!last.keywords?.$flagged} onClick={() => box.setKeyword([last.id], '$flagged', !last.keywords?.$flagged)} />}
              <IconButton icon={MailIcon} label="Mark unread" onClick={() => { box.setKeyword([last.id], '$seen', false); setOpenId(null) }} />
              <span class="grow" />
              {writer && <Menu align="right" trigger={<Button class="btn-ghost" icon={Folder}>Move</Button>} items={box.mailboxes.value.filter((m) => m.id !== current).map((m) => ({
                label: label(m), icon: folderIcon[m.role] || Folder, onSelect: () => { const ids = [...threadIds]; step(1); box.moveTo(ids, m.id).catch((e) => toast(e.message, 'error')) },
              }))} />}
            </div>
            <div class="read-scroll" key={openId}>
              <h1>{last.subject || '(no subject)'}</h1>
              {group && <Activity thread={thread} />}
              {thread.map((e, i) => {
                const isOpen = expanded[e.id] ?? (i === thread.length - 1 || !e.keywords?.$seen)
                return <Message key={e.id} email={e} group={group} open={isOpen} onToggle={() => setExpanded({ ...expanded, [e.id]: !isOpen })} />
              })}
              <div class="row" style={{ marginTop: 6 }}>
                {writer && <Button icon={Reply} onClick={() => startCompose(draftFor('reply', last, box))}>{group ? 'Reply as ' + group.name : 'Reply'}</Button>}
                <Button icon={Forward} onClick={() => startCompose(draftFor('forward', last, box))}>Forward</Button>
              </div>
            </div>
          </>
        )}
      </section>
      {compose && <Compose key={compose.subject + compose.to + compose.from} init={compose} onClose={() => setCompose(null)} />}
      {settings && <GroupSettings id={settings} onClose={() => setSettings(null)} />}
    </div>
  )
}
