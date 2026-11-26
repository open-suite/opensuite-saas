package main

// Chat in the public API. The browser talks to the chat engine directly with
// the member's own chat token; the API does the same on the member's behalf,
// following the app's conventions (lib/matrix.js): a room without a name is a
// direct conversation, invitations from colleagues are accepted on arrival,
// files are uploaded to the engine and sent as file or image messages.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *Server) chatOps() []*apiOp {
	room := pathParam("id", "Conversation id.")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/chat/rooms", ID: "list_conversations", Tag: "Chat", Summary: "List my conversations",
			Desc:   "Direct and group conversations, most recently active first, with the latest message. Invitations are accepted on the way, as the app does.",
			Result: object(js{"items": array(with(ref("Room"), js{"last": ref("ChatMessage"), "unread": integer("")}), "")}), H: s.handleRooms},
		{Method: "POST", Path: "/api/v1/chat/rooms", ID: "start_conversation", Tag: "Chat", Summary: "Start a conversation",
			Desc:  "With one colleague and no name, opens your direct conversation with them (creating it the first time). Otherwise creates a group conversation.",
			Write: true,
			Body: object(js{
				"people": array(str(""), "Colleagues' member ids or mail addresses."),
				"name":   str("A name for a group conversation."),
			}, "people"),
			Result: ref("Room"), H: s.handleRoomCreate},
		{Method: "GET", Path: "/api/v1/chat/rooms/{id}/messages", ID: "list_chat_messages", Tag: "Chat", Summary: "Read a conversation",
			Desc: "Newest first. Pass `next` as cursor to read further back.", Params: append([]apiParam{room}, pageParams...),
			Result: list(ref("ChatMessage")), H: s.handleRoomMessages},
		{Method: "POST", Path: "/api/v1/chat/rooms/{id}/messages", ID: "send_chat_message", Tag: "Chat", Summary: "Send a message", Write: true,
			Params: []apiParam{room}, Body: object(js{"text": str("")}, "text"), Result: object(js{"id": str("Message id.")}, "id"), H: s.handleRoomSend},
		{Method: "POST", Path: "/api/v1/chat/rooms/{id}/files", ID: "send_chat_file", Tag: "Chat", Summary: "Send a file", Write: true,
			Desc:   "Either upload the file as the request body (with ?name= and Content-Type), or send JSON {\"fileId\"} to share a file from Files. Pictures show as images.",
			Params: []apiParam{room, query("name", str("File name, when uploading."))},
			Raw:    "The file's bytes, or JSON {\"fileId\": \"...\"}.", Result: object(js{"id": str("Message id.")}, "id"), H: s.handleRoomFile},
		{Method: "GET", Path: "/api/v1/chat/media/{server}/{media}", ID: "get_chat_file", Tag: "Chat", Summary: "Download a file sent in a conversation",
			Desc:   "The address is in a message's file.url.",
			Params: []apiParam{pathParam("server", ""), pathParam("media", "")}, File: true, H: s.handleChatMedia},
	}
}

// chatAs calls the chat engine as the member, renewing their chat token once
// if the engine has forgotten it (handleChatToken does the same for the app).
func (s *Server) chatAs(w http.ResponseWriter, r *http.Request, u *User, method, path string, body, out any) bool {
	if s.cfg.MatrixURL == "" {
		fail(w, 503, "Chat is not available on this server.")
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		if u.MxToken == "" {
			s.chatEnsure(ctx, u)
			if u.MxToken == "" {
				fail(w, 503, "Chat is not available right now.")
				return false
			}
		}
		code, err := s.matrix(ctx, method, path, u.MxToken, body, out)
		if code == 401 && attempt == 0 {
			u.MxToken = ""
			continue
		}
		if err != nil {
			switch code {
			case 403:
				fail(w, 403, "You are not in that conversation.")
			case 404:
				fail(w, 404, "No such conversation.")
			default:
				fail(w, 502, "Chat could not do that.")
			}
			return false
		}
		return true
	}
	return false
}

type mxEvent struct {
	ID       string         `json:"event_id"`
	Type     string         `json:"type"`
	Sender   string         `json:"sender"`
	TS       int64          `json:"origin_server_ts"`
	StateKey *string        `json:"state_key"`
	Content  map[string]any `json:"content"`
}

type chatMember struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
}

