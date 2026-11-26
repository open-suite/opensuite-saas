// Draws the profile pictures of the story's people (server/demo/<key>.png)
// from the illustrations in web/scripts/avatars/*.svg: our own artwork, not
// photographs of anyone. Run it again after changing one:
//
//   PLAYWRIGHT_CORE=... node web/scripts/demo-avatars.cjs
//
// Needs the same Chrome with remote debugging that the checks in tests/ use.
const fs = require('fs')
const path = require('path')
const { connect } = require('../../tests/browser.cjs')
const SRC = path.join(__dirname, 'avatars')
const OUT = path.join(__dirname, '../../server/demo')
const SIZE = 256

async function main() {
  const b = await connect()
  try {
    const page = await b.open({ width: 600, height: 600 })
    for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.svg')).sort()) {
      const svg = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/width="\d+" height="\d+"/, `width="${SIZE}" height="${SIZE}"`)
      await page.setContent(`<body style="margin:0"><div id="shot" style="width:${SIZE}px;height:${SIZE}px">${svg}</div></body>`)
      const name = file.replace(/\.svg$/, '.png')
      fs.writeFileSync(path.join(OUT, name), await page.locator('#shot').screenshot({ type: 'png' }))
      console.log(name)
    }
  } finally {
    await b.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
