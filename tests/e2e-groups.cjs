// End-to-end check of groups (shared inboxes) against a live Open Suite. The
// administrator makes a group in Admin → Groups, with the colleague as a
// viewer and themself as a user. The colleague writes to the group from
// their own mailbox, then reads it there as a viewer, with no way to answer
// as the group. The administrator sees who read it and answers as the
// group; the answer reaches the colleague from the group's address. Mail
// only ever goes between the two accounts. Fails on any console error or
// failed request; the group is deleted at the end.
//
//   OS_BASE=https://office.example OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-groups.cjs
//
// The colleague is the one tests/e2e.cjs added (tests/.state.json), with the
// password in OS_E2E_COLLEAGUE_PASS.
const { connect, login, collect, BASE } = require('./browser.cjs')

const { state } = require('./browser.cjs').remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
if (!state.colleague?.changed) throw new Error('run tests/e2e.cjs first: it adds the colleague this check works with')

;(async () => {
  const b = await connect()
  const problems = []
  const ok = (msg) => console.log('  ok  ' + msg)
  const stamp = Date.now().toString(36)
  const name = 'E2E ' + stamp
  let groupId = ''
  let A
  try {
    A = await b.open()
    const B = await b.open()
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await login(A, ADMIN.user, ADMIN.pass)
    await login(B, state.colleague.user, COLLEAGUE_PASS)
    ok('both signed in')
    const me = await A.evaluate(() => fetch('/api/boot').then((r) => r.json()))
    const grace = me.people.find((p) => p.email === state.colleague.user)

    // The administrator makes the group and its members in Admin.
    await A.goto(BASE + '/admin/groups')
    await A.click('text=New group')
    await A.fill('.modal input.input', name)
    await A.click('.modal >> text=Create group')
    await A.waitForSelector(`.modal h2:text-is("${name}")`)
    const find = async () => (await A.evaluate(() => fetch('/api/v1/groups').then((r) => r.json()))).items.find((g) => g.name === name)
    groupId = (await find()).id
    const add = async (person, role) => {
      await A.selectOption('.modal select[aria-label="Person to add"]', person.id)
      await A.selectOption('.modal select[aria-label="Their role"]', role)
      await A.click('.modal .gr-add button:has-text("Add")')
      await A.waitForSelector(`.modal .gr-member:has-text("${person.email}")`)
    }
    await add(grace, 'viewer')
    await add(me.user, 'user')
    const group = await find()
    if (group.members.find((m) => m.id === grace.id)?.role !== 'viewer' || group.members.find((m) => m.id === me.user.id)?.role !== 'user') {
      throw new Error('members are not as set: ' + JSON.stringify(group.members))
    }
    await A.click('.modal >> text=Done')
    ok(`group ${group.email} made, with a viewer and a user`)

    // The colleague writes to it from their own mailbox.
    const subject = 'Question ' + stamp
    await B.goto(BASE + '/mail')
    await B.click('text=Compose')
    await B.fill('#c-to', group.email)
    await B.fill('#c-subj', subject)
    await B.click('.compose-body')
    await B.keyboard.type('Can the group see this?')
    await B.click('.compose >> text=Send')
    await B.waitForSelector('.compose', { state: 'detached', timeout: 10000 })
    ok('colleague wrote to the group')

    // As a viewer, they read it in the group's mailbox and cannot answer as it.
    await B.click(`.mail-side button[title^="${name} "]`)
    await B.waitForSelector(`.mrow >> text=${subject}`, { timeout: 20000 })
    await B.click(`.mrow >> text=${subject}`)
    const body = await B.frameLocator('.msg iframe').locator('body').innerText()
    if (!body.includes('Can the group see this?')) throw new Error('group mail body missing: ' + body)
    if (await B.$('[aria-label="Reply (r)"]') || await B.$('text=Reply as')) throw new Error('a viewer is offered a reply as the group')
    if (!(await B.$('.read-bar [aria-label="Forward"]'))) throw new Error('a viewer has no forward')
    ok('viewer reads the group mail, with no reply as the group')

    // The user sees who read it and answers as the group.
    await A.goto(BASE + '/mail')
    await A.click(`.mail-side button[title^="${name} "]`)
    await A.waitForSelector(`.mrow >> text=${subject}`, { timeout: 20000 })
    await A.click(`.mrow >> text=${subject}`)
    await A.waitForSelector(`.gr-activity >> text=Read by`, { timeout: 10000 })
    const activity = await A.textContent('.gr-activity')
    if (!activity.includes(grace.name)) throw new Error('activity does not name the viewer: ' + activity)
    ok('user sees that the viewer read it')
    await A.click(`text=Reply as ${name}`)
    await A.waitForSelector('.compose-body')
    if ((await A.inputValue('#c-from')) !== group.id) throw new Error('the reply is not from the group')
    await A.click('.compose-body')
    await A.keyboard.type('Yes, the group sees it.')
    await A.click('.compose >> text=Send')
    await A.waitForSelector('.compose', { state: 'detached', timeout: 10000 })
    await A.waitForSelector(`.gr-activity >> text=Answered by you`, { timeout: 10000 })
    ok('user answered as the group, and the group sees who did')

    // The answer reaches the colleague from the group's address.
    await B.click('.mail-side button.folder[title="Inbox"]')
    await B.waitForSelector(`.mrow >> text=Re: ${subject}`, { timeout: 20000 })
    await B.click(`.mrow >> text=Re: ${subject}`)
    const from = await B.locator('.msg .from').last().textContent() // the thread also holds the question, from her Sent
    if (!from.includes(group.email) || !from.includes(name)) throw new Error('the answer is not from the group: ' + from)
    ok('the colleague got the answer from ' + group.email)

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    process.exitCode = 1
  } finally {
    if (groupId) await A.evaluate((id) => fetch('/api/v1/groups/' + id, { method: 'DELETE' }), groupId).catch(() => {})
    await b.close()
  }
})()