type chatMessage struct {
	ID     string         `json:"id"`
	Sender chatMember     `json:"sender"`
	At     string         `json:"at"`
	Text   string         `json:"text,omitempty"`
	File   map[string]any `json:"file,omitempty"`
}

type chatRoom struct {
	ID      string       `json:"id"`
	Name    string       `json:"name"`
	Direct  bool         `json:"direct"`
	Members []chatMember `json:"members"`
	Last    *chatMessage `json:"last,omitempty"`
	Unread  int          `json:"unread"`

	ts int64
}

// directory maps chat ids to the organisation's members.
func (s *Server) directory(u *User) map[string]chatMember {
	out := map[string]chatMember{}
	for _, p := range s.people(u.OrgID) {
		out[p.Mx] = chatMember{p.ID, p.Name, p.Email}
	}
	return out
}

func memberOf(dir map[string]chatMember, mxid, name string) chatMember {
	if m, found := dir[mxid]; found {
		return m
	}
	if name == "" {
		name = strings.TrimPrefix(strings.SplitN(mxid, ":", 2)[0], "@")
	}
	return chatMember{Name: name}
}

func messageOf(ev mxEvent, dir map[string]chatMember, names map[string]string) *chatMessage {
	if ev.Type != "m.room.message" {
		return nil
	}
	c := ev.Content
	if rel, _ := c["m.relates_to"].(map[string]any); rel != nil && rel["rel_type"] == "m.replace" {
		return nil
	}
	m := &chatMessage{ID: ev.ID, Sender: memberOf(dir, ev.Sender, names[ev.Sender]), At: time.UnixMilli(ev.TS).UTC().Format(time.RFC3339)}
	body, _ := c["body"].(string)
	switch c["msgtype"] {
	case "m.image", "m.file", "m.video", "m.audio":
		file := map[string]any{"name": body}
		if info, _ := c["info"].(map[string]any); info != nil {
			file["type"], file["size"] = info["mimetype"], info["size"]
		}
		if mxc, _ := c["url"].(string); strings.HasPrefix(mxc, "mxc://") {
			file["url"] = "/api/v1/chat/media/" + strings.TrimPrefix(mxc, "mxc://")
		}
		m.File = file
	default:
		if body == "" {
			return nil
		}
		m.Text = body
	}
	return m
}

var chatFilter = `{"room":{"timeline":{"limit":1},"state":{"lazy_load_members":false},"account_data":{"types":[]}},"presence":{"types":[]},"account_data":{"types":[]}}`

func (s *Server) chatRooms(w http.ResponseWriter, r *http.Request, u *User) []*chatRoom {
	var sync struct {
		Rooms struct {
			Join map[string]struct {
				State               struct{ Events []mxEvent } `json:"state"`
				Timeline            struct{ Events []mxEvent } `json:"timeline"`
				UnreadNotifications struct {
					Count int `json:"notification_count"`
				} `json:"unread_notifications"`
			} `json:"join"`
			Invite map[string]any `json:"invite"`
		} `json:"rooms"`
	}
	if !s.chatAs(w, r, u, "GET", "/_matrix/client/v3/sync?timeout=0&filter="+url.QueryEscape(chatFilter), nil, &sync) {
		return nil
	}
	// Invitations are accepted on arrival, as in the app; they appear in the
	// next listing.
	for id := range sync.Rooms.Invite {
		s.chatAs(&recorder{header: http.Header{}}, r, u, "POST", "/_matrix/client/v3/join/"+url.PathEscape(id), map[string]any{}, nil)
	}
	dir := s.directory(u)
	me := s.mxid(u.MxLocal)
	out := []*chatRoom{}
	for id, j := range sync.Rooms.Join {
		room := &chatRoom{ID: id, Members: []chatMember{}, Unread: j.UnreadNotifications.Count}
		names := map[string]string{}
		in := map[string]bool{}
		for _, ev := range append(j.State.Events, j.Timeline.Events...) {
			switch {
			case ev.Type == "m.room.name":
				room.Name, _ = ev.Content["name"].(string)
			case ev.Type == "m.room.member" && ev.StateKey != nil:
				mem, _ := ev.Content["membership"].(string)
				in[*ev.StateKey] = mem == "join" || mem == "invite"
				names[*ev.StateKey], _ = ev.Content["displayname"].(string)
			}
		}
		var others []string
		for mxid, present := range in {
			if present {
				room.Members = append(room.Members, memberOf(dir, mxid, names[mxid]))
				if mxid != me {
					others = append(others, mxid)
				}
			}
		}
		sort.Slice(room.Members, func(i, j int) bool { return room.Members[i].Name < room.Members[j].Name })
		if room.Name == "" {
			room.Direct = len(others) == 1
			var titles []string
			for _, o := range others {
				titles = append(titles, memberOf(dir, o, names[o]).Name)
			}
			sort.Strings(titles)
			room.Name = strings.Join(titles, ", ")
			if room.Name == "" {
				room.Name = "Just you"
			}
		}
		for _, ev := range j.Timeline.Events {
			if m := messageOf(ev, dir, names); m != nil {
				room.Last = m
			}
			room.ts = max(room.ts, ev.TS)
		}
		out = append(out, room)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ts > out[j].ts })
	return out
}

