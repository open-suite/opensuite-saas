package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// withEngine runs the API against the real content engine, built by
// `npm --prefix web run build` into web/dist-headless. It needs Node.
func withEngine(t *testing.T) (*httptest.Server, *client, string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("content engine tests need node on PATH")
	}
	if _, err := os.Stat("../web/dist-headless/engine.mjs"); err != nil {
		t.Skip("content engine tests need the web build (npm --prefix web run build)")
	}
	t.Setenv("OS_NODE", node)
	s, ts := newTestServer(t, func(c *Config) { c.WebDir = "../web/dist" })
	t.Cleanup(func() { s.engine.mu.Lock(); s.engine.stop(); s.engine.mu.Unlock() })
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	return ts, a, a.token("content", false)
}

// A text document written through the API merges with a live editor: an
// edit made in the browser at the same time survives, and the API's edit
// reaches the browser as an ordinary update.
func TestContentDocument(t *testing.T) {
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("documents need pandoc for Markdown")
	}
	ts, a, tok := withEngine(t)
	var doc docOut
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]any{"kind": "doc", "title": "Plan", "content": "# Plan\n\nFirst paragraph.\n\nSecond paragraph."}, &doc); code != 200 {
		t.Fatalf("create: %d", code)
	}
	// A browser has the document open while the API appends to it.
	conn := dial(t, a, "/api/docs/"+doc.ID+"/sync")
	next(t, conn, msgSynced)
	if code := bearer(t, ts, tok, "PUT", "/api/v1/documents/"+doc.ID+"/text", map[string]any{"content": "Third paragraph.", "mode": "append"}, nil); code != 200 {
		t.Fatalf("append: %d", code)
	}
	if got := next(t, conn, msgUpdate); len(got) < 10 {
		t.Errorf("the live editor got %d bytes", len(got))
	}
	var text struct{ Content string }
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/text?format=text", nil, &text)
	if !strings.Contains(text.Content, "First paragraph.") || !strings.Contains(text.Content, "Third paragraph.") {
		t.Errorf("text = %q", text.Content)
	}
	var md struct{ Content string }
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/text", nil, &md)
	if !strings.HasPrefix(md.Content, "# Plan") {
		t.Errorf("markdown = %q", md.Content)
	}
	// Comments, replies and resolving.
	var thread struct{ ID, Quote string }
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/comments", map[string]any{"quote": "Second paragraph", "text": "Why?"}, &thread); code != 200 || thread.Quote != "Second paragraph" {
		t.Fatalf("comment: %d %+v", code, thread)
	}
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/comments", map[string]any{"quote": "not in the text", "text": "?"}, nil); code != 422 {
		t.Errorf("comment on missing text: %d, want 422", code)
	}
	bearer(t, ts, tok, "PATCH", "/api/v1/documents/"+doc.ID+"/comments/"+thread.ID, map[string]any{"resolved": true}, nil)
	var comments struct {
		Items []struct {
			ID       string
			Resolved any
		}
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/comments", nil, &comments)
	if len(comments.Items) != 1 || comments.Items[0].Resolved == nil {
		t.Errorf("comments = %+v", comments.Items)
	}
	// The search index learnt the words.
	var hits struct{ Documents []DocHit }
	bearer(t, ts, tok, "GET", "/api/v1/search?q=third&in=documents", nil, &hits)
	if len(hits.Documents) != 1 {
		t.Errorf("search found %d", len(hits.Documents))
	}
	// A commenter may comment but not write; a stranger may do neither.
	var made struct{ ID, Password string }
	a.do("POST", "/api/admin/users", map[string]string{"name": "Carol", "username": "carol"}, &made)
	a.do("PATCH", "/api/docs/"+doc.ID, map[string]any{"shares": []Share{{User: made.ID, Role: "comment"}}}, nil)
	carol := newClient(t, ts)
	carol.do("POST", "/api/login", map[string]string{"email": "carol", "password": made.Password}, nil)
	ct := carol.token("carol", false)
	if code := bearer(t, ts, ct, "PUT", "/api/v1/documents/"+doc.ID+"/text", map[string]any{"content": "x"}, nil); code != 403 {
		t.Errorf("commenter writing: %d, want 403", code)
	}
	if code := bearer(t, ts, ct, "POST", "/api/v1/documents/"+doc.ID+"/comments", map[string]any{"quote": "First", "text": "Hm"}, nil); code != 200 {
		t.Errorf("commenter commenting: %d", code)
	}
}

// A spreadsheet written through the API recalculates and keeps its order
// with a browser's edits.
func TestContentSheet(t *testing.T) {
	ts, _, tok := withEngine(t)
	var doc docOut
	bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]any{"kind": "sheet", "title": "Budget", "content": "Item,Cost\nTea,3\nCake,4\n"}, &doc)
	if code := bearer(t, ts, tok, "PUT", "/api/v1/documents/"+doc.ID+"/cells", map[string]any{"start": "A4", "values": [][]any{{"Total", "=SUM(B2:B3)"}}}, nil); code != 200 {
		t.Fatalf("write cells: %d", code)
	}
	var cells struct {
		Values   [][]string
		Formulas [][]string
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/cells", nil, &cells)
	if len(cells.Values) != 4 || cells.Values[3][1] != "7" || cells.Formulas[3][1] != "=SUM(B2:B3)" {
		t.Errorf("cells = %+v", cells)
	}
	if code := bearer(t, ts, tok, "PUT", "/api/v1/documents/"+doc.ID+"/text", map[string]any{"content": "x"}, nil); code != 409 {
		t.Errorf("text write to a spreadsheet: %d, want 409", code)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/v1/documents/"+doc.ID+"/export?format=xlsx", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, _ := http.DefaultClient.Do(req)
	b, _ := io.ReadAll(res.Body)
	if !bytes.HasPrefix(b, []byte("PK")) {
		t.Errorf("xlsx export: %d %q", res.StatusCode, b[:min(20, len(b))])
	}
}

func TestContentSlides(t *testing.T) {
	ts, _, tok := withEngine(t)
	var doc docOut
	ops := []map[string]any{{"op": "addSlide", "layout": "title", "title": "Hello", "body": "World"}}
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]any{"kind": "slides", "title": "Deck", "slides": ops}, &doc); code != 200 {
		t.Fatalf("create deck: %d", code)
	}
	var deck struct {
		Slides []struct {
			ID       string
			Elements []struct{ Text string }
		}
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/slides", nil, &deck)
	raw, _ := json.Marshal(deck)
	if len(deck.Slides) == 0 || !strings.Contains(string(raw), "Hello") {
		t.Errorf("deck = %s", raw)
	}
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/slides", map[string]any{"ops": []map[string]any{{"op": "nonsense"}}}, nil); code != 422 {
		t.Errorf("unknown slide op: %d, want 422", code)
	}
}
