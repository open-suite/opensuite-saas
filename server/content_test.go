package main

import (
	"archive/zip"
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

// The menus' spreadsheet tools through the API: sort, filter, freeze,
// formatting, rules, validation, a pivot table that follows its data, find
// and replace, and an Excel file that keeps the filter and validation.
func TestContentSheetOps(t *testing.T) {
	ts, _, tok := withEngine(t)
	var doc docOut
	bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]any{"kind": "sheet", "title": "Sales", "content": "Region,Rep,Amount\nNorth,Ann,10\nSouth,Bob,20\nNorth,Cy,5\nEast,Di,7\n"}, &doc)
	edit := func(ops ...map[string]any) []json.RawMessage {
		t.Helper()
		var res struct{ Results []json.RawMessage }
		if code := bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/sheet-ops", map[string]any{"ops": ops}, &res); code != 200 {
			t.Fatalf("sheet-ops %v: %d", ops, code)
		}
		return res.Results
	}
	read := func(rng string) [][]string {
		t.Helper()
		var cells struct{ Values [][]string }
		bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/cells?range="+rng, nil, &cells)
		return cells.Values
	}
	edit(
		map[string]any{"op": "sort", "range": "A1:C5", "header": true, "by": []map[string]any{{"column": "C", "desc": true}}},
		map[string]any{"op": "freeze", "rows": 1},
		map[string]any{"op": "format", "range": "A1:C1", "bold": true, "font": "Georgia", "fill": "#ffec99", "wrap": "wrap"},
		map[string]any{"op": "filter", "range": "A1:C5", "criteria": map[string]any{"A": map[string]any{"hidden": []string{"East"}}}},
		map[string]any{"op": "conditionalFormat", "range": "C2:C5", "cond": "GreaterThan", "a": "8", "format": map[string]any{"fill": "#d3f9d8", "bold": true}},
		map[string]any{"op": "validation", "range": "A2:A5", "rule": map[string]any{"type": "list", "values": []string{"North", "South", "East"}}},
	)
	if got := read("C2:C5"); got[0][0] != "20" || got[3][0] != "5" {
		t.Errorf("sorted amounts = %v", got)
	}
	res := edit(map[string]any{"op": "pivot", "source": "A1:C5", "rows": []string{"A"}, "values": []map[string]any{{"column": "C", "fn": "SUM"}}})
	var made struct{ ID, Sheet string }
	json.Unmarshal(res[0], &made)
	if made.ID == "" || made.Sheet != "Pivot table" {
		t.Fatalf("pivot result = %s", res[0])
	}
	var pv struct{ Values [][]string }
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/cells?sheet=Pivot%20table", nil, &pv)
	want := [][]string{{"Region", "Sum of Amount"}, {"East", "7"}, {"North", "15"}, {"South", "20"}, {"Grand total", "42"}}
	if !equalRows(pv.Values, want) {
		t.Errorf("pivot = %v, want %v", pv.Values, want)
	}
	// New data: a new region gets its own row, without touching the pivot.
	bearer(t, ts, tok, "PUT", "/api/v1/documents/"+doc.ID+"/cells", map[string]any{"start": "A6", "values": [][]any{{"West", "Ed", 3}}}, nil)
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/cells?sheet=Pivot%20table", nil, &pv)
	if len(pv.Values) != 6 || pv.Values[4][0] != "West" || pv.Values[5][1] != "45" {
		t.Errorf("pivot after new data = %v", pv.Values)
	}
	res = edit(map[string]any{"op": "replace", "find": "North", "replace": "Nord", "matchCase": true})
	if string(res[0]) != `{"replaced":2}` {
		t.Errorf("replace = %s", res[0])
	}
	var setup struct {
		Sheets []struct {
			Name               string
			FrozenRows         int
			Filter             *struct{ Range string }
			ConditionalFormats []any
			Validation         []any
			PivotTable         *struct{ Source string }
		}
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/sheet-setup", nil, &setup)
	if len(setup.Sheets) != 2 || setup.Sheets[0].FrozenRows != 1 || setup.Sheets[0].Filter == nil || len(setup.Sheets[0].ConditionalFormats) != 1 || len(setup.Sheets[0].Validation) != 1 || setup.Sheets[1].PivotTable == nil {
		t.Errorf("setup = %+v", setup)
	}
	// Excel gets the filter, the validation and the rows the filter hides.
	req, _ := http.NewRequest("GET", ts.URL+"/api/v1/documents/"+doc.ID+"/export?format=xlsx", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	r, _ := http.DefaultClient.Do(req)
	b, _ := io.ReadAll(r.Body)
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("xlsx: %v", err)
	}
	var sheet1 string
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			rc, _ := f.Open()
			x, _ := io.ReadAll(rc)
			sheet1 = string(x)
		}
	}
	for _, part := range []string{`<autoFilter ref="A1:C6">`, `<dataValidation type="list"`, `hidden="1"`, `<pane `, `<conditionalFormatting sqref="C2:C5"`} {
		if !strings.Contains(sheet1, part) {
			t.Errorf("sheet1.xml lacks %s", part)
		}
	}
	// And reads them back in.
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/documents/import?name=back.xlsx", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+tok)
	r, _ = http.DefaultClient.Do(req)
	var back docOut
	json.NewDecoder(r.Body).Decode(&back)
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+back.ID+"/sheet-setup", nil, &setup)
	if len(setup.Sheets) < 1 || setup.Sheets[0].Filter == nil || len(setup.Sheets[0].Validation) != 1 || len(setup.Sheets[0].ConditionalFormats) != 1 {
		t.Errorf("imported setup = %+v", setup)
	}
	// Bad ops say what is wrong.
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/sheet-ops", map[string]any{"ops": []map[string]any{{"op": "sort", "range": "nonsense"}}}, nil); code != 422 && code != 400 {
		t.Errorf("bad op: %d", code)
	}
}

func equalRows(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if strings.Join(a[i], "|") != strings.Join(b[i], "|") {
			return false
		}
	}
	return true
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
