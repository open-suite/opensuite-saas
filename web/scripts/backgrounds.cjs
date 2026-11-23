// Draws the built-in call backgrounds (web/public/assets/bg/*.webp). They are
// our own artwork, made here from gradients and light so there is nothing to
// license. Run it again after changing a scene, and rename the folder in
// lib/backdrop.js if the files change, because /assets/ is cached for good.
//
//   PLAYWRIGHT_CORE=... node web/scripts/backgrounds.cjs
//
// Needs the same Chrome with remote debugging that the checks in tests/ use.
const fs = require('fs')
const path = require('path')
const { connect } = require('../../tests/browser.cjs')
const OUT = path.join(__dirname, '../public/assets/bg')

// Runs in the page: returns { name: dataURL }.
function draw() {
  const W = 1280, H = 720
  const scenes = {}
  const make = (name, paint) => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d')
    paint(g)
    // A little grain: smooth gradients band badly once video compression gets at them.
    const img = g.getImageData(0, 0, W, H)
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 7
      img.data[i] += n
      img.data[i + 1] += n
      img.data[i + 2] += n
    }
    g.putImageData(img, 0, 0)
    scenes[name] = c.toDataURL('image/webp', 0.9)
  }
  const fill = (g, color) => { g.filter = 'none'; g.fillStyle = color; g.fillRect(0, 0, W, H) }
  const glow = (g, x, y, r, color, blur = 90) => {
    g.filter = `blur(${blur}px)`
    g.fillStyle = color
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
    g.filter = 'none'
  }
  const linear = (g, x0, y0, x1, y1, stops) => {
    const l = g.createLinearGradient(x0, y0, x1, y1)
    stops.forEach(([at, c]) => l.addColorStop(at, c))
    g.filter = 'none'
    g.fillStyle = l
    g.fillRect(0, 0, W, H)
  }
  const vignette = (g, strength) => {
    const r = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75)
    r.addColorStop(0, 'rgba(0,0,0,0)')
    r.addColorStop(1, `rgba(0,0,0,${strength})`)
    g.fillStyle = r
    g.fillRect(0, 0, W, H)
  }

  // A dark studio wall with one soft light.
  make('studio', (g) => {
    linear(g, 0, 0, 0, H, [[0, '#27323f'], [1, '#141b24']])
    glow(g, W * 0.3, H * 0.25, 330, 'rgba(120,150,190,0.36)', 130)
    glow(g, W * 0.82, H * 0.8, 260, 'rgba(60,80,110,0.3)', 120)
    vignette(g, 0.42)
  })
  // A pale wall in daylight, with the light of a window falling across it.
  make('daylight', (g) => {
    linear(g, 0, 0, W, H, [[0, '#f1ece4'], [1, '#d9d2c7']])
    g.save()
    g.translate(W * 0.62, -80)
    g.rotate(0.42)
    g.filter = 'blur(26px)'
    g.fillStyle = 'rgba(255,250,238,0.72)'
    for (let i = 0; i < 4; i++) g.fillRect(i * 150, 0, 96, H * 1.6)
    g.restore()
    glow(g, W * 0.12, H * 0.9, 300, 'rgba(150,140,125,0.28)', 140)
    vignette(g, 0.12)
  })
  // Evening sky.
  make('dusk', (g) => {
    linear(g, 0, 0, 0, H, [[0, '#2a2356'], [0.55, '#8a3f6e'], [1, '#f0895a']])
    glow(g, W * 0.75, H * 0.92, 380, 'rgba(255,190,110,0.55)', 150)
    glow(g, W * 0.15, H * 0.1, 320, 'rgba(70,60,160,0.5)', 150)
    vignette(g, 0.25)
  })
  // Deep water.
  make('ocean', (g) => {
    linear(g, 0, 0, W, H, [[0, '#0b3a5a'], [1, '#0a6f7d']])
    glow(g, W * 0.2, H * 0.2, 340, 'rgba(60,170,210,0.45)', 150)
    glow(g, W * 0.85, H * 0.75, 380, 'rgba(40,200,170,0.38)', 160)
    glow(g, W * 0.55, H * 1.05, 300, 'rgba(8,30,60,0.6)', 140)
    vignette(g, 0.3)
  })
  // Lights out of focus.
  make('lights', (g) => {
    linear(g, 0, 0, 0, H, [[0, '#15131f'], [1, '#231a2c']])
    let seed = 11
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    const tints = ['255,196,120', '255,150,110', '255,222,170', '170,190,255', '255,170,200']
    for (let i = 0; i < 46; i++) {
      const x = rnd() * W, y = rnd() * H * 0.9, r = 18 + rnd() * 52, a = 0.1 + rnd() * 0.26
      g.filter = 'blur(5px)'
      g.fillStyle = `rgba(${tints[i % tints.length]},${a})`
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fill()
    }
    g.filter = 'none'
    vignette(g, 0.45)
  })
  // Our own colours: night blue with a warm glow.
  make('ember', (g) => {
    linear(g, 0, 0, W, H, [[0, '#0d1b2e'], [1, '#13263f']])
    glow(g, W * 0.88, H * 0.95, 360, 'rgba(240,96,48,0.55)', 160)
    glow(g, W * 0.1, H * 0.05, 300, 'rgba(60,120,230,0.42)', 150)
    vignette(g, 0.3)
  })
  return scenes
}

;(async () => {
  const b = await connect()
  try {
    const page = await b.open()
    const scenes = await page.evaluate(draw)
    fs.mkdirSync(OUT, { recursive: true })
    for (const [name, url] of Object.entries(scenes)) {
      const file = path.join(OUT, name + '.webp')
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
      console.log(file, Math.round(fs.statSync(file).size / 1024) + ' KB')
    }
  } finally {
    await b.close()
  }
})()
