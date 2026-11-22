package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// Version history. A version is a document's whole state at one sequence
// number, stored exactly as the live connection would replay it (snapshot
// frame, then update frames), so the server still never has to understand a
// document format. Versions are taken automatically, before the first edit of
// a new sitting and every so often during a long one, and by hand with a name.
// Old automatic versions are thinned; named ones are kept.

const (
	versionIdle  = 5 * 60   // a pause this long ends a sitting (seconds)
	versionEvery = 10 * 60  // a sitting this long gets a version of its own
	versionMax   = 200      // automatic versions kept per document
	versionLimit = 64 << 20 // a state larger than this is not versioned
)

type Version struct {
	ID      string   `json:"id"`
	Seq     int64    `json:"seq"`
	Created int64    `json:"created"`
	Name    string   `json:"name"`
	Auto    bool     `json:"auto"`
	Editors []string `json:"editors"`
	Size    int64    `json:"size"`
}

// loadVersionState fills in what a new room needs to know about its history.
// rm.verAt arrives holding the document's creation time, which stands in
// until a first version exists.
func (s *Server) loadVersionState(rm *room) {
	var at, seq int64
	if s.r.QueryRow(`SELECT created, seq FROM doc_versions WHERE doc_id = ? ORDER BY created DESC, seq DESC LIMIT 1`, rm.id).Scan(&at, &seq) == nil {
		rm.verAt, rm.verSeq = at, seq
	}
	rm.editors = map[string]struct{}{}
	rows, err := s.r.Query(`SELECT user_id FROM doc_editors WHERE doc_id = ?`, rm.id)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		rows.Scan(&id)
		rm.editors[id] = struct{}{}
	}
}

// noteEditor remembers who has changed the document since its last version.
// Called with rm.mu held.
func (s *Server) noteEditor(rm *room, user string, t int64) {
	if _, known := rm.editors[user]; known || user == "" {
		return
	}
	rm.editors[user] = struct{}{}
	s.w.Exec(`INSERT OR REPLACE INTO doc_editors(doc_id, user_id, at) VALUES(?,?,?)`, rm.id, user, t)
}

// autoVersion is called with rm.mu held, just before an update is stored.
func (s *Server) autoVersion(rm *room, t int64) {
	if rm.seq <= rm.verSeq {
		return
	}
	if t-rm.updated >= versionIdle || t-rm.verAt >= versionEvery {
		s.takeVersion(rm, "", true)
	}
}

// stateFrames is a document's state up to and including its current sequence,
// in the frames of the live protocol, each prefixed with its length.
func (s *Server) stateFrames(id string) (out []byte, last int64, ok bool) {
	var snap []byte
	var snapSeq int64
	if s.r.QueryRow(`SELECT snap, snap_seq FROM docs WHERE id = ?`, id).Scan(&snap, &snapSeq) != nil {
		return nil, 0, false
	}
	frame := func(msg []byte) { out = append(varint(out, uint64(len(msg))), msg...) }
	frame(append(varint([]byte{msgBase}, uint64(snapSeq)), snap...))
	last = snapSeq
	rows, err := s.r.Query(`SELECT seq, data FROM doc_updates WHERE doc_id = ? AND seq > ? ORDER BY seq`, id, snapSeq)
	if err != nil {
		return nil, 0, false
	}
	defer rows.Close()
	for rows.Next() {
		var data []byte
		rows.Scan(&last, &data)
		frame(append(varint([]byte{msgUpdate}, uint64(last)), data...))
	}
	frame(varint([]byte{msgSynced}, uint64(last)))
	return out, last, true
}