func (s *Server) handleRooms(w http.ResponseWriter, r *http.Request, u *User) {
	if rooms := s.chatRooms(w, r, u); rooms != nil {
		ok(w, map[string]any{"items": rooms})
	}
}

func (s *Server) handleRoomCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		People []string
		Name   string
	}
	if readJSON(r, &in) != nil || len(in.People) == 0 {
		fail(w, 400, "Name at least one colleague.")
		return
	}
	var invite []string
	for _, key := range in.People {
		p := s.personIn(u.OrgID, key)
		if p == nil || p.Mx == "" {
			fail(w, 404, "\""+key+"\" is not in your organisation.")
			return
		}
		if p.ID != u.ID {
			invite = append(invite, p.Mx)
		}
	}
	if len(invite) == 0 {
		fail(w, 400, "Name at least one colleague other than yourself.")
		return
	}
	name := strings.TrimSpace(in.Name)
	if len(invite) == 1 && name == "" {
		rooms := s.chatRooms(w, r, u)
		if rooms == nil {
			return
		}
		peer := s.directory(u)[invite[0]]
		for _, room := range rooms {
			if room.Direct {
				for _, m := range room.Members {
					if m.ID == peer.ID {
						ok(w, room)
						return
					}
				}
			}
		}
	}
	body := map[string]any{"preset": "private_chat", "name": name, "invite": invite}
	if len(invite) == 1 && name == "" {
		body = map[string]any{"preset": "trusted_private_chat", "is_direct": true, "invite": invite}
	}
	var made struct {
		RoomID string `json:"room_id"`
	}
	if !s.chatAs(w, r, u, "POST", "/_matrix/client/v3/createRoom", body, &made) {
		return
	}
	dir := s.directory(u)
	room := chatRoom{ID: made.RoomID, Name: name, Direct: name == "" && len(invite) == 1, Members: []chatMember{memberOf(dir, s.mxid(u.MxLocal), u.Name)}}
	var titles []string
	for _, m := range invite {
		room.Members = append(room.Members, memberOf(dir, m, ""))
		titles = append(titles, memberOf(dir, m, "").Name)
	}
	if room.Name == "" {
		room.Name = strings.Join(titles, ", ")
	}
	ok(w, room)
}

func (s *Server) handleRoomMessages(w http.ResponseWriter, r *http.Request, u *User) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	q := url.Values{"dir": {"b"}, "limit": {strconv.Itoa(limit)}}
	if c := r.URL.Query().Get("cursor"); c != "" {
		q.Set("from", c)
	}
	var page struct {
		Chunk []mxEvent `json:"chunk"`
		End   string    `json:"end"`
	}
	if !s.chatAs(w, r, u, "GET", "/_matrix/client/v3/rooms/"+url.PathEscape(r.PathValue("id"))+"/messages?"+q.Encode(), nil, &page) {
		return
	}
	dir := s.directory(u)
	items := []*chatMessage{}
	for _, ev := range page.Chunk {
		if m := messageOf(ev, dir, nil); m != nil {
			items = append(items, m)
		}
	}
	out := map[string]any{"items": items}
	if page.End != "" && len(page.Chunk) > 0 {
		out["next"] = page.End
	}
	ok(w, out)
}

