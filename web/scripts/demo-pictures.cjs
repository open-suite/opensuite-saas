// Draws the demo organisation's pictures and fact sheet (server/demo/*.png,
// *.pdf): a screenshot of the fictional product, its logo, and a one-page
// PDF. They are our own artwork, laid out here in HTML and captured by the
// browser, so there is nothing to license. Run it again after changing one:
//
//   PLAYWRIGHT_CORE=... node web/scripts/demo-pictures.cjs
//
// Needs the same Chrome with remote debugging that the checks in tests/ use.
const fs = require('fs')
const path = require('path')
const { connect } = require('../../tests/browser.cjs')
const OUT = path.join(__dirname, '../../server/demo')

// Single quotes only: this goes inside style="..." attributes.
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Arial, sans-serif"
const ink = '#2b1408', accent = '#ff5a1f', soft = '#ffe6da'

// The loom mark: warp threads with one weft woven through.
const mark = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${accent}"/>
  ${[14, 23, 32, 41, 50].map((x) => `<rect x="${x - 2}" y="12" width="4" height="40" rx="2" fill="#fff" opacity="0.9"/>`).join('')}
  <path d="M8 30 C 14 24, 18 36, 23 30 S 32 24, 32 30 S 41 36, 41 30 S 50 24, 56 30" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>
</svg>`

const logo = `<div id="shot" style="width:900px;height:360px;display:flex;align-items:center;justify-content:center;gap:36px;background:#fff8f4;font-family:${font}">
  ${mark(180)}
  <div><div style="font-size:150px;font-weight:800;letter-spacing:-6px;color:${ink};line-height:1">Loom</div>
  <div style="font-size:26px;color:#8a6453;margin-top:10px;letter-spacing:0.5px">by Analytical Engines</div></div>