// takeVersion stores the current state as a version and returns its id.
// Called with rm.mu held, so the state cannot move while it is read.
func (s *Server) takeVersion(rm *room, name string, auto bool) string {
	frames, _, ok := s.stateFrames(rm.id)
	if !ok || len(frames) > versionLimit {
		return ""
	}
	var packed bytes.Buffer
	zw := gzip.NewWriter(&packed)
	zw.Write(frames)
	zw.Close()
	editors := make([]string, 0, len(rm.editors))
	for id := range rm.editors {
		editors = append(editors, id)
	}
	who, _ := json.Marshal(editors)
	// The version is dated by the last change it contains, not by the moment
	// it happened to be filed.
	created := rm.updated
	if created == 0 {
		created = now()
	}
	id := newID(12)
	if _, err := s.w.Exec(`INSERT INTO doc_versions(id, doc_id, seq, created, name, auto, editors, size, state) VALUES(?,?,?,?,?,?,?,?,?)`,
		id, rm.id, rm.seq, created, name, auto, string(who), len(frames), packed.Bytes()); err != nil {
		return ""
	}
	s.w.Exec(`DELETE FROM doc_editors WHERE doc_id = ?`, rm.id)
	rm.editors = map[string]struct{}{}
	rm.verAt, rm.verSeq = now(), rm.seq
	s.thinVersions(rm.id, now())
	return id
}

// thinVersions keeps every automatic version of the last day, then one an
// hour for a week, one a day for three months and one a week after that.
func (s *Server) thinVersions(doc string, t int64) {
	rows, err := s.r.Query(`SELECT id, created FROM doc_versions WHERE doc_id = ? AND auto = 1 AND name = '' ORDER BY created DESC, seq DESC`, doc)
	if err != nil {
		return
	}
	type v struct {
		id      string
		created int64
	}
	var all []v
	for rows.Next() {
		var x v
		rows.Scan(&x.id, &x.created)
		all = append(all, x)
	}
	rows.Close()
	var drop []string
	seen := map[int64]bool{}
	kept := 0
	for _, x := range all {
		age := t - x.created
		var bucket int64
		switch {
		case age < 86400:
			bucket = 0
		case age < 7*86400:
			bucket = 1<<40 + x.created/3600
		case age < 90*86400:
			bucket = 2<<40 + x.created/86400
		default:
			bucket = 3<<40 + x.created/(7*86400)
		}
		if (bucket != 0 && seen[bucket]) || kept >= versionMax {
			drop = append(drop, x.id)
			continue
		}
		seen[bucket] = true
		kept++
	}
	for _, id := range drop {
		s.w.Exec(`DELETE FROM doc_versions WHERE id = ?`, id)
	}
}

// versionAccess gates every history endpoint: only people who may edit a
// document may read or change its past.
func (s *Server) versionAccess(w http.ResponseWriter, r *http.Request, u *User) (id, kind string, ok bool) {
	id = r.PathValue("id")
	role, kind := s.docRole(u, id)
	if !canEdit(role) {
		fail(w, 403, "You can't see this document's history.")
		return "", "", false
	}
	return id, kind, true
}

func (s *Server) handleVersionList(w http.ResponseWriter, r *http.Request, u *User) {
	id, _, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	out := []Version{}
	rows, err := s.r.Query(`SELECT id, seq, created, name, auto, editors, size FROM doc_versions WHERE doc_id = ? ORDER BY created DESC, seq DESC LIMIT 500`, id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var v Version
			var who string
			rows.Scan(&v.ID, &v.Seq, &v.Created, &v.Name, &v.Auto, &who, &v.Size)
			json.Unmarshal([]byte(who), &v.Editors)
			if v.Editors == nil {
				v.Editors = []string{}
			}
			out = append(out, v)
		}
	}
	ok(w, out)
}

// handleVersionCreate files the current state: with a name it is a named
// version, without one it is an ordinary checkpoint (taken, for instance,
// just before a restore so that the restore can itself be undone).
func (s *Server) handleVersionCreate(w http.ResponseWriter, r *http.Request, u *User) {
	id, _, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	var in struct{ Name string }
	readJSON(r, &in)
	name := cleanVersionName(in.Name)
	rm := s.hub.room(id)
	defer s.hub.release(rm)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	var vid string
	if rm.seq == rm.verSeq {
		// Nothing has changed since the newest version: name that one.
		s.r.QueryRow(`SELECT id FROM doc_versions WHERE doc_id = ? AND seq = ? ORDER BY created DESC LIMIT 1`, id, rm.seq).Scan(&vid)
		if vid != "" && name != "" {
			s.w.Exec(`UPDATE doc_versions SET name = ?, auto = 0 WHERE id = ?`, name, vid)
		}
	}
	if vid == "" {
		if name != "" {
			rm.editors[u.ID] = struct{}{}
		}
		vid = s.takeVersion(rm, name, name == "")
	}
	if vid == "" {
		fail(w, 500, "This version couldn't be saved.")
		return
	}
	ok(w, map[string]string{"id": vid})
}