func (s *Server) sendChat(w http.ResponseWriter, r *http.Request, u *User, content map[string]any) {
	txn := "api" + strconv.FormatInt(time.Now().UnixNano(), 36) + newID(4)
	var res struct {
		EventID string `json:"event_id"`
	}
	if s.chatAs(w, r, u, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(r.PathValue("id"))+"/send/m.room.message/"+txn, content, &res) {
		ok(w, map[string]string{"id": res.EventID})
	}
}

func (s *Server) handleRoomSend(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Text string }
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Text) == "" {
		fail(w, 400, "Write something to send.")
		return
	}
	s.sendChat(w, r, u, map[string]any{"msgtype": "m.text", "body": in.Text})
}

// chatUpload stores a file in the chat engine and returns its address.
func (s *Server) chatUpload(w http.ResponseWriter, r *http.Request, u *User, name, ctype string, size int64, body io.Reader) string {
	if !s.chatAs(w, r, u, "GET", "/_matrix/client/v3/account/whoami", nil, nil) {
		return ""
	}
	req, err := http.NewRequestWithContext(r.Context(), "POST", s.cfg.MatrixURL+"/_matrix/media/v3/upload?filename="+url.QueryEscape(name), body)
	if err != nil {
		fail(w, 500, "chat error")
		return ""
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+u.MxToken)
	res, err := mailClient.Do(req)
	if err != nil {
		fail(w, 502, "Chat is not responding.")
		return ""
	}
	defer res.Body.Close()
	var up struct {
		URI string `json:"content_uri"`
	}
	if res.StatusCode >= 300 || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&up) != nil || up.URI == "" {
		fail(w, 502, "Chat refused that file.")
		return ""
	}
	return up.URI
}

func (s *Server) handleRoomFile(w http.ResponseWriter, r *http.Request, u *User) {
	if s.cfg.MatrixURL == "" {
		fail(w, 503, "Chat is not available on this server.")
		return
	}
	name, ctype, size := cleanName(r.URL.Query().Get("name")), r.Header.Get("Content-Type"), r.ContentLength
	var body io.Reader = http.MaxBytesReader(w, r.Body, 50<<20)
	if strings.HasPrefix(ctype, "application/json") {
		var in struct{ FileID string }
		if readJSON(r, &in) != nil || in.FileID == "" {
			fail(w, 400, "Send the file's bytes, or {\"fileId\": \"...\"}.")
			return
		}
		role, n, _ := s.nodeRole(u, in.FileID)
		if n == nil || role == "" || n.Kind != "file" {
			fail(w, 404, "That file doesn't exist.")
			return
		}
		if n.Size > 50<<20 {
			fail(w, 413, "That file is too large to send (50 MB limit). Share a link to it instead.")
			return
		}
		f, err := os.Open(s.filePath(n.ID))
		if err != nil {
			fail(w, 404, "That file doesn't exist.")
			return
		}
		defer f.Close()
		name, ctype, size, body = n.Name, n.Mime, n.Size, f
	} else if r.URL.Query().Get("name") == "" || size < 0 {
		fail(w, 400, "Say what the file is called (?name=) and send it with its length.")
		return
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	uri := s.chatUpload(w, r, u, name, ctype, size, body)
	if uri == "" {
		return
	}
	kind := "m.file"
	if strings.HasPrefix(ctype, "image/") {
		kind = "m.image"
	}
	s.sendChat(w, r, u, map[string]any{"msgtype": kind, "body": name, "url": uri, "info": map[string]any{"mimetype": ctype, "size": size}})
}

func (s *Server) handleChatMedia(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.chatAs(w, r, u, "GET", "/_matrix/client/v3/account/whoami", nil, nil) {
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", s.cfg.MatrixURL+"/_matrix/client/v1/media/download/"+url.PathEscape(r.PathValue("server"))+"/"+url.PathEscape(r.PathValue("media")), nil)
	req.Header.Set("Authorization", "Bearer "+u.MxToken)
	res, err := mailClient.Do(req)
	if err != nil {
		fail(w, 502, "Chat is not responding.")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		fail(w, 404, "That file is not available.")
		return
	}
	// Whatever was sent is served as data, never as a page of ours.
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	if cd := res.Header.Get("Content-Disposition"); cd != "" {
		h.Set("Content-Disposition", "attachment"+cd[strings.IndexByte(cd+";", ';'):])
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	io.Copy(w, res.Body)
}
