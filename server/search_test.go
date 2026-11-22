package main

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

type searchReply struct {
	Docs []DocHit `json:"docs"`
}

func find(c *client, q string) []DocHit {
	c.t.Helper()
	var out searchReply
	if code := c.do("GET", "/api/search?q="+url.QueryEscape(q), nil, &out); code != 200 {
		c.t.Fatalf("search %q: %d", q, code)
	}
	return out.Docs
}

func titles(hits []DocHit) string {
	var t []string
	for _, h := range hits {
		t = append(t, h.Title)
	}
	return strings.Join(t, ",")
}

// writeText plays an editor: it joins the document and offers its plain text.
func writeText(t *testing.T, c *client, id, text string) {
	t.Helper()
	conn := dial(t, c, "/api/docs/"+id+"/sync")
	next(t, conn, msgSynced)
	send(t, conn, append([]byte{msgText}, text...))
	// The text is stored by the connection's reader; an update sent after it
	// is acknowledged only once the text before it has been handled.
	send(t, conn, append([]byte{msgUpdate}, []byte("op-"+id[:5]+"x")...))
	next(t, conn, msgAck)
	conn.CloseNow()
}

func TestFtsQuery(t *testing.T) {
	for in, want := range map[string]string{
		"":                  "",
		"  budget ":         `"budget"*`,
		"Q3 budget":         `"Q3"* "budget"*`,
		`"x" OR y* (z) -a`:  `"x"* "OR"* "y"* "z"* "a"*`,
		"café-crème":        `"café"* "crème"*`,
		"a b c d e f g h i": `"a"* "b"* "c"* "d"* "e"* "f"* "g"* "h"*`,
	} {
		if got := ftsQuery(in); got != want {
			t.Errorf("ftsQuery(%q) = %s, want %s", in, got, want)
		}
	}
}

// Search must respect exactly the rule that decides who may open a document:
// never another organisation's, never someone else's private one, never a
// trashed one, and a person with read-only access cannot feed the index.
func TestSearchPermissions(t *testing.T) {
	_, ts := newTestServer(t, nil)
	alice, bob := newClient(t, ts), newClient(t, ts)
	alice.signup("Alpha", "alice")
	bob.signup("Beta", "bob")

	var carolAcct, daveAcct struct{ ID, Password string }
	alice.do("POST", "/api/admin/users", map[string]string{"name": "Carol", "username": "carol"}, &carolAcct)
	alice.do("POST", "/api/admin/users", map[string]string{"name": "Dave", "username": "dave"}, &daveAcct)
	carol, dave := newClient(t, ts), newClient(t, ts)
	carol.do("POST", "/api/login", map[string]string{"email": "carol", "password": carolAcct.Password}, nil)
	dave.do("POST", "/api/login", map[string]string{"email": "dave", "password": daveAcct.Password}, nil)

	mk := func(c *client, kind, title, text string) Doc {
		var d Doc
		if code := c.do("POST", "/api/docs", map[string]string{"kind": kind, "title": title}, &d); code != 200 {
			t.Fatalf("create %s: %d", title, code)
		}
		if text != "" {
			writeText(t, c, d.ID, text)
		}
		return d
	}
	private := mk(alice, "doc", "Private notes", "The zeppelin budget is confidential.")
	shared := mk(alice, "doc", "Company handbook", "Everyone may read about the zeppelin policy.")
	named := mk(alice, "sheet", "Hangar costs", "zeppelin hangar rent 4200")
	viewOnly := mk(alice, "doc", "Board minutes", "zeppelin vote passed")
	mk(bob, "doc", "Beta roadmap", "Our own zeppelin plans.")

	alice.do("PATCH", "/api/docs/"+shared.ID, map[string]string{"access": "org"}, nil)
	alice.do("PATCH", "/api/docs/"+named.ID, map[string]any{"shares": []Share{{User: carolAcct.ID, Role: "edit"}}}, nil)
	alice.do("PATCH", "/api/docs/"+viewOnly.ID, map[string]any{"shares": []Share{{User: carolAcct.ID, Role: "view"}}}, nil)

	want := func(who string, c *client, q string, n int) []DocHit {
		t.Helper()
		hits := find(c, q)
		if len(hits) != n {
			t.Errorf("%s searching %q found %d (%s), want %d", who, q, len(hits), titles(hits), n)
		}
		return hits
	}
	want("owner", alice, "zeppelin", 4)
	want("another organisation", bob, "zeppelin", 1)
	if h := find(bob, "zeppelin"); len(h) == 1 && h[0].Title != "Beta roadmap" {
		t.Errorf("another organisation found %q", h[0].Title)
	}
	want("named colleague", carol, "zeppelin", 3)        // handbook, hangar costs, board minutes
	want("colleague with no share", dave, "zeppelin", 1) // handbook only
	want("another organisation, by title", bob, "handbook", 0)
	want("colleague, private title", dave, "private notes", 0)

	// Prefixes, several words, titles, accents and case.
	want("prefix", alice, "zepp", 4)
	want("two words", alice, "zeppelin hangar", 1)
	want("title", alice, "handb", 1)
	want("title and text", alice, "hangar 4200", 1)
	want("no match", alice, "zeppelin submarine", 0)
	want("syntax characters", alice, `"zeppelin" OR (`, 0) // "OR" is just a word here
	want("empty", alice, "   ", 0)
	accents := mk(alice, "doc", "Menu", "Crème brûlée for the café")
	want("accents folded", alice, "creme brulee", 1)
	alice.do("DELETE", "/api/docs/"+accents.ID, nil, nil)
	want("deleted", alice, "creme", 0)

	// The snippet marks the matched word.
	hits := find(carol, "hangar rent")
	if len(hits) != 1 || !strings.Contains(hits[0].Snippet, "\x02hangar\x03 \x02rent\x03") || hits[0].Kind != "sheet" {
		t.Errorf("snippet = %+v", hits)
	}

	// A reader cannot change what the index says about a document.
	conn := dial(t, carol, "/api/docs/"+viewOnly.ID+"/sync")
	next(t, conn, msgSynced)
	send(t, conn, append([]byte{msgText}, "poisoned by a reader"...))
	time.Sleep(150 * time.Millisecond)
	conn.CloseNow()
	want("reader's text ignored", alice, "poisoned", 0)
	want("original text kept", alice, "zeppelin vote", 1)

	// Renaming re-indexes the title; trashing hides the document.
	alice.do("PATCH", "/api/docs/"+shared.ID, map[string]string{"title": "Staff manual"}, nil)
	want("old title", dave, "handbook", 0)
	want("new title", dave, "manual", 1)
	alice.do("PATCH", "/api/docs/"+shared.ID, map[string]bool{"trashed": true}, nil)
	want("trashed", dave, "zeppelin", 0)
	want("trashed, owner", alice, "manual", 0)

	// Unsharing takes effect at once.
	alice.do("PATCH", "/api/docs/"+named.ID, map[string]any{"shares": []Share{}}, nil)
	want("after unsharing", carol, "hangar", 0)
	_ = private
}

