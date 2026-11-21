// The call screen. Members and guests use the same view; a guest only types
// a name first. Media goes through the suite's own video engine.
import { useEffect, useRef, useState } from 'preact/hooks'
import { Room, RoomEvent, Track, createLocalTracks } from 'livekit-client'
import { Mic, MicOff, Video, VideoOff, MonitorUp, PhoneOff, Link2, Users } from 'lucide-preact'
import './meet.css'
import { user, toast } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { get, post } from '../lib/api.js'
import { meetLink } from '../lib/docs.js'
import { cx, copyText } from '../lib/util.js'
import { Avatar, Button, Logo } from '../ui.jsx'

function VideoTile({ track, name, id, muted, speaking, mirror, screen, label }) {
  const ref = useRef()
  useEffect(() => {
    const el = ref.current
    if (!track || !el) return
    track.attach(el)
    return () => track.detach(el)
  }, [track])
  return (
    <div class={cx('tile', speaking && 'speaking', screen && 'screen')}>
      {track ? <video ref={ref} class={cx(mirror && 'mirror')} autoplay playsinline muted /> : <Avatar name={name} id={id} size={84} />}
      <div class="who">{muted && <MicOff size={13} />}<span class="ellipsis">{label || name}</span></div>
    </div>
  )
}

function gridStyle(n) {
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4
  const rows = Math.ceil(n / cols)
  return { gridTemplateColumns: `repeat(${cols}, minmax(0, ${n === 1 ? '1100px' : '1fr'}))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }
}

export default function RoomView({ code }) {
  const me = user.value
  const [info, setInfo] = useState(null)
  const [missing, setMissing] = useState(false)
  const [phase, setPhase] = useState('lobby') // lobby | joining | joined | left
  const [name, setName] = useState(me?.name || localStorage.getItem('os:guest-name') || '')
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  const [preview, setPreview] = useState({ audio: null, video: null })
  const [, bump] = useState(0)
  const [note, setNote] = useState('')
  const room = useRef(null)
  // Remote audio plays from elements kept outside the rendered tree, so it
  // survives every re-layout of the call screen.
  const audio = useRef(null)
  if (!audio.current) audio.current = document.createElement('div')
  useEffect(() => {
    document.body.append(audio.current)
    return () => audio.current.remove()
  }, [])
  const tracks = useRef(preview)
  tracks.current = preview

  // Look the room up; a room created a moment ago may still be on its way.
  useEffect(() => {
    let live = true
    let tries = 0
    const look = () =>
      get('/api/meet/' + code, { quiet: true })
        .then((i) => live && setInfo(i))
        .catch((e) => {
          if (!live) return
          if (e.status === 404 && me && tries++ < 6) setTimeout(look, 250)
          else if (e.status === 404) setMissing(true)
        })
    look()
    return () => (live = false)
  }, [code])

  // Camera and microphone preview before joining.
  useEffect(() => {
    let live = true
    createLocalTracks({ audio: true, video: { resolution: { width: 1280, height: 720 } } })
      .then((list) => {
        if (!live) return list.forEach((t) => t.stop())
        setPreview({ audio: list.find((t) => t.kind === 'audio') || null, video: list.find((t) => t.kind === 'video') || null })
      })
      .catch(() => {
        if (!live) return
        setMic(false)
        setCam(false)
        setNote('Camera and microphone are blocked. You can still join and listen.')
      })
    return () => {
      live = false
      if (!room.current) Object.values(tracks.current).forEach((t) => t?.stop())
      room.current?.disconnect()
    }
  }, [])

  const join = async (e) => {
    e?.preventDefault()
    if (!name.trim()) return
    setPhase('joining')
    try {
      if (!me) localStorage.setItem('os:guest-name', name.trim())
      const { token } = await post(`/api/meet/${code}/join`, { name: name.trim() }, { quiet: true })
      const r = new Room({ adaptiveStream: true, dynacast: true })
      room.current = r
      const refresh = () => bump((n) => n + 1)
      for (const ev of [
        RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
        RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
        RoomEvent.ActiveSpeakersChanged, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
      ]) r.on(ev, refresh)
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) audio.current.append(track.attach())
      })
      r.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove())
      })
      r.on(RoomEvent.Reconnecting, () => setNote('Reconnecting…'))
      r.on(RoomEvent.Reconnected, () => setNote(''))
      r.on(RoomEvent.Disconnected, () => setPhase((p) => (p === 'joined' ? 'left' : p)))
      await r.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/lk`, token)
      await r.startAudio().catch(() => {})
      const { audio: a, video: v } = tracks.current
      if (a) {
        await r.localParticipant.publishTrack(a)
        if (!mic) await a.mute()
      }
      if (v) {
        await r.localParticipant.publishTrack(v)
        if (!cam) await v.mute()
      }
      setNote('')
      setPhase('joined')
    } catch (err) {
      toast(err.message || "Couldn't join the meeting.", 'error')
      setPhase('lobby')
    }
  }

  const toggleMic = async () => {
    const on = !mic
    setMic(on)
    if (phase === 'joined') await room.current.localParticipant.setMicrophoneEnabled(on).catch(() => setMic(!on))
    else if (preview.audio) on ? preview.audio.unmute() : preview.audio.mute()
  }
  const toggleCam = async () => {
    const on = !cam
    setCam(on)
    if (phase === 'joined') await room.current.localParticipant.setCameraEnabled(on).catch(() => setCam(!on))
    else if (preview.video) on ? preview.video.unmute() : preview.video.mute()
  }
  const toggleShare = async () => {
    const lp = room.current.localParticipant
    await lp.setScreenShareEnabled(!lp.isScreenShareEnabled).catch(() => {})
    bump((n) => n + 1)
  }
  const leave = () => {
    room.current?.disconnect()
    Object.values(tracks.current).forEach((t) => t?.stop())
    if (me) navigate('/meet')
    else setPhase('left')
  }
  const copy = async () => (await copyText(meetLink(code))) && toast('Link copied')

  if (missing) {
    return (
      <div class="call"><div class="lobby" style={{ gridTemplateColumns: 'minmax(0, 420px)' }}><div class="lobby-side">
        <Logo size={36} /><h1>This meeting doesn't exist</h1><p>Check the link, or ask the organiser for a new one.</p>
        {me && <Button onClick={() => navigate('/meet')}>Back to Meet</Button>}
      </div></div></div>
    )
  }
  if (phase === 'left') {
    return (
      <div class="call"><div class="lobby" style={{ gridTemplateColumns: 'minmax(0, 420px)' }}><div class="lobby-side">
        <Logo size={36} /><h1>You left the meeting</h1>
        <div class="row"><Button kind="primary" onClick={() => location.reload()}>Rejoin</Button></div>
      </div></div></div>
    )
  }

  if (phase !== 'joined') {
    return (
      <div class="call">
        <div class="call-top"><Logo size={26} /><span class="title">Open Suite</span></div>
        <div class="lobby">
          <div class="tile">
            {preview.video && cam ? <PreviewVideo track={preview.video} /> : <Avatar name={name || '?'} id={me?.id || name} size={96} />}
            <div class="controls">
              <button class={cx('cbtn', !mic && 'off')} onClick={toggleMic} aria-label={mic ? 'Mute microphone' : 'Unmute microphone'}>{mic ? <Mic size={20} /> : <MicOff size={20} />}</button>
              <button class={cx('cbtn', !cam && 'off')} onClick={toggleCam} aria-label={cam ? 'Turn camera off' : 'Turn camera on'}>{cam ? <Video size={20} /> : <VideoOff size={20} />}</button>
            </div>
          </div>
          <form class="lobby-side" onSubmit={join}>
            <h1>{info?.title || 'Ready to join?'}</h1>
            <p>{info ? `${info.org} · ${code}` : code}</p>
            {note && <p>{note}</p>}
            {!me && <input class="input" autofocus placeholder="Your name" value={name} maxlength={60} onInput={(e) => setName(e.target.value)} />}
            <div class="row">
              <Button kind="primary" class="btn-lg" type="submit" busy={phase === 'joining'} disabled={!name.trim() || !info}>Join now</Button>
              <Button class="btn-lg btn-ghost" icon={Link2} onClick={copy}>Copy link</Button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  const r = room.current
  const everyone = [r.localParticipant, ...r.remoteParticipants.values()]
  const camOf = (p) => {
    const pub = p.getTrackPublication(Track.Source.Camera)
    return pub && !pub.isMuted && pub.track ? pub.track : null
  }
  const micOff = (p) => {
    const pub = p.getTrackPublication(Track.Source.Microphone)
    return !pub || pub.isMuted
  }
  const shares = everyone.map((p) => ({ p, pub: p.getTrackPublication(Track.Source.ScreenShare) })).filter((x) => x.pub?.track)
  const tiles = everyone.map((p) => (
    <VideoTile key={p.identity} track={camOf(p)} name={p.name || 'Guest'} id={p.identity} muted={micOff(p)} speaking={p.isSpeaking}
      mirror={p === r.localParticipant} label={p === r.localParticipant ? 'You' : null} />
  ))
  return (
    <div class="call">
      <div class="call-top">
        <Logo size={26} />
        <span class="title ellipsis">{info?.title || 'Meeting'}</span>
        <span class="code">{code}</span>
        <span class="grow" />
        <span class="row muted"><Users size={16} />{everyone.length}</span>
      </div>
      {note && <div class="call-note">{note}</div>}
      <div class="stage">
        {shares.length > 0 ? (
          <>
            <div class="grid" style={gridStyle(1)}>
              <VideoTile screen track={shares[0].pub.track} name={shares[0].p.name} label={`${shares[0].p === r.localParticipant ? 'You are' : shares[0].p.name + ' is'} presenting`} />
            </div>
            <div class="strip">{tiles}</div>
          </>
        ) : (
          <div class="grid" style={gridStyle(tiles.length)}>{tiles}</div>
        )}
      </div>
      <div class="call-bar">
        <button class={cx('cbtn', !mic && 'off')} onClick={toggleMic} aria-label={mic ? 'Mute' : 'Unmute'} title={mic ? 'Mute' : 'Unmute'}>{mic ? <Mic size={20} /> : <MicOff size={20} />}</button>
        <button class={cx('cbtn', !cam && 'off')} onClick={toggleCam} aria-label={cam ? 'Camera off' : 'Camera on'} title={cam ? 'Camera off' : 'Camera on'}>{cam ? <Video size={20} /> : <VideoOff size={20} />}</button>
        <button class={cx('cbtn', r.localParticipant.isScreenShareEnabled && 'on')} onClick={toggleShare} aria-label="Present your screen" title="Present your screen"><MonitorUp size={20} /></button>
        <button class="cbtn" onClick={copy} aria-label="Copy invite link" title="Copy invite link"><Link2 size={20} /></button>
        <button class="cbtn leave" onClick={leave} aria-label="Leave" title="Leave"><PhoneOff size={20} /></button>
      </div>
    </div>
  )
}

function PreviewVideo({ track }) {
  const ref = useRef()
  useEffect(() => {
    track.attach(ref.current)
    return () => track.detach(ref.current)
  }, [track])
  return <video ref={ref} class="mirror" autoplay playsinline muted />
}
