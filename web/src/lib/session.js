import { post } from './api.js'
import { wipeDevice } from './idb.js'
import { stopChat } from './matrix.js'
import { stopMail } from './mail.js'

// signOut ends the session everywhere on this device: server cookie, live
// connections and every local copy of data.
export async function signOut() {
  stopChat()
  stopMail()
  await post('/api/logout').catch(() => {})
  await wipeDevice()
  location.href = '/'
}
