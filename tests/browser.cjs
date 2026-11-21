// Shared browser plumbing for the end-to-end and performance checks.
//
// The checks attach to an already running Chrome over the DevTools protocol
// (OS_CDP, default http://127.0.0.1:9222) and work in background tabs with
// their own storage, so several test users can be signed in side by side and
// no window is ever brought to the front. Start one with:
//   chrome --remote-debugging-port=9222
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core')

exports.BASE = (process.env.OS_BASE || 'https://office.demo.opensuite.online').replace(/\/$/, '')

exports.connect = async function connect() {
  const browser = await chromium.connectOverCDP(process.env.OS_CDP || 'http://127.0.0.1:9222')
  const cdp = await browser.newBrowserCDPSession()
  const targets = []
  const contexts = []
  const pages = []

  async function open({ width = 1440, height = 900 } = {}) {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
    contexts.push(browserContextId)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, background: true, focus: false })
    targets.push(targetId)
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (page.isClosed()) continue
          const session = await ctx.newCDPSession(page)
          try {
            const { targetInfo } = await session.send('Target.getTargetInfo')
            if (targetInfo.targetId === targetId) {
              await page.setViewportSize({ width, height })
              pages.push(page)
              return page
            }
          } finally {
            await session.detach().catch(() => {})
          }
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('background tab did not attach')
  }

  async function close() {
    for (const targetId of targets) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    for (const browserContextId of contexts) await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
    await browser.close()
  }

  return { open, close, pages }
}

exports.login = async function login(page, user, pass) {
  await page.goto(exports.BASE + '/')
  await page.waitForSelector('.auth-card, .rail')
  if (await page.$('.rail')) return
  await page.fill('input[autocomplete=username]', user)
  await page.fill('input[type=password]', pass)
  await page.click('button[type=submit]')
  await page.waitForSelector('.rail, input[autocomplete=new-password]')
}

// A synthetic camera and microphone, so calls can be tested end to end
// without ever opening a real device.
exports.fakeMedia = () => {
  navigator.mediaDevices.getUserMedia = async (c) => {
    const tracks = []
    if (c.video) {
      const cv = document.createElement('canvas')
      cv.width = 640
      cv.height = 360
      const g = cv.getContext('2d')
      let t = 0
      setInterval(() => {
        g.fillStyle = `hsl(${(t += 4) % 360} 70% 45%)`
        g.fillRect(0, 0, 640, 360)
      }, 100)
      tracks.push(...cv.captureStream(15).getVideoTracks())
    }
    if (c.audio) {
      const ac = new AudioContext()
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      const dst = ac.createMediaStreamDestination()
      gain.gain.value = 0.02
      osc.connect(gain).connect(dst)
      osc.start()
      tracks.push(...dst.stream.getAudioTracks())
    }
    return new MediaStream(tracks)
  }
}

// collect records everything that should never happen during a run.
exports.collect = function collect(page, name, problems) {
  page.on('console', (m) => m.type() === 'error' && problems.push(`${name} console: ${m.text()}`))
  page.on('pageerror', (e) => problems.push(`${name} error: ${e.message}`))
  page.on('response', (r) => r.status() >= 400 && problems.push(`${name} ${r.status()} ${r.url().slice(0, 140)}`))
}
