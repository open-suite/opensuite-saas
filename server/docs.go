package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type Doc struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"` // one of docKinds
	Title   string  `json:"title"`
	Folder  string  `json:"folder"` // the folder it is filed in; "" is the owner's top level
	Access  string  `json:"access"` // private | org
	Owner   string  `json:"owner"`
	Role    string  `json:"role"` // owner | edit | view
	Created int64   `json:"created"`
	Updated int64   `json:"updated"`
	Trashed int64   `json:"trashed,omitempty"`
	Shares  []Share `json:"shares"`
}

type Share struct {
	User string `json:"user"`
	Role string `json:"role"`
}

// docKinds are the editors a document can belong to.
var docKinds = map[string]bool{"doc": true, "sheet": true}

// docList returns every document the user can open, newest first. A document
// filed in a folder is also open to whoever can open that folder.
func (s *Server) docList(u *User) []Doc {
	out := []Doc{}
	rows, err := s.r.Query(`SELECT d.id, d.kind, d.title, d.folder_id, d.access, d.owner_id, d.created, d.updated, d.trashed, coalesce(sh.role, '')
		FROM docs d LEFT JOIN doc_shares sh ON sh.doc_id = d.id AND sh.user_id = ?1
		WHERE d.org_id = ?2 AND (d.owner_id = ?1 OR d.access = 'org' OR sh.user_id IS NOT NULL OR d.folder_id != '')
		ORDER BY d.updated DESC LIMIT 2000`, u.ID, u.OrgID)
	if err != nil {
		return out
	}
	var tree *nodeTree
	idx := map[string]int{}
	for rows.Next() {
		var d Doc
		var share string
		rows.Scan(&d.ID, &d.Kind, &d.Title, &d.Folder, &d.Access, &d.Owner, &d.Created, &d.Updated, &d.Trashed, &share)
		d.Role = roleOf(u, d.Owner, d.Access, share)
		d.Shares = []Share{}
		if d.Folder != "" {
			if tree == nil {
				tree = s.nodeTree(u)
			}
			role, usable := tree.folder(d.Folder)
			if usable {
				d.Role = bestRole(d.Role, role)
			} else if tree.nodes[d.Folder] != nil && (d.Owner != u.ID || role == "owner") {
				continue // its folder is in the trash
			}
		}
		if d.Role == "" || (d.Trashed > 0 && d.Role != "owner") {
			continue
		}
		idx[d.ID] = len(out)
		out = append(out, d)
	}
	rows.Close()
	srows, err := s.r.Query(`SELECT sh.doc_id, sh.user_id, sh.role FROM doc_shares sh JOIN docs d ON d.id = sh.doc_id WHERE d.org_id = ?`, u.OrgID)
	if err == nil {
		defer srows.Close()
		for srows.Next() {
			var id string
			var sh Share
			srows.Scan(&id, &sh.User, &sh.Role)
			if i, found := idx[id]; found {
				out[i].Shares = append(out[i].Shares, sh)
			}
		}
	}
	return out
}

func roleOf(u *User, owner, access, share string) string {
	switch {
	case owner == u.ID:
		return "owner"
	case share == "edit" || access == "org":
		return "edit"
	case share == "view":
		return "view"
	}
	return ""
}

// docRole answers "may this user open this document, and how".
func (s *Server) docRole(u *User, id string) (role, kind string) {
	var owner, access, share, folder string
	var trashed int64
	err := s.r.QueryRow(`SELECT d.owner_id, d.access, d.kind, d.trashed, d.folder_id, coalesce(sh.role, '') FROM docs d
		LEFT JOIN doc_shares sh ON sh.doc_id = d.id AND sh.user_id = ?1 WHERE d.id = ?2 AND d.org_id = ?3`, u.ID, id, u.OrgID).
		Scan(&owner, &access, &kind, &trashed, &folder, &share)
	if err != nil {
		return "", ""
	}
	role = roleOf(u, owner, access, share)
	if folder != "" && role != "owner" {
		inherited, _, _ := s.nodeRole(u, folder)
		role = bestRole(role, inherited)
	}
	return role, kind
}

func (s *Server) handleDocList(w http.ResponseWriter, r *http.Request, u *User) { ok(w, s.docList(u)) }

