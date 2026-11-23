import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Plus, Paperclip, FolderOpen, SendHorizontal, Video, MoreHorizontal, UserPlus, LogOut, MessageSquare, ArrowLeft, FileDown, Link2, Copy, Check, Trash2 } from 'lucide-preact'
import { pickFromFiles, fetchFile } from '../lib/files.js'
import './chat.css'
import { boot, people, peopleByMx, user, toast } from '../lib/store.js'
import { parts, navigate } from '../lib/router.js'
import { get, post, del } from '../lib/api.js'
import {
  rooms, chatReady, roomTitle, directPeer, nameOf, isExternalMx, sendText, sendFile, markRead, sendTyping, loadOlder, openDirect,
  createRoom, inviteTo, leaveRoom, mediaUrl,
} from '../lib/matrix.js'
import { newMeeting, meetLink } from '../lib/docs.js'
import { cx, clock, dayLabel, bytes, when, download } from '../lib/util.js'
import { Avatar, Button, Empty, Field, IconButton, Menu, Modal } from '../ui.jsx'

const roomPath = (id) => '/chat/' + encodeURIComponent(id)

function preview(room) {
  const last = [...room.timeline].reverse().find((e) => e.kind !== 'note')
  if (!last) return 'No messages yet'
  const who = last.sender === boot.value.chat.userId ? 'You: ' : ''
  return who + (last.kind === 'text' ? last.body : last.kind === 'image' ? 'Photo' : last.body || 'File')
}

function Shot({ mxc, alt }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let live = true
    mediaUrl(mxc, true).then((u) => live && setSrc(u)).catch(() => {})
    return () => (live = false)
  }, [mxc])
  const full = async () => window.open(await mediaUrl(mxc), '_blank', 'noopener')
  return <img class="shot" src={src || undefined} alt={alt} style={{ minHeight: src ? 0 : 120, minWidth: src ? 0 : 200, cursor: 'zoom-in' }} onClick={full} />
}

function Text({ body }) {
  // Links to our own meetings and documents open inside the app.
  const bits = body.split(/(https?:\/\/[^\s]+)/g)
  return (
    <div class="text">
      {bits.map((b, i) => {
        if (!/^https?:\/\//.test(b)) return b
        const own = b.startsWith(location.origin + '/')
        return own ? <a key={i} href={b.slice(location.origin.length)}>{b}</a> : <a key={i} href={b} target="_blank" rel="noopener noreferrer">{b}</a>
      })}
    </div>
  )
}

function Timeline({ room }) {
  const ref = useRef()
  const stick = useRef(true)
  const [older, setOlder] = useState(!!room.prev)
  const fetching = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [room.timeline.length, room.id])

  useEffect(() => {
    stick.current = true
    setOlder(!!room.prev)
    ref.current.scrollTop = ref.current.scrollHeight
  }, [room.id])

  useEffect(() => {
    if (document.visibilityState === 'visible') markRead(room.id)
  }, [room.id, room.timeline.length])

  const onScroll = async () => {
    const el = ref.current
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 120 && older && !fetching.current) {
      fetching.current = true
      const before = el.scrollHeight
      const more = await loadOlder(room.id).catch(() => false)
      setOlder(more)
      // Keep the reader's place while history is added above.
      requestAnimationFrame(() => {
        el.scrollTop += el.scrollHeight - before
        fetching.current = false
      })
    }
  }

  const out = []
  let prev = null
  for (const e of room.timeline) {
    const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(e.ts).toDateString()
    if (newDay) out.push(<div class="day" key={'d' + e.ts}>{dayLabel(e.ts)}</div>)
    if (e.kind === 'note') {
      out.push(<div class="note-row" key={e.id}>{nameOf(e.who, room)} {e.body}</div>)
      prev = null
      continue
    }
    const first = newDay || !prev || prev.sender !== e.sender || e.ts - prev.ts > 300000
    const name = nameOf(e.sender, room)
    const ext = isExternalMx(e.sender)
    const reacts = e.reactions ? Object.entries(e.reactions) : []
    out.push(
      <div class={cx('bubble-row', first && 'first', e.pending && 'pending', e.failed && 'failed')} key={e.id}>
        <div class="gutter">{first && <Avatar name={name} id={peopleByMx.value[e.sender]?.id || e.sender} size={34} />}</div>
        <div class="grow">
          {first && (
            <div class="who">
              <b>{name}</b>
              {ext && <span class="ch-ext-tag">External</span>}
              <time>{clock(e.ts)}</time>
            </div>
          )}
          {e.kind === 'text' && (
            <div class="ch-msg-line">
              <Text body={e.body} />
              {e.edited && <span class="ch-edited">(edited)</span>}
            </div>
          )}
          {e.kind === 'image' && <Shot mxc={e.url} alt={e.body} />}
          {e.kind === 'file' && (
            <button class="att" style={{ marginTop: 4, background: 'transparent' }} onClick={async () => download(await (await fetch(await mediaUrl(e.url))).blob(), e.body)}>
              <FileDown size={15} /><span class="ellipsis">{e.body}</span>{e.size && <span class="muted">{bytes(e.size)}</span>}
            </button>
          )}
          {reacts.length > 0 && (
            <div class="ch-reacts">
              {reacts.map(([key, ids]) => (
                <span key={key} class="ch-react">{key} <b>{ids.length}</b></span>
              ))}
            </div>
          )}
          {e.failed && <div class="muted" style={{ fontSize: 12 }}>Not sent. Check your connection and try again.</div>}
        </div>
      </div>,
    )
    prev = e
  }
  return (
    <div class="timeline" ref={ref} onScroll={onScroll}>
      <div class="pad" />
      {room.timeline.length === 0 && <div class="note-row">This is the start of the conversation.</div>}
      {out}
    </div>
  )
}

