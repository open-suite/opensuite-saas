// End-to-end check of signing up on a server that gives organisations their
// own address (OS_ORG_DOMAIN_SUFFIX). Two new organisations are made through
// the sign-up page: one with example data, one empty. The first must get
// its own domain, the founder's address on it, two example colleagues with
// pictures, the story's files and documents, a welcome in the inbox and the
// Sales shared inbox; then "Remove example data" must leave the founder with
// what they made and nothing else. The second must start with nothing but
// its founder and its domain. Fails on any console error or failed request.
//
//   OS_BASE=https://office.example node tests/e2e-signup.cjs
//
// Organisations cannot be deleted, so each run leaves two behind, named
// "<OS_E2E_ORG or E2E test> <stamp> (example|empty)". With OS_E2E_KEEP=1 the
// example data is left in place to look at, and OS_E2E_FOUNDER_PASS sets the
// founders' password. Sign-up allows five an hour from one address.
const { connect, collect, BASE } = require('./browser.cjs')

const PREFIX = process.env.OS_E2E_ORG || 'E2E test'
const KEEP = !!process.env.OS_E2E_KEEP
const PASS = process.env.OS_E2E_FOUNDER_PASS || 'example-founder-' + Math.random().toString(36).slice(2, 10)

;(async () => {
  const b = await connect()
  const problems = []
  const ok = (msg) => console.log('  ok  ' + msg)
  const stamp = Date.now().toString(36)
  try {
    const signup = async (page, kind) => {
      await page.goto(BASE + '/signup')
      const suffix = await page.evaluate(() => fetch('/api/boot').then((r) => r.json()).then((x) => x.orgDomainSuffix))
      if (!suffix) throw new Error('this server gives organisations no address of their own (OS_ORG_DOMAIN_SUFFIX)')
      await page.waitForSelector('#signup-slug')
      await page.fill('input[placeholder="Acme Ltd"]', `${PREFIX} ${stamp} (${kind})`)
      const slug = await page.inputValue('#signup-slug')
      if (!slug.endsWith(`${stamp}-${kind}`)) throw new Error('the address was not made from the name: ' + slug)
      await page.waitForSelector('.field-hint:has-text("Available")')
      await page.fill('input[autocomplete=name]', 'Fran Founder')
      await page.fill('input[autocomplete=username]', 'fran')
      await page.fill('input[autocomplete=new-password]', PASS)
      if (!(await page.textContent('.input-group .suffix.shrink >> nth=1')).includes(`@${slug}.${suffix}`)) throw new Error('the address shown is not on the new domain')
      await page.click(kind === 'example' ? '.start-choice label:has-text("Example data")' : '.start-choice label:has-text("An empty organisation")')
      const started = Date.now()
      await page.click('button[type=submit]')
      await page.waitForSelector('.rail, .form-error', { timeout: 120000 })
      if (await page.$('.form-error')) throw new Error('sign-up refused: ' + (await page.textContent('.form-error')))
      const me = await page.evaluate(() => fetch('/api/boot').then((r) => r.json()))
      if (me.user.email !== `fran@${slug}.${suffix}`) throw new Error('the founder has the address ' + me.user.email)
      ok(`${kind}: signed up as ${me.user.email} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      return { me, domain: slug + '.' + suffix }
    }

    // With example data.
    const A = await b.open()
    collect(A, 'example', problems)
    const { me, domain } = await signup(A, 'example')
    const examples = me.people.filter((p) => p.example)
    if (examples.length !== 2 || examples.some((p) => !p.photo || !p.email.endsWith('@' + domain))) throw new Error('example colleagues: ' + JSON.stringify(examples))
    if (me.org.limits.maxUsers !== 5 || me.org.plan !== 'free') throw new Error('not a Free organisation: ' + JSON.stringify(me.org))
    await A.goto(BASE + '/admin/people')
    await A.waitForSelector('.badge:text-is("Example") >> nth=1')
    await A.waitForSelector('text=/1 of 5 people/', { timeout: 10000 }).catch(() => { throw new Error('example colleagues are counted against the plan') })
    await A.waitForFunction(() => [...document.querySelectorAll('img.avatar-photo')].filter((i) => i.complete && i.naturalWidth > 0).length >= 2)
    ok('two example colleagues with pictures, not counted against the plan')
    await A.goto(BASE + '/files/shared') // the colleagues' folder, shared with the organisation
    await A.waitForSelector('text=Loom launch')
    const titles = me.docs.map((d) => d.title)
    for (const t of ['Loom 1.0 launch brief', 'Launch budget', 'Loom launch plan', 'Loom 1.0 release checklist']) {
      if (!titles.includes(t)) throw new Error('missing document ' + t + ': ' + titles.join(', '))
    }
    ok('the story\'s files and documents are there')
    if (me.mail.ready) {
      await A.goto(BASE + '/mail')
      await A.waitForSelector('.mrow >> text=Welcome to the launch team', { timeout: 20000 })
      await A.waitForSelector('.mail-side >> text=Sales')
      ok('a welcome in the inbox, and the Sales shared inbox beside it')
    }
    if (!KEEP) {
      // Something of the founder's own, filed in an example folder.
      const folder = await A.evaluate(() => fetch('/api/files').then((r) => r.json()).then((x) => x.nodes.find((n) => n.name === 'Loom launch').id))
      const mine = await A.evaluate((folder) => fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'doc', title: 'My own plan', folder }) }).then((r) => r.json()), folder)
      await A.goto(BASE + '/admin/organisation')
      await A.click('button:has-text("Remove example data")')
      await A.click('.modal button:has-text("Remove")')
      await A.waitForSelector('.modal', { state: 'detached', timeout: 120000 })
      const after = await A.evaluate(() => fetch('/api/boot').then((r) => r.json()))
      if (after.people.length !== 1 || after.org.example || after.groups.length !== 0) throw new Error('left after removal: ' + JSON.stringify({ people: after.people.length, groups: after.groups.length }))
      const docs = await A.evaluate(() => fetch('/api/docs').then((r) => r.json()))
      if (docs.length !== 1 || docs[0].id !== mine.id || docs[0].folder !== '') throw new Error('documents after removal: ' + JSON.stringify(docs))
      ok('removing the example data left only what the founder made')
    }

    // Empty.
    const B = await b.open()
    collect(B, 'empty', problems)
    const empty = await signup(B, 'empty')
    if (empty.me.people.length !== 1 || empty.me.docs.length !== 0 || empty.me.org.example) throw new Error('the empty organisation is not empty')
    await B.goto(BASE + '/admin/domains')
    await B.waitForSelector(`.card h2:text-is("${empty.domain}")`)
    await B.waitForSelector('.badge:text-is("Included")')
    ok('the empty organisation has only its founder and its own domain')

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
