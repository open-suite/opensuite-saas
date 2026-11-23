// Call backgrounds, checked on the pictures themselves: the camera preview is
// read back pixel by pixel to see that the background was blurred or replaced
// and that the person was not.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/e2e-backdrop.cjs
//
// The camera is synthetic. By default it shows a busy checked wall and nobody,
// which is enough to prove the background is blurred and replaced. If
// OS_PORTRAIT names a landscape photo of someone at a desk (wall in the top
// left corner, a person in the middle), that photo is the camera instead and
// the check also proves the person is left alone. Set OS_SHOTS to a directory
// to keep pictures of each effect; that is how edge quality is judged.
// Where the video engine runs (not OS_E2E_NO_CHAT), a colleague also joins
// and must receive the processed picture, not the raw camera.
const fs = require('fs')
const path = require('path')
const { connect, login, collect, BASE, remember } = require('./browser.cjs')

const { state } = remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS')
const SHOTS = process.env.OS_SHOTS
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const portrait = process.env.OS_PORTRAIT ? 'data:image/jpeg;base64,' + fs.readFileSync(process.env.OS_PORTRAIT).toString('base64') : null

// A camera that shows a checked wall with (optionally) a person in front of
// it, swaying a little, at thirty frames a second. Time is kept by passing
// messages, because a tab nobody is looking at slows its own timers down.
function fakeCamera(portrait) {
  let person = null
  if (portrait) {
    person = new Image()
    person.src = portrait
  }
  navigator.mediaDevices.getUserMedia = async (c) => {
    const tracks = []
    if (c.video) {
      const cv = document.createElement('canvas')
      cv.width = 1280
      cv.height = 720
      const g = cv.getContext('2d')
      let t = 0
      const paint = () => {
        t++
        if (person?.complete && person.naturalWidth) {
          // The photo fills the frame, as a camera would, and drifts a little.
          const scale = Math.max(1280 / person.naturalWidth, 720 / person.naturalHeight) * 1.04
          const w = person.naturalWidth * scale, h = person.naturalHeight * scale
          g.drawImage(person, (1280 - w) / 2 + Math.sin(t / 30) * 14, (720 - h) / 2, w, h)
          return
        }
        for (let y = 0; y < 720; y += 40) for (let x = 0; x < 1280; x += 40) {
          g.fillStyle = (x / 40 + y / 40) % 2 ? '#d9c8a0' : '#35618f'
          g.fillRect(x, y, 40, 40)
        }
      }
      paint()
      // Messages are delivered at full speed where timers are not.
      const clock = new MessageChannel()
      let last = performance.now()
      clock.port1.onmessage = () => {
        if (performance.now() - last >= 33) { last = performance.now(); paint() }
        clock.port2.postMessage(0)
      }
      clock.port2.postMessage(0)
      tracks.push(...cv.captureStream(30).getVideoTracks())
    }
    if (c.audio) {
      const ac = new AudioContext()
      const dst = ac.createMediaStreamDestination()
      const gain = ac.createGain()
      gain.gain.value = 0.001
      const osc = ac.createOscillator()
      osc.connect(gain).connect(dst)
      osc.start()
      tracks.push(...dst.stream.getAudioTracks())
    }
    return new MediaStream(tracks)
  }
}

// look reads the picture a <video> is showing: the average colour and the
// amount of fine detail in the top left corner (wall), and the average colour
// of the middle (the person's face, when there is one).
const look = (page, selector) => page.evaluate((selector) => {
  const v = document.querySelector(selector)
  if (!v || !v.videoWidth) return null
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(v, 0, 0, 320, 180)
  const area = (x, y, w, h) => {
    const d = g.getImageData(x, y, w, h).data
    const mean = [0, 0, 0]
    const steps = []
    for (let i = 0; i < d.length; i += 4) {
      mean[0] += d[i]; mean[1] += d[i + 1]; mean[2] += d[i + 2]
      if (i >= 4) steps.push(Math.abs(d[i] - d[i - 4]))
    }
    const n = d.length / 4
    // detail: how hard the sharpest edges are (the mean of the steepest
    // twentieth of the steps between neighbouring pixels). Blur softens
    // edges without removing them, so an average over every step hides it.
    steps.sort((a, b) => b - a)
    const top = steps.slice(0, Math.ceil(steps.length / 20))
    return { rgb: mean.map((m) => Math.round(m / n)), detail: top.reduce((s, v) => s + v, 0) / top.length }
  }
  return { wall: area(4, 4, 70, 50), face: area(140, 50, 40, 40), frames: v.getVideoPlaybackQuality().totalVideoFrames }
}, selector)
const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