func cleanVersionName(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > 120 {
		name = name[:120]
	}
	return name
}

func (s *Server) handleVersionRename(w http.ResponseWriter, r *http.Request, u *User) {
	id, _, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	var in struct{ Name string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	name := cleanVersionName(in.Name)
	res, err := s.w.Exec(`UPDATE doc_versions SET name = ?, auto = ? WHERE id = ? AND doc_id = ?`, name, name == "", r.PathValue("version"), id)
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 404, "That version no longer exists.")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) versionState(doc, version string) ([]byte, bool) {
	var packed []byte
	if s.r.QueryRow(`SELECT state FROM doc_versions WHERE id = ? AND doc_id = ?`, version, doc).Scan(&packed) != nil {
		return nil, false
	}
	zr, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		return nil, false
	}
	frames, err := io.ReadAll(io.LimitReader(zr, versionLimit+1))
	return frames, err == nil
}

// handleVersionGet returns a version in the same form as /state.
func (s *Server) handleVersionGet(w http.ResponseWriter, r *http.Request, u *User) {
	id, _, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	frames, found := s.versionState(id, r.PathValue("version"))
	if !found {
		fail(w, 404, "That version no longer exists.")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Write(frames)
}

// handleVersionRestore makes a past version the present for documents whose
// updates are order-dependent (spreadsheets): the log is replaced by the
// version's own and everyone connected is sent the new base. What was there
// is filed as a version first, so a restore can be reversed by restoring that.
// Text documents merge rather than replace, so the app restores those itself,
// as an ordinary edit.
func (s *Server) handleVersionRestore(w http.ResponseWriter, r *http.Request, u *User) {
	id, kind, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	if kind != "sheet" {
		fail(w, 400, "This kind of document is restored in the app.")
		return
	}
	frames, found := s.versionState(id, r.PathValue("version"))
	if !found {
		fail(w, 404, "That version no longer exists.")
		return
	}
	var base []byte
	var updates [][]byte
	for pos := 0; pos < len(frames); {
		n, used := readVarint(frames[pos:])
		if used <= 0 || pos+used+int(n) > len(frames) || n == 0 {
			fail(w, 500, "This version is damaged.")
			return
		}
		msg := frames[pos+used : pos+used+int(n)]
		pos += used + int(n)
		_, skip := readVarint(msg[1:])
		switch msg[0] {
		case msgBase:
			base = msg[1+skip:]
		case msgUpdate:
			updates = append(updates, msg[1+skip:])
		}
	}

	rm := s.hub.room(id)
	defer s.hub.release(rm)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.seq > rm.verSeq {
		s.takeVersion(rm, "", true)
	}
	t := now()
	first := rm.seq + 1
	last := first + int64(len(updates))
	tx, err := s.w.Begin()
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	defer tx.Rollback()
	tx.Exec(`DELETE FROM doc_updates WHERE doc_id = ?`, id)
	tx.Exec(`UPDATE docs SET snap = ?, snap_seq = ?, seq = ?, updated = ? WHERE id = ?`, base, first, last, t, id)
	for i, data := range updates {
		tx.Exec(`INSERT INTO doc_updates(doc_id, seq, data) VALUES(?,?,?)`, id, first+1+int64(i), data)
	}
	if tx.Commit() != nil {
		fail(w, 500, "storage error")
		return
	}
	rm.seq, rm.updated = last, t
	rm.verAt, rm.verSeq = t, last
	rm.recent, rm.order = map[[8]byte]int64{}, nil
	s.noteEditor(rm, u.ID, t)
	for p := range rm.peers {
		p.send(append(varint([]byte{msgBase}, uint64(first)), base...))
		for i, data := range updates {
			p.send(append(varint([]byte{msgUpdate}, uint64(first+1+int64(i))), data...))
		}
	}
	ok(w, map[string]int64{"seq": last})
}
