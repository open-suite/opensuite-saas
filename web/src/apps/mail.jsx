import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Inbox, Send, FileEdit, Archive, Trash2, ShieldAlert, Folder, PenSquare, Search, Reply, ReplyAll, Forward, Star,
  MailOpen, Paperclip, X, ArrowLeft, Image as ImageIcon, Bold, Italic, List, Mail as MailIcon,
} from 'lucide-preact'
import './mail.css'
import { people, toast, boot } from '../lib/store.js'
import { query, navigate } from '../lib/router.js'
import {
  mailboxes, lists, emails, threads, identity, mailReady, loadList, loadThread, setKeyword, moveTo, destroy,
  ensureMailbox, boxByRole, send, uploadAttachment, listKey,
} from '../lib/mail.js'
import { cx, when, whenFull, bytes, escapeHtml, debounce } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu } from '../ui.jsx'

const folderIcon = { inbox: Inbox, sent: Send, drafts: FileEdit, archive: Archive, trash: Trash2, junk: ShieldAlert }
const folderName = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash', junk: 'Spam' }
const label = (m) => folderName[m.role] || m.name
const person = (a) => a?.name || a?.email || ''
const addrList = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')

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
function buildFrame(email, showRemote) {
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
          if (a) el.setAttribute('src', `/api/mail/blob/${a.blobId}/${encodeURIComponent(a.name || 'image')}?type=${encodeURIComponent(a.type)}`)
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

function MessageBody({ email }) {
  const [remote, setRemote] = useState(false)
  const ref = useRef()
  const { page, blocked } = useMemo(() => buildFrame(email, remote), [email.id, !!email.bodyValues, remote])
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

function Message({ email, open, onToggle }) {
  const from = email.from?.[0]
  const files = (email.attachments || []).filter((a) => !(a.cid && a.disposition === 'inline'))
  return (
    <article class="msg">
      <div class={cx('msg-head', 'fold')} onClick={onToggle}>
        <Avatar name={person(from)} size={34} />
        <div class="meta">
          <div class="from ellipsis">{person(from)} {from?.name && <span class="muted" style={{ fontWeight: 400 }}>&lt;{from.email}&gt;</span>}</div>
          <div class="to ellipsis">{open ? 'to ' + addrList([...(email.to || []), ...(email.cc || [])]) : email.preview}</div>
        </div>
        <div class="date" title={whenFull(new Date(email.receivedAt).getTime())}>{when(new Date(email.receivedAt).getTime())}</div>
      </div>
      {open && (email.bodyValues ? <MessageBody email={email} /> : <div class="msg-body muted">{email.preview}</div>)}
      {open && files.length > 0 && (
        <div class="atts">
          {files.map((a) => (
            <a class="att" key={a.blobId} href={`/api/mail/blob/${a.blobId}/${encodeURIComponent(a.name || 'attachment')}?type=${encodeURIComponent(a.type)}&dl=1`} download={a.name}>
              <Paperclip size={14} /><span class="ellipsis">{a.name || 'attachment'}</span><span class="muted">{bytes(a.size || 0)}</span>
            </a>
          ))}
        </div>
      )}
    </article>
  )
}

// --- composing -----------------------------------------------------------

const DRAFT = 'os:draft'
const saveDraft = debounce((d) => {
  try {
    localStorage.setItem(DRAFT, JSON.stringify(d))
  } catch {}
}, 400)

function Compose({ init, onClose }) {
  const [f, setF] = useState(init)
  const [showCc, setShowCc] = useState(!!(init.cc || init.bcc))
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const body = useRef()
  const fileInput = useRef()
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
  const attach = async (list) => {
    for (const file of list) {
      const tmp = { name: file.name, size: file.size, uploading: true }
      setFiles((x) => [...x, tmp])
      try {
        const up = await uploadAttachment(file)
        setFiles((x) => x.map((y) => (y === tmp ? up : y)))
      } catch (e) {
        setFiles((x) => x.filter((y) => y !== tmp))
        toast(e.message, 'error')
      }
    }
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
      await send({ to, cc, bcc, subject: f.subject, html: `<div>${html}</div>`, text: body.current.innerText, attachments: files, inReplyTo: f.inReplyTo, references: f.references })
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
  return (
    <div class="compose" role="dialog" aria-label="New message" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submit()}>
      <header><span class="grow">{f.subject || 'New message'}</span><IconButton icon={X} label="Save and close" onClick={() => close(false)} /></header>
      <div class="line">
        <label for="c-to">To</label>
        <input id="c-to" list="c-people" autofocus={!init.to} value={f.to} onInput={set('to')} autocomplete="off" />
        {!showCc && <button onClick={() => setShowCc(true)}>Cc Bcc</button>}
      </div>
      {showCc && <div class="line"><label for="c-cc">Cc</label><input id="c-cc" list="c-people" value={f.cc} onInput={set('cc')} autocomplete="off" /></div>}
      {showCc && <div class="line"><label for="c-bcc">Bcc</label><input id="c-bcc" list="c-people" value={f.bcc} onInput={set('bcc')} autocomplete="off" /></div>}
      <div class="line"><label for="c-subj">Subject</label><input id="c-subj" value={f.subject} onInput={set('subject')} /></div>
      <datalist id="c-people">{people.value.map((p) => <option key={p.id} value={`${p.name} <${p.email}>`} />)}</datalist>
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

function draftFor(mode, email) {
  const me = identity.value?.email
  const re = (p, s = '') => (new RegExp('^' + p + ':', 'i').test(s) ? s : `${p}: ${s}`)
  const refs = [...(email.references || []), ...(email.messageId || [])]
  if (mode === 'forward') return { to: '', cc: '', bcc: '', subject: re('Fwd', email.subject), html: quote(email) }
  const replyTo = email.replyTo?.length ? email.replyTo : email.from || []
  const all = mode === 'all' ? [...(email.to || []), ...(email.cc || [])].filter((a) => a.email !== me && !replyTo.find((r) => r.email === a.email)) : []
  return { to: addrList(replyTo), cc: addrList(all), bcc: '', subject: re('Re', email.subject), html: quote(email), inReplyTo: email.messageId, references: refs }
}

// --- the mail screen -----------------------------------------------------

export function Mail() {
  const params = new URLSearchParams(query.value)
  const inbox = boxByRole('inbox')
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
  const current = boxId || inbox?.id
  const key = listKey(current, search)
  const list = lists.value[key]
  const box = mailboxes.value.find((m) => m.id === current)

  useEffect(() => {
    if (params.get('compose')) {
      let saved = null
      try {
        saved = JSON.parse(localStorage.getItem(DRAFT))
      } catch {}
      // "to" comes from search: writing to a person found there.
      setCompose(params.get('to') ? { to: params.get('to'), cc: '', bcc: '', subject: '', html: '' } : saved || { to: '', cc: '', bcc: '', subject: '', html: '' })
      navigate('/mail', { replace: true })
    } else if (params.get('open')) {
      setOpenId(params.get('open'))
      navigate('/mail', { replace: true })
    }
  }, [query.value])

  useEffect(() => {
    if (current) loadList(current, { search }).catch(() => {})
  }, [current, search])

  const rows = (list?.ids || []).map((id) => emails.value[id]).filter(Boolean)
  const threadIds = openId ? threads.value[openId] || [] : []
  const thread = threadIds.map((id) => emails.value[id]).filter(Boolean)
  const last = thread[thread.length - 1]

  useEffect(() => {
    if (!openId) return
    loadThread(openId).catch((e) => toast(e.message, 'error'))
  }, [openId])

  useEffect(() => {
    // Opening a conversation marks it read.
    const unseen = thread.filter((e) => !e.keywords?.$seen && !e.keywords?.$draft).map((e) => e.id)
    if (unseen.length) setKeyword(unseen, '$seen', true).catch(() => {})
  }, [openId, thread.length])

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
    const dest = await ensureMailbox(role, name)
    step(1)
    moveTo(ids, dest).catch((e) => toast(e.message, 'error'))
  }
  const remove = () => {
    if (box?.role === 'trash') {
      const ids = [...threadIds]
      step(1)
      destroy(ids).catch((e) => toast(e.message, 'error'))
    } else fileAway('trash', 'Trash')
  }
  const startCompose = (init) => setCompose(init || { to: '', cc: '', bcc: '', subject: '', html: '' })

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input,textarea,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'c') { e.preventDefault(); startCompose() }
      else if (e.key === 'j') openId ? step(1) : rows[0] && open(rows[0])
      else if (e.key === 'k') openId && step(-1)
      else if (!last) return
      else if (e.key === 'e') fileAway('archive', 'Archive')
      else if (e.key === '#') remove()
      else if (e.key === 'r') { e.preventDefault(); startCompose(draftFor('reply', last)) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (!boot.value?.mail?.ready && !mailReady.value) {
    return <div class="page"><Empty icon={MailIcon} title="Your mailbox is being prepared" text="This takes a few seconds the first time. It will appear here on its own." /></div>
  }

  const sentView = box?.role === 'sent' || box?.role === 'drafts'
  return (
    <div class={cx('mail', openId && 'reading')}>
      <aside class="mail-side">
        <Button kind="primary" icon={PenSquare} onClick={() => startCompose()}><span>Compose</span></Button>
        {mailboxes.value.map((m) => {
          const Icon = folderIcon[m.role] || Folder
          const n = m.role === 'drafts' ? m.totalEmails : m.unreadEmails
          return (
            <button key={m.id} class={cx('folder', current === m.id && !search && 'on')} onClick={() => { setBoxId(m.id); setTyped(''); setSearch(''); setOpenId(null) }} title={label(m)}>
              <Icon size={17} /><span class="label">{label(m)}</span>{n > 0 && <span class="n">{n}</span>}
            </button>
          )
        })}
      </aside>

      <section class="mail-list" aria-label="Messages">
        <div class="mail-search">
          <Search size={15} />
          <input class="input" type="search" placeholder="Search mail" value={typed} onInput={(e) => setTyped(e.target.value)} />
        </div>
        <div class="mail-rows">
          {rows.length === 0 && list && <Empty icon={search ? Search : Inbox} title={search ? 'No results' : 'Nothing here'} text={search ? 'Try different words.' : box?.role === 'inbox' ? "You're all caught up." : ''} />}
          {rows.map((e) => {
            const count = threads.value[e.threadId]?.length || 1
            const who = sentView ? 'To: ' + ((e.to || []).map(person).join(', ') || '(nobody)') : person(e.from?.[0])
            return (
              <button key={e.id} class={cx('mrow', !e.keywords?.$seen && 'unread', openId === e.threadId && 'on')} onClick={() => open(e)}>
                <div class="top">
                  <span class="who ellipsis">{who}{count > 1 && <span class="muted" style={{ fontWeight: 400 }}> {count}</span>}</span>
                  <span class="marks">
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
          {list && list.ids.length < list.total && <div class="more-row"><Button onClick={() => loadList(current, { search, more: true })}>Load more</Button></div>}
        </div>
      </section>

      <section class="mail-read" aria-label="Conversation">
        {!openId || !last ? (
          <Empty icon={MailOpen} title={openId ? '' : 'Select a conversation'} text={openId ? '' : 'Press c to write, j and k to move through the list.'} />
        ) : (
          <>
            <div class="read-bar">
              <IconButton icon={ArrowLeft} label="Back to list" class="only-narrow" onClick={() => setOpenId(null)} />
              <IconButton icon={Reply} label="Reply (r)" onClick={() => startCompose(draftFor('reply', last))} />
              <IconButton icon={ReplyAll} label="Reply all" onClick={() => startCompose(draftFor('all', last))} />
              <IconButton icon={Forward} label="Forward" onClick={() => startCompose(draftFor('forward', last))} />
              <span class="sep" style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 6px' }} />
              <IconButton icon={Archive} label="Archive (e)" onClick={() => fileAway('archive', 'Archive')} />
              <IconButton icon={Trash2} label={box?.role === 'trash' ? 'Delete for ever' : 'Delete (#)'} onClick={remove} />
              <IconButton icon={Star} label="Star" active={!!last.keywords?.$flagged} onClick={() => setKeyword([last.id], '$flagged', !last.keywords?.$flagged)} />
              <IconButton icon={MailIcon} label="Mark unread" onClick={() => { setKeyword([last.id], '$seen', false); setOpenId(null) }} />
              <span class="grow" />
              <Menu align="right" trigger={<Button class="btn-ghost" icon={Folder}>Move</Button>} items={mailboxes.value.filter((m) => m.id !== current).map((m) => ({
                label: label(m), icon: folderIcon[m.role] || Folder, onSelect: () => { const ids = [...threadIds]; step(1); moveTo(ids, m.id).catch((e) => toast(e.message, 'error')) },
              }))} />
            </div>
            <div class="read-scroll" key={openId}>
              <h1>{last.subject || '(no subject)'}</h1>
              {thread.map((e, i) => {
                const isOpen = expanded[e.id] ?? (i === thread.length - 1 || !e.keywords?.$seen)
                return <Message key={e.id} email={e} open={isOpen} onToggle={() => setExpanded({ ...expanded, [e.id]: !isOpen })} />
              })}
              <div class="row" style={{ marginTop: 6 }}>
                <Button icon={Reply} onClick={() => startCompose(draftFor('reply', last))}>Reply</Button>
                <Button icon={Forward} onClick={() => startCompose(draftFor('forward', last))}>Forward</Button>
              </div>
            </div>
          </>
        )}
      </section>
      {compose && <Compose key={compose.subject + compose.to} init={compose} onClose={() => setCompose(null)} />}
    </div>
  )
}
