// Chat history search. The device keeps only the latest messages of each
// conversation; older ones are found by the chat server, through the search
// call of the Matrix client-server API (POST /_matrix/client/v3/search,
// category room_events). The server only searches rooms the person is in.
//
// Returns messages in the shape lib/matrix.js uses for its timeline, plus the
// room: [{ id, roomId, sender, ts, body }].
import { mx } from './matrix.js'

export async function searchChatHistory(text, limit = 12) {
  const data = await mx('POST', '/search', {
    search_categories: {
      room_events: {
        search_term: text,
        keys: ['content.body'],
        order_by: 'recent',
        filter: { limit, types: ['m.room.message'] },
      },
    },
  })
  const results = data?.search_categories?.room_events?.results || []
  const out = []
  for (const r of results) {
    const ev = r.result
    const body = ev?.content?.body
    if (!ev?.event_id || !ev.room_id || typeof body !== 'string' || !body) continue
    if (ev.content['m.relates_to']?.rel_type === 'm.replace') continue
    out.push({ id: ev.event_id, roomId: ev.room_id, sender: ev.sender, ts: ev.origin_server_ts, body })
  }
  return out
}
