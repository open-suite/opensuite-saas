import { post } from './api.js'
import { wipeDevice } from './idb.js'
import { stopChat } from './matrix.js'
import { stopMail } from './mail.js'

// signOut ends the session everywhere on this device: server cookie, live
// connections and every local copy of data. to is where to go next (the
// consent screen sends a person back to it, to sign in as someone else).
export async function signOut({ to = '/' } = {}) {
  stopChat()
  stopMail()
  await post('/api/logout').catch(() => {})
  await wipeDevice()
  location.href = to
}
