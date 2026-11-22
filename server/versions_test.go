package main

import (
	"bytes"
	"io"
	"testing"
	"time"
)

func (c *client) get(path string) (int, []byte) {
	res, err := c.http.Get(c.base + path)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// Version history: automatic and named versions, reading one back, restoring
// a spreadsheet for everyone connected, and who may do any of it.
func TestVersions(t *testing.T) {
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var doc Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "sheet"}, &doc)
	base := "/api/docs/" + doc.ID
	c1 := dial(t, a, base+"/sync")
	next(t, c1, msgSynced)

	send(t, c1, append([]byte{msgUpdate}, []byte("opid-001first")...))
	next(t, c1, msgAck)
	var made struct{ ID string }
	if code := a.do("POST", base+"/versions", map[string]string{"name": "Signed off"}, &made); code != 200 || made.ID == "" {
		t.Fatalf("name a version: %d %q", code, made.ID)
	}
	// Naming again with nothing changed renames rather than duplicates.
	var again struct{ ID string }
	a.do("POST", base+"/versions", map[string]string{"name": "Signed off twice"}, &again)
	if again.ID != made.ID {
		t.Errorf("unchanged document got a second version")
	}

	// An edit after a pause files the state before it, automatically.
	rm := s.hub.room(doc.ID)
	rm.mu.Lock()
	rm.verSeq = 0 // as if the named version had not been taken at this sequence
	rm.updated -= versionIdle + 1
	rm.mu.Unlock()
	s.hub.release(rm)
	send(t, c1, append([]byte{msgUpdate}, []byte("opid-002second")...))
	next(t, c1, msgAck)
	send(t, c1, append([]byte{msgUpdate}, []byte("opid-003third")...))
	next(t, c1, msgAck)

	var list []Version
	a.do("GET", base+"/versions", nil, &list)
	if len(list) != 2 {
		t.Fatalf("versions = %+v, want the named one and an automatic one", list)
	}
	var auto, named Version
	for _, v := range list {
		if v.Auto {
			auto = v
		} else {
			named = v
		}
	}
	if named.Name != "Signed off twice" || auto.Seq != 1 || len(named.Editors) != 1 {
		t.Errorf("named = %+v, auto = %+v", named, auto)
	}
	code, state := a.get(base + "/versions/" + auto.ID)
	if code != 200 || !bytes.Contains(state, []byte("first")) || bytes.Contains(state, []byte("second")) {
		t.Errorf("version state: %d %q", code, state)
	}
	if code := a.do("PATCH", base+"/versions/"+auto.ID, map[string]string{"name": "Before the rewrite"}, nil); code != 200 {
		t.Errorf("rename: %d", code)
	}

	// Restoring replaces the log for everyone and keeps what was there.
	c2 := dial(t, a, base+"/sync")
	next(t, c2, msgSynced)
	if code := a.do("POST", base+"/versions/"+auto.ID+"/restore", nil, nil); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if got := next(t, c2, msgBase); got[0] != 4 {
		t.Errorf("restore base at sequence %d, want 4", got[0])
	}
	if got := next(t, c2, msgUpdate); got[0] != 5 || string(got[1:]) != "opid-001first" {
		t.Errorf("restore replay = %q", got)
	}
	_, now := a.get(base + "/state")
	if !bytes.Contains(now, []byte("first")) || bytes.Contains(now, []byte("third")) {
		t.Errorf("state after restore = %q", now)
	}
	a.do("GET", base+"/versions", nil, &list)
	if len(list) != 3 {
		t.Errorf("%d versions after restore, want 3 (the replaced state is kept)", len(list))
	}
	// A client that was at the old sequence is sent the new base on return.
	c3 := dial(t, a, base+"/sync?since=3")
	if got := next(t, c3, msgBase); got[0] != 4 {
		t.Errorf("resume after restore: base at %d, want 4", got[0])
	}
	// Edits continue from the new sequence.
	send(t, c1, append([]byte{msgUpdate}, []byte("opid-004fourth")...))
	if ack := next(t, c1, msgAck); ack[0] != 6 {
		t.Errorf("first edit after restore got sequence %d, want 6", ack[0])
	}

	// A text document is restored by the app, not here.
	var text Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "doc"}, &text)
	var tv struct{ ID string }
	a.do("POST", "/api/docs/"+text.ID+"/versions", map[string]string{"name": "Draft"}, &tv)
	if code := a.do("POST", "/api/docs/"+text.ID+"/versions/"+tv.ID+"/restore", nil, nil); code != 400 {
		t.Errorf("server-side restore of a text document: %d, want 400", code)
	}
	// A version of one document cannot be read through another.
	if code, _ := a.get("/api/docs/" + text.ID + "/versions/" + auto.ID); code != 404 {
		t.Errorf("version read through the wrong document: %d, want 404", code)
	}
}