;(async () => {
  const b = await connect()
  const problems = []
  const created = []
  const ok = (msg) => console.log('  ok  ' + msg)
  let A
  try {
    A = await b.open()
    await A.addInitScript(fakeCamera, portrait)
    collect(A, 'admin', problems)
    A.on('console', (m) => m.type() === 'warning' && /backdrop/.test(m.text()) && problems.push('admin warning: ' + m.text().slice(0, 400)))
    await login(A, ADMIN.user, ADMIN.pass)
    await A.evaluate(() => localStorage.removeItem('os:backdrop'))
    const code = await A.evaluate(async () => {
      const res = await fetch('/api/meet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Background check' }) })
      return (await res.json()).code
    })
    created.push('/api/meet/' + code)
    const mine = '.lobby .tile video'
    const until = async (what, test, selector = mine, page = A) => {
      let seen
      for (let i = 0; i < 60; i++) {
        seen = await look(page, selector)
        if (seen && test(seen)) return seen
        await page.waitForTimeout(250)
      }
      throw new Error(what + ': ' + JSON.stringify(seen))
    }
    const shot = async (name) => SHOTS && A.locator('.lobby .tile').screenshot({ path: path.join(SHOTS, name + '.png') })

    await A.goto(BASE + '/meet/' + code)
    await A.waitForSelector(mine)
    const raw = await until('camera preview', (s) => portrait ? s.frames > 5 : s.wall.detail > 60)
    const rate = async () => {
      const a = await look(A, mine)
      const t = Date.now()
      await A.waitForTimeout(4000)
      return ((await look(A, mine)).frames - a.frames) / ((Date.now() - t) / 1000)
    }
    const plain = await rate() // what this camera delivers with no effect
    await shot('none')
    ok('lobby: the camera preview shows the room as it is')
    // With a photo for a camera the wall has no pattern to lose, so there the
    // check is that the engine is running and the person is untouched.
    const running = () => A.waitForFunction(() => window.__backdrop?.ms > 0, null, { timeout: 20000 }).then(() => A.waitForTimeout(900)).then(() => look(A, mine))
    const same = (now, what) => { if (portrait && far(now.face, raw.face) > 60) throw new Error(what + ': ' + JSON.stringify({ raw: raw.face, now: now.face })) }

    const started = Date.now()
    await A.click('.fx-tile[aria-label="Blur"]')
    const blurred = portrait ? await running() : await until('blur', (s) => s.wall.detail < raw.wall.detail * 0.35)
    console.log(`info  first effect on screen ${Date.now() - started} ms after the click, engine download included`)
    same(blurred, 'blur changed the person')
    await shot('blur')
    ok('blur: ' + (portrait ? 'the person is untouched' : 'the wall loses its detail'))

    await A.click('.fx-tile[aria-label="Blur slightly"]')
    if (portrait) await A.waitForTimeout(900)
    else await until('slight blur', (s) => s.wall.detail > blurred.wall.detail * 1.3 && s.wall.detail < raw.wall.detail * 0.8)
    await shot('soft')
    ok('slight blur' + (portrait ? '' : ' sits between the two'))

    await A.click('.fx-tile[aria-label="Ember"]')
    const ember = await until('scene', (s) => s.wall.rgb[0] < 60 && s.wall.rgb[2] > s.wall.rgb[0] && s.wall.detail < 14) // night blue, top left
    same(ember, 'the scene covered the person')
    await shot('scene')
    ok('scene: the wall is replaced by the picture' + (portrait ? ', the person stays' : ''))

    await A.click('.fx-tile[aria-label="Daylight"]')
    same(await until('second scene', (s) => s.wall.rgb[0] > 190 && s.wall.rgb[2] > 170 && s.wall.detail < 14), 'the second scene covered the person')
    await shot('scene-light')
    ok('switching scenes needs no restart')

    // Frames keep coming at the camera's own rate.
    const fps = await rate()
    const timing = await A.evaluate(() => window.__backdrop)
    console.log(`info  ${fps.toFixed(1)} frames a second with a scene on, ${plain.toFixed(1)} with none; ${timing ? `${timing.ms.toFixed(1)} ms a frame, of which ${timing.segment.toFixed(1)} ms finding the person` : 'no timing'}`)
    if (fps < plain * 0.85) throw new Error(`${fps.toFixed(1)} frames a second with a scene on, ${plain.toFixed(1)} without`)
    ok('no frames are lost to the effect')

    // A picture of the person's own.
    const picked = A.waitForEvent('filechooser')
    await A.click('.fx-tile[aria-label="Use your own picture"]')
    const tmp = path.join(require('os').tmpdir(), `backdrop-${Date.now()}.png`)
    await A.evaluate(async () => {
      const c = new OffscreenCanvas(640, 360)
      const g = c.getContext('2d')
      g.fillStyle = '#16a34a'
      g.fillRect(0, 0, 640, 360)
      const blob = await c.convertToBlob({ type: 'image/png' })
      return [...new Uint8Array(await blob.arrayBuffer())]
    }).then((bytes) => fs.writeFileSync(tmp, Buffer.from(bytes)))
    await (await picked).setFiles(tmp)
    fs.unlinkSync(tmp)
    await until('own picture', (s) => s.wall.rgb[1] > 130 && s.wall.rgb[0] < 80 && s.wall.rgb[2] < 120)
    await shot('own')
    ok('own picture: chosen from the device and used at once')

    await A.reload()
    await A.waitForSelector(mine)
    await until('remembered', (s) => s.wall.rgb[1] > 130 && s.wall.rgb[0] < 80)
    if (!(await A.$('.fx-tile.on[aria-label="Your picture"]'))) throw new Error('the chooser does not show the remembered choice')
    ok('the choice and the picture are remembered on this device')

    if (!process.env.OS_E2E_NO_CHAT) {
      await A.click('.fx-tile[aria-label="Ember"]')
      await until('scene before joining', (s) => s.wall.rgb[0] < 60 && s.wall.rgb[2] > s.wall.rgb[0])
      await A.click('text=Join now')
      await A.waitForSelector('.call-bar', { timeout: 15000 })
      const B = await b.open()
      await B.addInitScript(fakeCamera, null)
      collect(B, 'colleague', problems)
      await login(B, state.colleague.user, COLLEAGUE_PASS)
      await B.goto(BASE + '/meet/' + code)
      await B.click('text=Join now')
      await B.waitForSelector('.call-bar', { timeout: 15000 })
      await B.waitForFunction(() => document.querySelectorAll('.tile video').length === 2, null, { timeout: 20000 })
      const theirs = '.tile:not(:has(.mirror)) video' // the other person's tile is not mirrored
      await until('what the colleague receives', (s) => s.wall.rgb[0] < 70 && s.wall.rgb[2] > s.wall.rgb[0] && s.wall.detail < 20, theirs, B)
      ok('in a call: the colleague receives the scene, never the real wall')
      await A.click('.call-bar [aria-label="Background"]')
      await A.waitForSelector('.fx-panel')
      if (SHOTS) await A.screenshot({ path: path.join(SHOTS, 'call.png') })
      await A.click('.fx-panel .fx-tile[aria-label="No effect"]')
      await until('effect off for the colleague', (s) => portrait ? far(s.wall.rgb, raw.wall.rgb) < 60 : s.wall.detail > 60, theirs, B)
      ok('in a call: the chooser in the bar switches it off for everyone')
      await A.click('.fx-panel .fx-tile[aria-label="Blur"]')
      await until('blur for the colleague', (s) => (portrait || s.wall.detail < 45) && s.wall.rgb[0] > 70, theirs, B)
      if (!(await A.$('.fx-panel .fx-tile.on[aria-label="Blur"]'))) throw new Error('the chooser does not show blur as chosen')
      ok('in a call: and on again, with no camera restart')
    } else {
      await A.click('.fx-tile[aria-label="No effect"]')
      await until('off', (s) => portrait ? far(s.wall.rgb, raw.wall.rgb) < 40 : s.wall.detail > raw.wall.detail * 0.8)
      ok('no effect: the room is back')
    }
    await A.evaluate(() => { localStorage.removeItem('os:backdrop'); indexedDB.databases?.() })

    const real = problems.filter((p) => !(process.env.OS_E2E_NO_CHAT && /_matrix|\/api\/chat|\/lk\/|Failed to load resource/.test(p)))
    if (real.length) throw new Error('problems during the run:\n' + real.join('\n'))
    console.log('all good')
  } catch (e) {
    if (SHOTS && A) await A.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {})
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    if (problems.length) console.error('problems so far:\n' + problems.slice(0, 10).join('\n'))
    process.exitCode = 1
  } finally {
    if (A) await A.evaluate(async (made) => { for (const p of made) await fetch(p, { method: 'DELETE' }) }, created).catch(() => {})
    await b.close()
  }
})()