function Composer({ room }) {
  const [text, setText] = useState('')
  const ta = useRef()
  const file = useRef()
  useEffect(() => {
    setText('')
    ta.current?.focus()
  }, [room.id])
  useLayoutEffect(() => {
    const el = ta.current
    el.style.height = 'auto'
    el.style.height = Math.min(180, el.scrollHeight) + 'px'
  }, [text])
  const submit = () => {
    const body = text.trim()
    if (!body) return
    setText('')
    sendText(room.id, body)
  }
  const attach = async (files) => {
    for (const f of files) await sendFile(room.id, f).catch(() => toast("That file couldn't be sent.", 'error'))
  }
  // A file from the drive goes into the conversation as a copy, so everyone
  // in it can open it whatever the original is shared with.
  const fromFiles = async () => {
    const node = await pickFromFiles({ title: 'Send a file', action: 'Send' })
    if (!node) return
    try {
      await attach([await fetchFile(node)])
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  return (
    <div class="composer" onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(e.dataTransfer.files) } }} onDragOver={(e) => e.preventDefault()}>
      <textarea ref={ta} rows={1} placeholder={'Message ' + roomTitle(room)} value={text}
        onInput={(e) => { setText(e.target.value); sendTyping(room.id) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() } }}
        onPaste={(e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); attach(f) } }} />
      <IconButton icon={Paperclip} label="Attach a file" onClick={() => file.current.click()} />
      <IconButton icon={FolderOpen} label="Send from Files" onClick={fromFiles} />
      <input ref={file} type="file" multiple hidden onChange={(e) => { attach([...e.target.files]); e.target.value = '' }} />
      <IconButton icon={SendHorizontal} label="Send" class={text.trim() ? 'on' : ''} onClick={submit} />
    </div>
  )
}

function PeoplePicker({ title, action, exclude = [], withName, onClose, onDone }) {
  const [picked, setPicked] = useState([])
  const [name, setName] = useState('')
  const options = people.value.filter((p) => p.id !== user.value.id && p.status === 'active' && p.mx && !exclude.includes(p.mx))
  const toggle = (mx) => setPicked(picked.includes(mx) ? picked.filter((x) => x !== mx) : [...picked, mx])
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!picked.length || (withName && !name.trim())} onClick={() => onDone(picked, name.trim())}>{action}</Button></>}>
      {withName && <Field label="Name"><input class="input" autofocus placeholder="e.g. Marketing" value={name} onInput={(e) => setName(e.target.value)} /></Field>}
      <Field label="People">
        <div class="pick">
          {options.length === 0 && <p class="muted">Everyone is already here.</p>}
          {options.map((p) => (
            <label key={p.id}>
              <input type="checkbox" checked={picked.includes(p.mx)} onChange={() => toggle(p.mx)} />
              <Avatar name={p.name} id={p.id} size={28} />
              <span class="grow ellipsis">{p.name}</span>
              <span class="muted ellipsis">{p.email}</span>
            </label>
          ))}
        </div>
      </Field>
    </Modal>
  )
}