func (s *Server) handleDocCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ ID, Kind, Title, Snapshot, Folder string }
	if readJSON(r, &in) != nil || !docKinds[in.Kind] {
		fail(w, 400, "bad request")
		return
	}
	if code, msg := s.placeIn(u, in.Folder); code != 0 {
		fail(w, code, msg)
		return
	}
	// The client may mint the id so a new document opens before the server
	// has answered.
	id := in.ID
	if len(id) != 14 || strings.Trim(id, idAlphabet) != "" {
		id = newID(14)
	}
	var snap []byte
	var seq int64
	if in.Snapshot != "" {
		b, err := base64.StdEncoding.DecodeString(in.Snapshot)
		if err != nil {
			fail(w, 400, "bad snapshot")
			return
		}
		snap, seq = b, 1
	}
	t := now()
	_, err := s.w.Exec(`INSERT INTO docs(id, org_id, owner_id, kind, title, folder_id, created, updated, snap, snap_seq, seq) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		id, u.OrgID, u.ID, in.Kind, strings.TrimSpace(in.Title), in.Folder, t, t, snap, seq, seq)
	if err != nil {
		fail(w, 409, "That document already exists.")
		return
	}
	ok(w, Doc{ID: id, Kind: in.Kind, Title: in.Title, Folder: in.Folder, Access: "private", Owner: u.ID, Role: "owner", Created: t, Updated: t, Shares: []Share{}})
}

func (s *Server) handleDocUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	role, _ := s.docRole(u, id)
	if role == "" || role == "view" {
		fail(w, 403, "You can't change this document.")
		return
	}
	var in struct {
		Title   *string
		Folder  *string
		Access  *string
		Trashed *bool
		Shares  *[]Share
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.Folder != nil {
		// Filing a document somewhere else: into a folder the caller may add
		// to, or back to the top level of whoever owns it.
		var owner string
		s.r.QueryRow(`SELECT owner_id FROM docs WHERE id = ?`, id).Scan(&owner)
		if *in.Folder == "" && owner != u.ID {
			fail(w, 403, "Only the owner can move this out of the shared folder.")
			return
		}
		if code, msg := s.placeIn(u, *in.Folder); code != 0 {
			fail(w, code, msg)
			return
		}
		s.w.Exec(`UPDATE docs SET folder_id = ? WHERE id = ?`, *in.Folder, id)
	}
	if in.Title != nil {
		title := strings.TrimSpace(*in.Title)
		if len(title) > 200 {
			title = title[:200]
		}
		s.w.Exec(`UPDATE docs SET title = ?, updated = ? WHERE id = ?`, title, now(), id)
		s.hub.notify(id, append([]byte{msgTitle}, title...))
	}
	if role == "owner" {
		if in.Access != nil && (*in.Access == "private" || *in.Access == "org") {
			s.w.Exec(`UPDATE docs SET access = ? WHERE id = ?`, *in.Access, id)
		}
		if in.Trashed != nil {
			t := int64(0)
			if *in.Trashed {
				t = now()
			}
			s.w.Exec(`UPDATE docs SET trashed = ? WHERE id = ?`, t, id)
		}
		if in.Shares != nil {
			tx, err := s.w.Begin()
			if err == nil {
				tx.Exec(`DELETE FROM doc_shares WHERE doc_id = ?`, id)
				for _, sh := range *in.Shares {
					if sh.Role != "view" {
						sh.Role = "edit"
					}
					// Only people in the same organisation can be added.
					tx.Exec(`INSERT OR IGNORE INTO doc_shares(doc_id, user_id, role) SELECT ?, id, ? FROM users WHERE id = ? AND org_id = ?`,
						id, sh.Role, sh.User, u.OrgID)
				}
				tx.Commit()
			}
		}
	}
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleDocDelete(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	if role, _ := s.docRole(u, id); role != "owner" {
		fail(w, 403, "Only the owner can delete this document.")
		return
	}
	s.w.Exec(`DELETE FROM docs WHERE id = ?`, id)
	s.w.Exec(`DELETE FROM doc_updates WHERE doc_id = ?`, id)
	ok(w, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------------------
// Live sync. The server is deliberately ignorant of document formats: a
// document is a snapshot plus an ordered log of opaque updates. Text documents
// send Yjs updates (order-free), spreadsheets send engine diffs (ordered); the
// server gives every update a sequence number, stores it and fans it out.
// Each update starts with an 8-byte id chosen by its author so a resend after
// a dropped connection is recognised instead of applied twice.

const (
	msgUpdate    = 1 // c->s: opid+data          s->c: seq, opid+data
	msgAwareness = 2 // c->s: payload            s->c: peer, payload
	msgSnapshot  = 3 // c->s: seq, state
	msgSynced    = 4 // s->c: seq
	msgAck       = 5 // s->c: seq, opid
	msgBase      = 6 // s->c: seq, state
	msgLeave     = 7 // s->c: peer
	msgHello     = 8 // s->c: peer, canEdit
	msgTitle     = 9 // s->c: title
)

type Hub struct {
	s     *Server
	mu    sync.Mutex
	rooms map[string]*room
	ids   atomic.Uint64
}

type room struct {
	id     string
	mu     sync.Mutex
	seq    int64
	peers  map[*peer]struct{}
	recent map[[8]byte]int64
	order  [][8]byte
}

type peer struct {
	id   uint64
	out  chan []byte
	conn *websocket.Conn
	edit bool
}

func newHub(s *Server) *Hub { return &Hub{s: s, rooms: map[string]*room{}} }

func (h *Hub) room(id string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rm := h.rooms[id]; rm != nil {
		return rm
	}
	rm := &room{id: id, peers: map[*peer]struct{}{}, recent: map[[8]byte]int64{}}
	h.s.r.QueryRow(`SELECT seq FROM docs WHERE id = ?`, id).Scan(&rm.seq)
	h.rooms[id] = rm
	return rm
}

func (h *Hub) release(rm *room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if len(rm.peers) == 0 {
		delete(h.rooms, rm.id)
	}
}

// notify sends a server-originated message to everyone in a room, if open.
func (h *Hub) notify(id string, msg []byte) {
	h.mu.Lock()
	rm := h.rooms[id]
	h.mu.Unlock()
	if rm == nil {
		return
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	for p := range rm.peers {
		p.send(msg)
	}
}

// send never blocks the room: a peer that cannot keep up is disconnected and
// will resume from its last sequence number.
func (p *peer) send(msg []byte) {
	select {
	case p.out <- msg:
	default:
		p.conn.Close(websocket.StatusPolicyViolation, "slow")
	}
}

func (s *Server) handleDocSync(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	role, _ := s.docRole(u, id)
	if role == "" {
		fail(w, 403, "no access")
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 20)
	ctx := r.Context()

	rm := s.hub.room(id)
	p := &peer{id: s.hub.ids.Add(1), out: make(chan []byte, 512), conn: conn, edit: role != "view"}

	// Collect the backlog and join the room atomically so no update falls in
	// the gap between "read history" and "receive live".
	rm.mu.Lock()
	var backlog [][]byte
	var snap []byte
	var snapSeq int64
	s.r.QueryRow(`SELECT snap, snap_seq FROM docs WHERE id = ?`, id).Scan(&snap, &snapSeq)
	if since < snapSeq || since > rm.seq {
		since = 0
		if snapSeq > 0 {
			backlog = append(backlog, append(varint([]byte{msgBase}, uint64(snapSeq)), snap...))
			since = snapSeq
		} else {
			backlog = append(backlog, varint([]byte{msgBase}, 0))
		}
	}
	rows, err := s.r.Query(`SELECT seq, data FROM doc_updates WHERE doc_id = ? AND seq > ? ORDER BY seq`, id, since)
	if err == nil {
		for rows.Next() {
			var seq int64
			var data []byte
			rows.Scan(&seq, &data)
			backlog = append(backlog, append(varint([]byte{msgUpdate}, uint64(seq)), data...))
		}
		rows.Close()
	}
	backlog = append(backlog, varint([]byte{msgSynced}, uint64(rm.seq)))
	rm.peers[p] = struct{}{}
	rm.mu.Unlock()

	defer func() {
		rm.mu.Lock()
		delete(rm.peers, p)
		bye := varint([]byte{msgLeave}, p.id)
		for o := range rm.peers {
			o.send(bye)
		}
		rm.mu.Unlock()
		s.hub.release(rm)
	}()

	go func() {
		write := func(msg []byte) bool {
			wctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			return conn.Write(wctx, websocket.MessageBinary, msg) == nil
		}
		hello := varint([]byte{msgHello}, p.id)
		if p.edit {
			hello = append(hello, 1)
		} else {
			hello = append(hello, 0)
		}
		if !write(hello) {
			return
		}
		for _, m := range backlog {
			if !write(m) {
				return
			}
		}
		backlog = nil
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-p.out:
				if !write(m) {
					return
				}
			}
		}
	}()

	for {
		_, msg, err := conn.Read(ctx)
		if err != nil || len(msg) == 0 {
			return
		}
		switch msg[0] {
		case msgUpdate:
			if p.edit && len(msg) > 9 {
				s.applyUpdate(rm, p, msg[1:])
			}
		case msgAwareness:
			out := append(varint([]byte{msgAwareness}, p.id), msg[1:]...)
			rm.mu.Lock()
			for o := range rm.peers {
				if o != p {
					o.send(out)
				}
			}
			rm.mu.Unlock()
		case msgSnapshot:
			if p.edit {
				seq, n := readVarint(msg[1:])
				if n > 0 {
					s.applySnapshot(rm, int64(seq), msg[1+n:])
				}
			}
		}
	}
}

// handleDocState returns a document's snapshot and log in one response, in
// the same frames the live connection uses, each prefixed with its length.
// The app uses it to place recent documents on a device before they are
// opened, so the first open there is as fast as every later one.
func (s *Server) handleDocState(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	if role, _ := s.docRole(u, id); role == "" {
		fail(w, 403, "no access")
		return
	}
	tx, err := s.r.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	defer tx.Rollback()
	var snap []byte
	var snapSeq, seq int64
	if tx.QueryRow(`SELECT snap, snap_seq, seq FROM docs WHERE id = ?`, id).Scan(&snap, &snapSeq, &seq) != nil {
		fail(w, 404, "not found")
		return
	}
	var out []byte
	frame := func(msg []byte) { out = append(varint(out, uint64(len(msg))), msg...) }
	frame(append(varint([]byte{msgBase}, uint64(snapSeq)), snap...))
	last := snapSeq
	rows, err := tx.Query(`SELECT seq, data FROM doc_updates WHERE doc_id = ? AND seq > ? ORDER BY seq`, id, snapSeq)
	if err == nil {
		for rows.Next() {
			var data []byte
			rows.Scan(&last, &data)
			frame(append(varint([]byte{msgUpdate}, uint64(last)), data...))
		}
		rows.Close()
	}
	frame(varint([]byte{msgSynced}, uint64(last)))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}

func (s *Server) applyUpdate(rm *room, from *peer, payload []byte) {
	var op [8]byte
	copy(op[:], payload)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if seq, dup := rm.recent[op]; dup {
		from.send(append(varint([]byte{msgAck}, uint64(seq)), op[:]...))
		return
	}
	seq := rm.seq + 1
	tx, err := s.w.Begin()
	if err != nil {
		return
	}
	_, e1 := tx.Exec(`INSERT INTO doc_updates(doc_id, seq, data) VALUES(?,?,?)`, rm.id, seq, payload)
	_, e2 := tx.Exec(`UPDATE docs SET seq = ?, updated = ? WHERE id = ?`, seq, now(), rm.id)
	if e1 != nil || e2 != nil || tx.Commit() != nil {
		tx.Rollback()
		return
	}
	rm.seq = seq
	rm.recent[op] = seq
	rm.order = append(rm.order, op)
	if len(rm.order) > 4096 {
		delete(rm.recent, rm.order[0])
		rm.order = rm.order[1:]
	}
	out := append(varint([]byte{msgUpdate}, uint64(seq)), payload...)
	for o := range rm.peers {
		if o == from {
			o.send(append(varint([]byte{msgAck}, uint64(seq)), op[:]...))
		} else {
			o.send(out)
		}
	}
}

// applySnapshot replaces the log up to seq with one compact state. A client
// only offers a snapshot when its copy is exactly "everything up to seq".
func (s *Server) applySnapshot(rm *room, seq int64, state []byte) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	var snapSeq int64
	s.r.QueryRow(`SELECT snap_seq FROM docs WHERE id = ?`, rm.id).Scan(&snapSeq)
	if seq <= snapSeq || seq > rm.seq || len(state) == 0 {
		return
	}
	tx, err := s.w.Begin()
	if err != nil {
		return
	}
	tx.Exec(`UPDATE docs SET snap = ?, snap_seq = ? WHERE id = ?`, state, seq, rm.id)
	tx.Exec(`DELETE FROM doc_updates WHERE doc_id = ? AND seq <= ?`, rm.id, seq)
	tx.Commit()
}