</div>`

// A week of the planner: benches down the side, jobs as bars, one running late.
function planner() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  const rows = [
    ['Cutting table', [[0, 1.5, 'Oak chairs ×6', '#0e8a5f'], [1.6, 1.2, 'Bench seat', '#1269e8'], [3, 1.8, 'Hotel headboards', '#7c3aed']]],
    ['Upholstery 1', [[0, 2.2, 'Wing chair, Shah', '#c2410c'], [2.3, 2.6, 'Café banquette', '#0891b2']]],
    ['Upholstery 2', [[0.4, 1.4, 'Footstools ×4', '#1269e8'], [1.9, 1.9, 'Sofa reupholster', '#dc2626', true], [3.9, 1.1, 'Ottoman', '#a16207']]],
    ['Sewing', [[0, 1, 'Cushions ×20', '#4f46e5'], [1.1, 2, 'Curtains, Hale & Co', '#0e8a5f'], [3.2, 1.2, 'Seat pads', '#be185d']]],
    ['Finishing', [[0.6, 1.3, 'Oak chairs ×6', '#0e8a5f'], [2.2, 1.4, 'Wing chair, Shah', '#c2410c'], [3.8, 1.2, 'Bench seat', '#1269e8']]],
    ['Dispatch', [[1.2, 0.6, 'Footstools', '#1269e8'], [3, 0.6, 'Oak chairs', '#0e8a5f'], [4.2, 0.7, 'Wing chair', '#c2410c']]],
  ]
  const dayW = 172, left = 170
  const bar = ([at, len, label, color, late]) => `<div style="position:absolute;left:${left + at * dayW + 4}px;width:${len * dayW - 8}px;top:16px;height:56px;border-radius:9px;background:${late ? '#fde2e1' : color + '22'};border:2px solid ${late ? '#dc2626' : color};color:${late ? '#991b1b' : ink};font-size:14px;font-weight:600;display:flex;align-items:center;padding:0 10px;white-space:nowrap;overflow:hidden">${late ? '⚠ ' : ''}${label}${late ? ' · 1 day late' : ''}</div>`
  return `<div id="shot" style="width:1200px;background:#fff;font-family:${font};color:${ink};display:flex;flex-direction:column">
    <div style="height:64px;display:flex;align-items:center;gap:14px;padding:0 24px;border-bottom:1px solid #f1cdbb">${mark(34)}<b style="font-size:20px">Loom</b>
      <span style="margin-left:24px;color:#8a6453">Shah &amp; Daughters Upholstery</span><span style="flex:1"></span>
      <span style="background:${soft};padding:7px 14px;border-radius:999px;font-size:14px">This week</span><span style="background:${accent};color:#fff;padding:8px 16px;border-radius:9px;font-weight:600;font-size:14px">+ New job</span></div>
    <div style="display:flex;padding:18px 24px 6px;margin-left:${left}px;gap:0">${days.map((d, i) => `<div style="width:${dayW}px;font-weight:600;color:#8a6453;font-size:15px">${d} ${17 + i}</div>`).join('')}</div>
    <div style="padding:0 24px">${rows.map(([name, jobs]) => `<div style="position:relative;height:88px;border-top:1px solid #f6e3d8"><div style="position:absolute;left:0;top:34px;font-weight:600;font-size:15px">${name}</div>${jobs.map(bar).join('')}</div>`).join('')}</div>
    <div style="margin:18px 24px 0;padding:16px 18px;border-radius:12px;background:#fde2e1;color:#991b1b;font-size:15px;display:flex;gap:10px;align-items:center"><b>Sofa reupholster is a day late.</b> Ottoman and Dispatch on Friday move with it. Tell the customer?</div>
    <div style="display:flex;gap:16px;margin:18px 24px 24px">
      ${[['Jobs this week', '17'], ['On time', '16 of 17'], ['Bench load', '84%']].map(([k, v]) => `<div style="flex:1;border:1px solid #f1cdbb;border-radius:12px;padding:18px"><div style="color:#8a6453;font-size:14px">${k}</div><div style="font-size:40px;font-weight:800;margin-top:6px">${v}</div></div>`).join('')}
    </div>
  </div>`
}

const factSheet = `<html><head><style>
  @page { size: A4; margin: 0 }
  body { margin: 0; font-family: ${font}; color: ${ink} }
  .page { width: 210mm; height: 297mm; box-sizing: border-box; padding: 22mm 20mm; display: flex; flex-direction: column; gap: 9mm; background: #fff8f4 }
  h1 { font-size: 44px; margin: 0; letter-spacing: -1.5px }
  h2 { font-size: 18px; margin: 0 0 3mm; color: ${accent}; text-transform: uppercase; letter-spacing: 1px }
  p, li { font-size: 14.5px; line-height: 1.55; margin: 0 }
  ul { margin: 0; padding-left: 18px }
  .cols { display: flex; gap: 10mm } .cols > div { flex: 1 }
  .box { background: #fff; border: 1px solid #f1cdbb; border-radius: 10px; padding: 6mm }
</style></head><body><div class="page">
  <div style="display:flex;align-items:center;gap:18px">${mark(70)}<div><h1>Loom</h1><p style="color:#8a6453">The production planner for workshops that build to order</p></div></div>
  <p style="font-size:17px">Loom shows what every bench and every person in your workshop is doing this week, and what happens when one job runs late. It replaces the whiteboard and the spreadsheet with one live plan the whole team can see, on the office computer and the tablet on the workshop floor.</p>
  <div class="cols">
    <div class="box"><h2>What it does</h2><ul><li>Drag jobs onto people and machines</li><li>See knock-on delays before your customer does</li><li>Import your orders from a spreadsheet in minutes</li><li>Share a delivery date with a customer by link</li></ul></div>
    <div class="box"><h2>Who it is for</h2><ul><li>Upholsterers, joiners, sign makers and print shops</li><li>Teams of 3 to 25 people</li><li>Owners who plan on paper today</li></ul></div>
  </div>
  <div class="box"><h2>From the pilot</h2><p>“We used to find out a job was late when the customer rang. Now we see it on Monday and ring them first.”</p><p style="color:#8a6453;margin-top:2mm">Priya Shah, Shah &amp; Daughters Upholstery, Leicester</p></div>
  <div class="cols">
    <div class="box"><h2>Pricing</h2><p>One plan per workshop, billed monthly. 30-day trial, no card needed.</p></div>
    <div class="box"><h2>Facts</h2><p>14 pilot workshops, 3 months in daily use. Hosted in Europe. Made in London by Analytical Engines.</p></div>
  </div>
  <p style="margin-top:auto;color:#8a6453">Analytical Engines · London · Loom 1.0</p>
</div></body></html>`

async function main() {
  const b = await connect()
  try {
    const page = await b.open({ width: 1400, height: 1100 })
    for (const [name, html] of [['loom-logo.png', logo], ['loom-planner.png', planner()]]) {
      await page.setContent(`<body style="margin:0">${html}</body>`)
      fs.writeFileSync(path.join(OUT, name), await page.locator('#shot').screenshot({ type: 'png' }))
      console.log(name)
    }
    await page.setContent(factSheet)
    const cdp = await page.context().newCDPSession(page)
    const { data } = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true })
    fs.writeFileSync(path.join(OUT, 'loom-fact-sheet.pdf'), Buffer.from(data, 'base64'))
    console.log('loom-fact-sheet.pdf')
  } finally {
    await b.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
