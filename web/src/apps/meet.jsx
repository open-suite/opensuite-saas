import { useState } from 'preact/hooks'
import { Video, Link2, Trash2, Plus } from 'lucide-preact'
import './meet.css'
import { meetings, patchBoot, toast } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { del } from '../lib/api.js'
import { newMeeting, meetLink } from '../lib/docs.js'
import { copyText, when } from '../lib/util.js'
import { Button, Empty, Field, IconButton, Modal } from '../ui.jsx'

export function MeetHome() {
  const [code, setCode] = useState('')
  const [naming, setNaming] = useState(false)
  const [title, setTitle] = useState('')
  const join = (e) => {
    e.preventDefault()
    const m = code.trim().toLowerCase().match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/)
    if (!m) return toast('Enter a meeting code like abc-defg-hij, or paste the link.', 'error')
    navigate('/meet/' + m[0])
  }
  const copy = async (c) => (await copyText(meetLink(c))) && toast('Link copied')
  const remove = (m) => {
    patchBoot({ meetings: meetings.value.filter((x) => x.code !== m.code) })
    del('/api/meet/' + m.code).catch(() => {})
  }
  const createNamed = (e) => {
    e.preventDefault()
    const { code: c } = newMeeting(title.trim())
    setNaming(false)
    setTitle('')
    copy(c)
  }
  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head"><h1>Meet</h1></div>
        <div class="card meet-hero">
          <Button kind="primary" class="btn-lg" icon={Video} onClick={() => navigate('/meet/' + newMeeting().code)}>Start a meeting now</Button>
          <Button class="btn-lg" icon={Plus} onClick={() => setNaming(true)}>Create a room for later</Button>
          <form onSubmit={join}>
            <input class="input" style={{ height: 42 }} placeholder="Enter a code or paste a link" value={code} onInput={(e) => setCode(e.target.value)} />
            <Button class="btn-lg" type="submit" disabled={!code.trim()}>Join</Button>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><h2>Your rooms</h2></div>
          {meetings.value.length === 0 ? (
            <Empty icon={Video} title="No rooms yet" text="A room is a permanent link. Share it with anyone; guests join from their browser with no account." />
          ) : meetings.value.map((m) => (
            <div class="list-row" key={m.code}>
              <span class="kind-icon kind-meet"><Video size={17} /></span>
              <span class="grow" style={{ minWidth: 0 }}>
                <div class="ellipsis" style={{ fontWeight: 550 }}>{m.title || 'Meeting'}</div>
                <div class="sub">{m.code}{m.used ? ' · last used ' + when(m.used * 1000) : ''}</div>
              </span>
              <IconButton icon={Link2} label="Copy link" onClick={() => copy(m.code)} />
              <IconButton icon={Trash2} label="Delete room" onClick={() => remove(m)} />
              <Button onClick={() => navigate('/meet/' + m.code)}>Join</Button>
            </div>
          ))}
        </div>
      </div>
      {naming && (
        <Modal title="Create a room" onClose={() => setNaming(false)} footer={<><Button onClick={() => setNaming(false)}>Cancel</Button><Button kind="primary" onClick={createNamed}>Create and copy link</Button></>}>
          <form onSubmit={createNamed}>
            <Field label="Name" hint="Shown to everyone who joins.">
              <input class="input" autofocus placeholder="Weekly sync" value={title} onInput={(e) => setTitle(e.target.value)} />
            </Field>
          </form>
        </Modal>
      )}
    </div>
  )
}