func TestVersionAccessAndCommentRole(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a, b := newClient(t, ts), newClient(t, ts)
	a.signup("Alpha", "alice")
	b.signup("Beta", "bob")
	var made struct{ ID, Password string }
	a.do("POST", "/api/admin/users", map[string]string{"name": "Carol", "username": "carol"}, &made)
	carol := newClient(t, ts)
	if code := carol.do("POST", "/api/login", map[string]string{"email": "carol", "password": made.Password}, nil); code != 200 {
		t.Fatalf("login: %d", code)
	}

	var doc, sheet Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Plan"}, &doc)
	a.do("POST", "/api/docs", map[string]string{"kind": "sheet"}, &sheet)
	var v struct{ ID string }
	a.do("POST", "/api/docs/"+doc.ID+"/versions", map[string]string{"name": "v1"}, &v)
	probes := [][2]string{
		{"GET", "/versions"}, {"POST", "/versions"}, {"GET", "/versions/" + v.ID},
		{"PATCH", "/versions/" + v.ID}, {"POST", "/versions/" + v.ID + "/restore"},
	}
	denied := func(who string, c *client) {
		t.Helper()
		for _, p := range probes {
			if code := c.do(p[0], "/api/docs/"+doc.ID+p[1], map[string]string{"name": "x"}, nil); code != 403 {
				t.Errorf("%s: %s %s = %d, want 403", who, p[0], p[1], code)
			}
		}
	}
	denied("another organisation", b)
	denied("a colleague without access", carol)

	share := func(id, role string) {
		a.do("PATCH", "/api/docs/"+id, map[string]any{"shares": []Share{{User: made.ID, Role: role}}}, nil)
	}
	hello := func(id string) byte {
		conn := dial(t, carol, "/api/docs/"+id+"/sync")
		msg := next(t, conn, msgHello)
		conn.CloseNow()
		return msg[len(msg)-1]
	}
	share(doc.ID, "view")
	denied("a viewer", carol)
	if hello(doc.ID) != 0 {
		t.Errorf("a viewer may write")
	}

	// A commenter writes to a text document (comments live in its state) but
	// cannot rename it, see its history, or write to a spreadsheet.
	share(doc.ID, "comment")
	share(sheet.ID, "comment")
	denied("a commenter", carol)
	var listed []Doc
	carol.do("GET", "/api/docs", nil, &listed)
	for _, d := range listed {
		if d.Role != "comment" {
			t.Errorf("%s listed with role %q, want comment", d.Kind, d.Role)
		}
	}
	if hello(doc.ID) != 1 {
		t.Errorf("a commenter cannot write to a text document")
	}
	if hello(sheet.ID) != 0 {
		t.Errorf("a commenter may write to a spreadsheet")
	}
	if code := carol.do("PATCH", "/api/docs/"+doc.ID, map[string]string{"title": "Mine now"}, nil); code != 403 {
		t.Errorf("a commenter renamed the document: %d", code)
	}

	share(doc.ID, "edit")
	if code := carol.do("GET", "/api/docs/"+doc.ID+"/versions", nil, nil); code != 200 {
		t.Errorf("an editor reading history: %d", code)
	}
}

func TestVersionThinning(t *testing.T) {
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var doc Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "doc"}, &doc)
	t0 := time.Now().Unix()
	add := func(id string, created int64, name string) {
		s.w.Exec(`INSERT INTO doc_versions(id, doc_id, seq, created, name, auto, state) VALUES(?,?,?,?,?,?,?)`, id, doc.ID, 1, created, name, name == "", []byte("x"))
	}
	// Six in the last day (all kept), six within one hour three days ago
	// (one kept), six within one day a month ago (one kept), and two named
	// ones (always kept).
	hour := (t0 - 3*86400) / 3600 * 3600
	day := (t0 - 30*86400) / 86400 * 86400
	for i := int64(0); i < 6; i++ {
		add(newID(12), t0-i*600, "")
		add(newID(12), hour+i*60, "")
		add(newID(12), day+i*600, "")
	}
	add("named-recent", hour+30, "Keep me")
	add("named-old", t0-400*86400, "And me")
	s.thinVersions(doc.ID, t0)
	var total, named int
	s.r.QueryRow(`SELECT count(*), sum(name != '') FROM doc_versions WHERE doc_id = ?`, doc.ID).Scan(&total, &named)
	if named != 2 || total != 6+1+1+2 {
		t.Errorf("after thinning: %d versions (%d named), want 10 (2 named)", total, named)
	}
}