// A document from before search existed (or whose editor closed before the
// text was sent) is flagged in the hello message so the next editor sends it.
func TestSearchBackfillFlag(t *testing.T) {
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var d Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Notes"}, &d)
	path := "/api/docs/" + d.ID + "/sync"

	fresh := func() byte {
		t.Helper()
		conn := dial(t, a, path)
		defer conn.CloseNow()
		hello := next(t, conn, msgHello)
		return hello[len(hello)-1]
	}
	if fresh() != 1 {
		t.Error("an empty document should not be asked for its text")
	}
	conn := dial(t, a, path)
	next(t, conn, msgSynced)
	send(t, conn, append([]byte{msgUpdate}, []byte("opid-001data")...))
	next(t, conn, msgAck)
	if fresh() != 0 {
		t.Error("an edit without text should leave the index stale")
	}
	send(t, conn, append([]byte{msgText}, "hello world"...))
	send(t, conn, append([]byte{msgUpdate}, []byte("opid-002data")...))
	next(t, conn, msgAck)
	if fresh() != 0 {
		t.Error("an edit after the text should leave the index stale again")
	}
	send(t, conn, append([]byte{msgText}, "hello wider world"...))
	send(t, conn, append([]byte{msgSnapshot, 2}, []byte("STATE")...)) // handled after the text
	time.Sleep(150 * time.Millisecond)
	if fresh() != 1 {
		t.Error("text sent after the last edit should make the index fresh")
	}
	if got := find(a, "wider"); len(got) != 1 {
		t.Errorf("replaced text not searchable: %+v", got)
	}

	// Documents that predate the index are picked up when the server starts.
	s.w.Exec(`DELETE FROM doc_text`)
	if got := find(a, "notes"); len(got) != 0 {
		t.Fatalf("index not emptied: %+v", got)
	}
	if _, err := s.w.Exec(searchSchema); err != nil {
		t.Fatal(err)
	}
	if got := find(a, "notes"); len(got) != 1 {
		t.Errorf("title not backfilled: %+v", got)
	}
	if fresh() != 0 {
		t.Error("a backfilled document should be asked for its text")
	}
}
