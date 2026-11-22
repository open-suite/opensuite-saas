import { FileText, Table2, Video, PenSquare, MessageSquare, Mail as MailIcon } from 'lucide-preact'
import { user, org, docs, meetings } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { openNew, docPath, newMeeting } from '../lib/docs.js'
import { rooms, roomTitle } from '../lib/matrix.js'
import { lists, emails, boxByRole } from '../lib/mail.js'
import { when } from '../lib/util.js'
import { Avatar, Empty } from '../ui.jsx'
import { KindIcon } from './docs.jsx'
import { AgendaCard } from './agenda.jsx'

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function Home() {
  const u = user.value
  const recent = docs.value.filter((d) => !d.trashed).slice(0, 6)
  const inbox = boxByRole('inbox')
  const mail = (lists.value[inbox?.id]?.ids || []).map((id) => emails.value[id]).filter(Boolean).slice(0, 5)
  const chats = Object.values(rooms.value).sort((a, b) => b.ts - a.ts).slice(0, 5)
  const meets = meetings.value.slice(0, 4)
  const startMeeting = () => navigate('/meet/' + newMeeting().code)
  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head">
          <div class="grow">
            <h1>{greeting()}, {u.name.split(' ')[0]}</h1>
            <p class="muted">{org.value.name}</p>
          </div>
        </div>
        <div class="quick">
          <button class="quick-btn" onClick={() => openNew('doc')}><span class="kind-icon kind-doc"><FileText size={17} /></span>New document</button>
          <button class="quick-btn" onClick={() => openNew('sheet')}><span class="kind-icon kind-sheet"><Table2 size={17} /></span>New spreadsheet</button>
          <button class="quick-btn" onClick={startMeeting}><span class="kind-icon kind-meet"><Video size={17} /></span>Start a meeting</button>
          <a class="quick-btn" href="/mail?compose=1"><span class="kind-icon kind-doc"><PenSquare size={17} /></span>Write an email</a>
        </div>
        <div class="home-grid">
          <AgendaCard />
          <section class="card wide">
            <div class="card-head"><h2>Recent documents</h2><a href="/docs">All docs</a></div>
            {recent.length === 0 ? <Empty icon={FileText} title="Nothing here yet" text="Documents and spreadsheets you open appear here." /> : recent.map((d) => (
              <a class="list-row" href={docPath(d)} key={d.id}>
                <KindIcon kind={d.kind} />
                <span class="grow ellipsis" style={{ fontWeight: 550 }}>{d.title || 'Untitled'}</span>
                <span class="muted">{when(d.updated * 1000)}</span>
              </a>
            ))}
          </section>
          <section class="card">
            <div class="card-head"><h2>Inbox</h2>{inbox?.unreadEmails > 0 && <span class="badge badge-accent">{inbox.unreadEmails} unread</span>}<a href="/mail">Open mail</a></div>
            {mail.length === 0 ? <Empty icon={MailIcon} title="Inbox zero" text="New mail shows up here as it arrives." /> : mail.map((e) => (
              <a class="list-row" href={'/mail?open=' + e.threadId} key={e.id}>
                <Avatar name={e.from?.[0]?.name || e.from?.[0]?.email} size={28} />
                <span class="grow" style={{ minWidth: 0 }}>
                  <div class="ellipsis" style={{ fontWeight: e.keywords?.$seen ? 450 : 650 }}>{e.from?.[0]?.name || e.from?.[0]?.email}</div>
                  <div class="sub ellipsis">{e.subject || '(no subject)'}</div>
                </span>
                <span class="muted">{when(new Date(e.receivedAt).getTime())}</span>
              </a>
            ))}
          </section>
          <section class="card">
            <div class="card-head"><h2>Chat</h2><a href="/chat">Open chat</a></div>
            {chats.length === 0 ? <Empty icon={MessageSquare} title="No conversations yet" text="Message a colleague to get started." /> : chats.map((r) => {
              const last = [...r.timeline].reverse().find((e) => e.kind !== 'note')
              return (
                <a class="list-row" href={'/chat/' + encodeURIComponent(r.id)} key={r.id}>
                  <Avatar name={roomTitle(r)} id={r.id} size={28} />
                  <span class="grow" style={{ minWidth: 0 }}>
                    <div class="ellipsis" style={{ fontWeight: r.unread ? 650 : 450 }}>{roomTitle(r)}</div>
                    <div class="sub ellipsis">{last ? (last.kind === 'text' ? last.body : last.kind === 'image' ? 'Photo' : 'File') : 'No messages yet'}</div>
                  </span>
                  {r.unread > 0 && <span class="count">{r.unread}</span>}
                </a>
              )
            })}
          </section>
          <section class="card wide">
            <div class="card-head"><h2>Your meeting rooms</h2><a href="/meet">All meetings</a></div>
            {meets.length === 0 ? <Empty icon={Video} title="No meeting rooms" text="Start a meeting and share the link with anyone." /> : meets.map((m) => (
              <a class="list-row" href={'/meet/' + m.code} key={m.code}>
                <span class="kind-icon kind-meet"><Video size={17} /></span>
                <span class="grow ellipsis" style={{ fontWeight: 550 }}>{m.title || m.code}</span>
                <span class="muted">{m.title ? m.code : ''}</span>
              </a>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
