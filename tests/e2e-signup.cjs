// End-to-end check of signing up on a server that gives organisations their
// own address (OS_ORG_DOMAIN_SUFFIX). A new organisation is made through the
// sign-up page; it must get its own domain, the founder's address on it, and
// nothing but its founder, and Admin → Domains must show the domain as
// included. Fails on any console error or failed request.
//
//   OS_BASE=https://office.example node tests/e2e-signup.cjs
//
// Organisations cannot be deleted, so each run leaves one behind, named
// "<OS_E2E_ORG or E2E test> <stamp>"; OS_E2E_FOUNDER_PASS sets its
// founder's password. Sign-up allows five an hour from one address.
const { connect, collect, BASE } = require('./browser.cjs')

const PREFIX = process.env.OS_E2E_ORG || 'E2E test'
const PASS = process.env.OS_E2E_FOUNDER_PASS || 'founder-' + Math.random().toString(36).slice(2, 12)

;(async () => {
  const b = await connect()
  const problems = []
  const ok = (msg) => console.log('  ok  ' + msg)
  const stamp = Date.now().toString(36)
  try {
    const page = await b.open()
    collect(page, 'founder', problems)
    await page.goto(BASE + '/signup')
    const suffix = await page.evaluate(() => fetch('/api/boot').then((r) => r.json()).then((x) => x.orgDomainSuffix))
    if (!suffix) throw new Error('this server gives organisations no address of their own (OS_ORG_DOMAIN_SUFFIX)')
    await page.waitForSelector('#signup-slug')
    await page.fill('input[placeholder="Acme Ltd"]', `${PREFIX} ${stamp}`)
    const slug = await page.inputValue('#signup-slug')
    if (!slug.endsWith(stamp)) throw new Error('the address was not made from the name: ' + slug)
    await page.waitForSelector('.field-hint:has-text("Available")')
    await page.fill('input[autocomplete=name]', 'Fran Founder')
    await page.fill('input[autocomplete=username]', 'fran')
    await page.fill('input[autocomplete=new-password]', PASS)
    if (!(await page.textContent('.input-group .suffix.shrink >> nth=1')).includes(`@${slug}.${suffix}`)) throw new Error('the address shown is not on the new domain')
    await page.click('button[type=submit]')
    await page.waitForSelector('.rail, .form-error', { timeout: 60000 })
    if (await page.$('.form-error')) throw new Error('sign-up refused: ' + (await page.textContent('.form-error')))
    const me = await page.evaluate(() => fetch('/api/boot').then((r) => r.json()))
    const domain = `${slug}.${suffix}`
    if (me.user.email !== `fran@${domain}`) throw new Error('the founder has the address ' + me.user.email)
    if (me.people.length !== 1 || me.docs.length !== 0 || me.groups.length !== 0) throw new Error('the new organisation is not empty')
    if (me.org.mailDomains?.[0] !== domain) throw new Error('new people would not get addresses on ' + domain)
    ok(`signed up as ${me.user.email}, with nothing but the founder`)
    await page.goto(BASE + '/admin/domains')
    await page.waitForSelector(`.card h2:text-is("${domain}")`)
    await page.waitForSelector('.badge:text-is("Included")')
    ok('Admin → Domains shows its own domain as included')

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