function SlackModal({ room, state, onChange, onClose }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const base = '/api/chat/rooms/' + encodeURIComponent(room.id) + '/slack'

  const createInvite = async () => {
    setBusy(true)
    try {
      const inv = await post(base + '/invites', { roomName: roomTitle(room) })
      onChange({ ...state, invites: [inv, ...(state.invites || [])] })
      copy(inv.url)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const copy = (url) => {
    navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(url)
    toast('Invite link copied')
    setTimeout(() => setCopied((c) => (c === url ? '' : c)), 2500)
  }

  const revoke = async (token) => {
    try {
      await del(base + '/invites/' + encodeURIComponent(token))
      onChange({ ...state, invites: state.invites.filter((i) => i.token !== token) })
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const unlink = async (id) => {
    try {
      await del(base + '/links/' + encodeURIComponent(id))
      onChange({ ...state, links: state.links.filter((l) => l.id !== id) })
      toast('Slack channel disconnected')
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  return (
    <Modal title="External Slack channels" onClose={onClose} width={500} footer={<Button onClick={onClose}>Done</Button>}>
      <p class="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Connect this conversation to a channel in an external Slack workspace. Works on any Slack plan. Messages sent while connected pass through Slack&apos;s servers.
      </p>

      {state.links.length > 0 && (
        <div class="ch-slk-sec">
          <h4>Connected channels</h4>
          {state.links.map((l) => (
            <div key={l.id} class="ch-slk-row">
              <div class="grow" style={{ minWidth: 0 }}>
                <div class="ellipsis" style={{ fontWeight: 600 }}>#{l.channelName || l.channelId}</div>
                <div class="muted ellipsis" style={{ fontSize: 12.5 }}>{l.teamName}</div>
              </div>
              <Button kind="danger" onClick={() => unlink(l.id)}>Disconnect</Button>
            </div>
          ))}
        </div>
      )}

      <div class="ch-slk-sec">
        <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h4 style={{ margin: 0 }}>Invite links</h4>
          <Button kind="primary" icon={Link2} busy={busy} onClick={createInvite}>Create invite link</Button>
        </div>
        {state.invites.length === 0 ? (
          <p class="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
            Send a one-time invite link to someone at the partner organisation. They authorise their Slack workspace and pick a channel — no Open Suite account needed.
          </p>
        ) : (
          state.invites.map((inv) => (
            <div key={inv.token} class="ch-slk-row">
              <input class="input ch-slk-url" readOnly value={inv.url} onClick={(e) => e.target.select()} />
              <IconButton icon={copied === inv.url ? Check : Copy} label="Copy link" onClick={() => copy(inv.url)} />
              <IconButton icon={Trash2} label="Revoke invite" onClick={() => revoke(inv.token)} />
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

export function Chat() {
  const roomId = parts.value[1] ? decodeURIComponent(parts.value[1]) : null
  const [dialog, setDialog] = useState(null)
  const [slack, setSlack] = useState({ links: [], invites: [] })
  const slackOn = !!boot.value.chat?.slack
  const all = Object.values(rooms.value).sort((a, b) => b.ts - a.ts)
  const room = roomId ? rooms.value[roomId] : null
  const me = boot.value.chat.userId
  const withDm = new Set(all.map(directPeer).filter(Boolean))
  const others = people.value.filter((p) => p.mx && p.mx !== me && p.status === 'active' && !withDm.has(p.mx))

  useEffect(() => {
    setSlack({ links: [], invites: [] })
    if (!roomId || !slackOn) return
    let live = true
    get('/api/chat/rooms/' + encodeURIComponent(roomId) + '/slack', { quiet: true })
      .then((d) => live && setSlack({ links: d.links || [], invites: d.invites || [] }))
      .catch(() => {})
    return () => { live = false }
  }, [roomId, slackOn])

  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && roomId && markRead(roomId)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [roomId])

  const dm = async (p) => {
    try {
      navigate(roomPath(await openDirect(p.mx)))
    } catch {
      toast("That conversation couldn't be opened.", 'error')
    }
  }
  const startCall = () => {
    const { code } = newMeeting(roomTitle(room))
    sendText(room.id, 'Join the meeting: ' + meetLink(code))
    navigate('/meet/' + code)
  }

  if (!boot.value.chat.ready && !chatReady.value) {
    return <div class="page"><Empty icon={MessageSquare} title="Chat is being prepared" text="This takes a few seconds the first time." /></div>
  }

  return (
    <div class={cx('chat', room && 'open')}>
      <aside class="chat-side">
        <header><h1>Chat</h1><IconButton icon={Plus} label="New group" onClick={() => setDialog('new')} /></header>
        <div class="scroll">
          {all.length > 0 && <h4>Conversations</h4>}
          {all.map((r) => {
            const peer = directPeer(r)
            const title = roomTitle(r)
            return (
              <a key={r.id} href={roomPath(r.id)} class={cx('conv', roomId === r.id && 'on', r.unread > 0 && 'unread')}>
                <Avatar name={title} id={peer ? peopleByMx.value[peer]?.id || peer : r.id} size={34} />
                <span class="t">
                  <div class="row" style={{ gap: 6 }}><span class="name ellipsis grow">{title}</span><span class="muted" style={{ fontSize: 11.5 }}>{r.timeline.length ? when(r.ts) : ''}</span></div>
                  <div class="last ellipsis">{r.typing?.length ? 'typing…' : preview(r)}</div>
                </span>
                {r.unread > 0 && <span class="count">{r.unread}</span>}
              </a>
            )
          })}
          {others.length > 0 && <h4>People</h4>}
          {others.map((p) => (
            <button key={p.id} class="conv" onClick={() => dm(p)}>
              <Avatar name={p.name} id={p.id} size={34} />
              <span class="t"><div class="name ellipsis">{p.name}</div><div class="last ellipsis">{p.email}</div></span>
            </button>
          ))}
          {all.length === 0 && others.length === 0 && <Empty icon={MessageSquare} title="Just you so far" text="Add colleagues in Admin and they appear here, ready to message." />}
        </div>
      </aside>

      <section class="chat-main">
        {!room ? (
          <Empty icon={MessageSquare} title="Pick a conversation" text="Choose a person or group on the left." />
        ) : (
          <>
            <div class="chat-head">
              <IconButton icon={ArrowLeft} label="Back" class="only-narrow" onClick={() => navigate('/chat')} />
              <Avatar name={roomTitle(room)} id={directPeer(room) ? peopleByMx.value[directPeer(room)]?.id || room.id : room.id} size={30} />
              <div class="grow" style={{ minWidth: 0 }}>
                <h2 class="ellipsis">{roomTitle(room)}</h2>
              </div>
              <Button icon={Video} onClick={startCall}>Meet</Button>
              <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" />} items={[
                { label: 'Add people', icon: UserPlus, onSelect: () => setDialog('invite') },
                slackOn && { label: 'Connect Slack', icon: Link2, onSelect: () => setDialog('slack') },
                { divider: true },
                { label: 'Leave conversation', icon: LogOut, danger: true, onSelect: async () => { await leaveRoom(room.id).catch(() => {}); navigate('/chat') } },
              ]} />
            </div>
            {slack.links.length > 0 && (
              <div class="ch-ext-bar">
                <Link2 size={14} />
                <span class="grow ellipsis">
                  Connected to Slack:{' '}
                  {slack.links.map((l) => `#${l.channelName || l.channelId} (${l.teamName})`).join(', ')}
                </span>
                <button type="button" class="ch-ext-btn" onClick={() => setDialog('slack')}>Manage</button>
              </div>
            )}
            <Timeline room={room} />
            <div class="typing">{room.typing?.length > 0 && `${room.typing.map((m) => nameOf(m, room)).join(', ')} ${room.typing.length > 1 ? 'are' : 'is'} typing…`}</div>
            <Composer room={room} />
          </>
        )}
      </section>

      {dialog === 'new' && (
        <PeoplePicker title="New group" action="Create" withName onClose={() => setDialog(null)} onDone={async (mxids, name) => {
          setDialog(null)
          try {
            navigate(roomPath(await createRoom(name, mxids)))
          } catch {
            toast("The group couldn't be created.", 'error')
          }
        }} />
      )}
      {dialog === 'invite' && room && (
        <PeoplePicker title="Add people" action="Add" exclude={Object.keys(room.members).filter((m) => room.members[m].in)} onClose={() => setDialog(null)} onDone={async (mxids) => {
          setDialog(null)
          for (const m of mxids) await inviteTo(room.id, m).catch(() => toast("Someone couldn't be added.", 'error'))
        }} />
      )}
      {dialog === 'slack' && room && (
        <SlackModal room={room} state={slack} onChange={setSlack} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}
