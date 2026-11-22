import './lib/px.js'
import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { signal } from '@preact/signals'
import { Home as HomeIcon, Mail as MailIcon, MessageSquare, Video, FolderOpen, Settings, LogOut, User } from 'lucide-preact'
import './style.css'
import { boot, user, isAdmin, unread, confirmed } from './lib/store.js'
import { path, parts, navigate } from './lib/router.js'
import { refreshBoot } from './lib/api.js'
import { signOut } from './lib/session.js'
import { cx, idle } from './lib/util.js'
import { startChat } from './lib/matrix.js'
import { startMail } from './lib/mail.js'
import { Avatar, Logo, Menu, Toasts } from './ui.jsx'
import { Login, Signup, SetPassword } from './apps/auth.jsx'
import { Home } from './apps/home.jsx'
import { Drive, FilePicker } from './apps/files.jsx'
import { PublicLink } from './apps/public.jsx'
import { startFiles } from './lib/files.js'
import { Mail } from './apps/mail.jsx'
import { Chat } from './apps/chat.jsx'
import { MeetHome } from './apps/meet.jsx'
import { Admin } from './apps/admin.jsx'
import { Account } from './apps/account.jsx'
import { SearchPalette, SearchPage, SearchButton } from './apps/search.jsx'

// The three heavy engines load on their own and are fetched in the
// background right after start, so opening one never waits on a download.
const heavy = {
  editor: () => import('./apps/editor.jsx'),
  sheet: () => import('./apps/sheet.jsx'),
  room: () => import('./apps/room.jsx'),
}
const loaded = signal({})
function load(name) {
  if (loaded.value[name]) return
  heavy[name]().then((m) => {
    loaded.value = { ...loaded.value, [name]: m.default }
    // Editors read their most recent documents into memory while idle.
    idle(() => m.prewarm?.())
  })
}

function Heavy({ name, ...props }) {
  const View = loaded.value[name]
  useEffect(() => load(name), [name])
  // While the code arrives (first visit only) the frame stays put.
  return View ? <View {...props} /> : <div class="page" />
}

const online = signal(navigator.onLine)
addEventListener('online', () => (online.value = true))
addEventListener('offline', () => (online.value = false))

function Rail({ section }) {
  const u = user.value
  const link = (to, key, Icon, label, count) => (
    <a href={to} class={cx('rail-link', section === key && 'on')} aria-current={section === key ? 'page' : undefined}>
      <Icon size={20} strokeWidth={1.9} />
      {label}
      {count > 0 && <span class="count">{count > 99 ? '99+' : count}</span>}
    </a>
  )
  return (
    <nav class="rail" aria-label="Open Suite">
      <a href="/" class="rail-logo" aria-label="Home"><Logo size={32} /></a>
      <SearchButton on={section === 'search'} />
      {link('/', 'home', HomeIcon, 'Home')}
      {link('/mail', 'mail', MailIcon, 'Mail', unread.value.mail)}
      {link('/chat', 'chat', MessageSquare, 'Chat', unread.value.chat)}
      {link('/meet', 'meet', Video, 'Meet')}
      {link('/files', 'docs', FolderOpen, 'Files')}
      <div class="rail-spacer" />
      {isAdmin.value && link('/admin', 'admin', Settings, 'Admin')}
      <Menu
        align="up"
        trigger={<button class="rail-me" aria-label="Your account"><Avatar name={u.name} id={u.id} size={34} /></button>}
        items={[
          { heading: u.email },
          { label: 'Your account', icon: User, onSelect: () => navigate('/account') },
          { divider: true },
          { label: 'Sign out', icon: LogOut, onSelect: signOut },
        ]}
      />
    </nav>
  )
}

function App() {
  const p = parts.value
  const b = boot.value
  const u = user.value

  useEffect(() => {
    if (!u) return
    startChat()
    startMail()
    startFiles()
    idle(() => Object.keys(heavy).forEach(load))
  }, [u?.id, b?.chat?.ready, b?.mail?.ready])

  // A meeting link works for anyone, signed in or not.
  if (p[0] === 'meet' && p[1]) {
    if (!u && !confirmed.value) return <div class="page" />
    return <><Heavy name="room" code={p[1]} /><Toasts /></>
  }

  // So does a public link to a file or folder.
  if (p[0] === 'f' && p[1]) return <><PublicLink token={p[1]} at={p[2]} /><Toasts /></>

  if (!u) {
    // Nothing known yet about this visitor: wait for the server rather than
    // flash a sign-in form at someone who is signed in.
    if (!confirmed.value) return <div class="page" />
    return <>{p[0] === 'signup' ? <Signup /> : <Login />}<Toasts /></>
  }
  if (u.mustChange) return <><SetPassword /><Toasts /></>

  const section = { d: 'docs', s: 'docs', files: 'docs', account: '' }[p[0]] ?? (p[0] || 'home')
  let view
  switch (p[0]) {
    case undefined: view = <Home />; break
    case 'mail': view = <Mail />; break
    case 'chat': view = <Chat />; break
    case 'meet': view = <MeetHome />; break
    case 'files': case 'docs': view = <Drive />; break
    case 'd': view = <Heavy name="editor" id={p[1]} key={p[1]} />; break
    case 's': view = <Heavy name="sheet" id={p[1]} key={p[1]} />; break
    case 'admin': view = isAdmin.value ? <Admin /> : <Home />; break
    case 'account': view = <Account />; break
    case 'search': view = <SearchPage />; break
    default: view = <Home />
  }
  return (
    <div class="shell">
      <Rail section={section} />
      <main class="main">
        {!online.value && <div class="offline-bar">You're offline. Open Suite keeps working and will sync when you're back.</div>}
        {view}
      </main>
      <FilePicker />
      <SearchPalette />
      <Toasts />
    </div>
  )
}

render(<App />, document.getElementById('app'))
// Time from navigation start to a usable screen, for the performance checks.
requestAnimationFrame(() => performance.mark('os:painted'))

// Reconcile whatever the device remembered with the server.
if (!window.__BOOT__) refreshBoot()
addEventListener('focus', () => user.value && document.visibilityState === 'visible' && refreshBootSoon())
let lastRefresh = Date.now()
function refreshBootSoon() {
  if (Date.now() - lastRefresh < 60000) return
  lastRefresh = Date.now()
  refreshBoot()
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
