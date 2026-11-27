package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func zipText(t *testing.T, data []byte, name string) string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	for _, f := range zr.File {
		if f.Name == name {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			return string(b)
		}
	}
	return ""
}

func download(t *testing.T, base, tok, path string) []byte {
	t.Helper()
	req, _ := http.NewRequest("GET", base+path, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("GET %s: %v %v", path, err, res.Status)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return b
}

func upload(t *testing.T, base, tok, path string, body []byte, out any) int {
	t.Helper()
	req, _ := http.NewRequest("POST", base+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		b, _ := io.ReadAll(res.Body)
		json.Unmarshal(b, out)
	}
	return res.StatusCode
}

// Formatting, page setup, footnotes, contents and page breaks go in through
// the API, come out in Word and OpenDocument files, and come back from a
// Word file as they went.
func TestDocumentFormatting(t *testing.T) {
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("documents need pandoc")
	}
	ts, _, tok := withEngine(t)
	html := `<nav data-toc></nav><h1 style="text-align: center">Report</h1>` +
		`<p style="line-height: 2" data-indent="1">Plain <span style="font-family: Georgia, serif; font-size: 14pt; color: #c0392b">red Georgia</span> text<sup data-footnote="A note about it."></sup>.</p>` +
		`<div data-page-break></div><h2>Next part</h2><p>Second page, about the cat and the Cat.</p>`
	var doc docOut
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]any{"kind": "doc", "title": "Formatted", "content": html, "format": "html"}, &doc); code != 200 {
		t.Fatalf("create: %d", code)
	}
	var read struct {
		Content string
		Words   int
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/text?format=html", nil, &read)
	for _, want := range []string{"data-toc", "font-family: Georgia", "font-size: 14pt", "data-footnote=\"A note about it.\"", "data-page-break", "line-height: 2", "data-indent=\"1\"", "text-align: center"} {
		if !strings.Contains(read.Content, want) {
			t.Errorf("html lacks %q: %s", want, read.Content)
		}
	}
	if read.Words != 15 {
		t.Errorf("words = %d, want 15", read.Words)
	}
	var md struct{ Content string }
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/text", nil, &md)
	if !strings.Contains(md.Content, "[^1]") || !strings.Contains(md.Content, "A note about it.") {
		t.Errorf("markdown has no footnote: %s", md.Content)
	}

	// Find and replace: whole words, then case.
	var rep struct{ Replaced int }
	bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/replace", map[string]any{"find": "cat", "replace": "dog", "matchCase": true, "wholeWord": true}, &rep)
	if rep.Replaced != 1 {
		t.Errorf("replaced %d, want 1", rep.Replaced)
	}
	bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/replace", map[string]any{"find": "cat", "replace": "dog"}, &rep)
	if rep.Replaced != 1 {
		t.Errorf("replaced %d, want 1 (the capitalised one)", rep.Replaced)
	}
	var plain struct{ Content string }
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/text?format=text", nil, &plain)
	if !strings.Contains(plain.Content, "the dog and the dog") {
		t.Errorf("after replacing: %q", plain.Content)
	}

	// Page setup.
	var page map[string]any
	if code := bearer(t, ts, tok, "PATCH", "/api/v1/documents/"+doc.ID+"/page", map[string]any{"size": "letter", "orientation": "landscape", "top": 30, "footer": "Page {page} of {pages}", "footerAlign": "right", "header": "{title}"}, &page); code != 200 {
		t.Fatalf("page setup: %d", code)
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/page", nil, &page)
	if page["size"] != "letter" || page["orientation"] != "landscape" || page["top"] != 30.0 || page["footer"] != "Page {page} of {pages}" || page["left"] != 25.4 {
		t.Errorf("page = %v", page)
	}
	if code := bearer(t, ts, tok, "PATCH", "/api/v1/documents/"+doc.ID+"/page", map[string]any{"size": "tabloid", "top": 500}, &page); code != 200 || page["size"] != "letter" || page["top"] != 30.0 {
		t.Errorf("nonsense page setup changed it: %d %v", code, page)
	}

	// Word.
	docx := download(t, ts.URL, tok, "/api/v1/documents/"+doc.ID+"/export?format=docx")
	if p := os.Getenv("OS_TEST_DOCX"); p != "" {
		os.WriteFile(p, docx, 0o644)
	}
	styles := zipText(t, docx, "word/styles.xml")
	body := zipText(t, docx, "word/document.xml")
	footer := zipText(t, docx, "word/footer-os.xml")
	for name, check := range map[string]bool{
		"font":           strings.Contains(styles, `w:ascii="Georgia"`),
		"colour":         strings.Contains(styles, `<w:color w:val="C0392B"/>`),
		"size":           strings.Contains(styles, `<w:sz w:val="28"/>`),
		"line spacing":   strings.Contains(styles, `<w:spacing w:line="480" w:lineRule="auto"/>`),
		"indent":         strings.Contains(styles, `<w:ind w:left="540"/>`),
		"page break":     strings.Contains(styles, `<w:pageBreakBefore/>`),
		"heading centre": strings.Contains(body, `<w:jc w:val="center"/>`),
		"paper":          strings.Contains(body, `w:orient="landscape"`) && strings.Contains(body, `<w:pgSz w:w="15840" w:h="12240"`),
		"margin":         strings.Contains(body, `w:top="1701"`),
		"footer field":   strings.Contains(footer, `w:instr=" PAGE "`) && strings.Contains(footer, `w:instr=" NUMPAGES "`),
		"footer align":   strings.Contains(footer, `<w:jc w:val="right"/>`),
		"header title":   strings.Contains(zipText(t, docx, "word/header-os.xml"), "Formatted"),
		"rels":           strings.Contains(zipText(t, docx, "word/_rels/document.xml.rels"), "footer-os.xml"),
		"footnote":       strings.Contains(zipText(t, docx, "word/footnotes.xml"), "A note about it."),
		"contents":       strings.Contains(body, `w:anchor="`),
	} {
		if !check {
			t.Errorf("Word file: no %s", name)
		}
	}

	// And back: the Word file imports with its formatting and page setup.
	var back docOut
	if code := upload(t, ts.URL, tok, "/api/v1/documents/import?name=Back.docx", docx, &back); code != 200 {
		t.Fatalf("import: %d", code)
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+back.ID+"/text?format=html", nil, &read)
	// (A heading's alignment reaches Word but does not come back: pandoc
	// keeps no formatting of headings.)
	for _, want := range []string{"font-family: Georgia", "font-size: 14pt", "color: #c0392b", "data-page-break", "data-footnote=\"A note about it.\"", "line-height: 2", "data-indent=\"1\"", "<nav data-toc"} {
		if !strings.Contains(read.Content, want) {
			t.Errorf("imported html lacks %q: %s", want, read.Content)
		}
	}
	if strings.Contains(read.Content, "Contents</strong>") {
		t.Errorf("the contents came back as text: %s", read.Content)
	}
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+back.ID+"/page", nil, &page)
	if page["size"] != "letter" || page["orientation"] != "landscape" || page["footer"] != "Page {page} of {pages}" || page["footerAlign"] != "right" {
		t.Errorf("imported page = %v", page)
	}

	// OpenDocument.
	odt := download(t, ts.URL, tok, "/api/v1/documents/"+doc.ID+"/export?format=odt")
	ostyles := zipText(t, odt, "styles.xml")
	for name, check := range map[string]bool{
		"text style":   strings.Contains(ostyles, `fo:font-family="Georgia"`) && strings.Contains(ostyles, `fo:color="#c0392b"`),
		"page break":   strings.Contains(ostyles, `fo:break-before="page"`),
		"paper":        strings.Contains(ostyles, `fo:page-width="279.4mm"`) && strings.Contains(ostyles, `style:print-orientation="landscape"`),
		"footer":       strings.Contains(ostyles, `<text:page-number`) && strings.Contains(ostyles, `<text:page-count`),
		"line spacing": strings.Contains(ostyles, `fo:line-height="200%"`),
	} {
		if !check {
			t.Errorf("OpenDocument file: no %s", name)
		}
	}
	if zipText(t, odt, "mimetype") != "application/vnd.oasis.opendocument.text" {
		t.Error("OpenDocument mimetype lost")
	}

	// A web page keeps the page setup for printing.
	web := string(download(t, ts.URL, tok, "/api/v1/documents/"+doc.ID+"/export?format=html"))
	if !strings.Contains(web, "@page") || !strings.Contains(web, "counter(page)") || !strings.Contains(web, "footnote-ref") {
		t.Errorf("html export: %s", web)
	}
}

// Restoring a version brings its page setup back with its text.
func TestDocumentRestorePage(t *testing.T) {
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("documents need pandoc")
	}
	ts, a, tok := withEngine(t)
	var doc docOut
	bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]any{"kind": "doc", "title": "Pages", "content": "Text."}, &doc)
	bearer(t, ts, tok, "PATCH", "/api/v1/documents/"+doc.ID+"/page", map[string]any{"size": "a5", "header": "Draft"}, nil)
	var v struct{ ID string }
	a.do("POST", "/api/docs/"+doc.ID+"/versions", map[string]string{"name": "A5"}, &v)
	bearer(t, ts, tok, "PATCH", "/api/v1/documents/"+doc.ID+"/page", map[string]any{"size": "a4", "header": ""}, nil)
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents/"+doc.ID+"/versions/"+v.ID+"/restore", nil, nil); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	var page map[string]any
	bearer(t, ts, tok, "GET", "/api/v1/documents/"+doc.ID+"/page", nil, &page)
	if page["size"] != "a5" || page["header"] != "Draft" {
		t.Errorf("after restore page = %v", page)
	}
}
