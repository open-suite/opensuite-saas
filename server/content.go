package main

// Reading and writing what is inside documents, spreadsheets and
// presentations. The content engine (engine.go) does the format work; this
// file decides who may do what, fetches a document's state, and feeds the
// engine's answer back through the same path as a browser's edit
// (applyUpdate), so it is stored, versioned, indexed for search and sent to
// everyone who has the document open, and merges with what they are typing.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"html"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type engineState struct {
	Base    string   `json:"base"`
	Updates []string `json:"updates"`
}

// framesState turns stored frames (versions.go stateFrames) into the form the
// engine takes: the base snapshot and the updates in server order, without
// the ids their authors tagged them with.
func framesState(frames []byte) (engineState, bool) {
	st := engineState{Updates: []string{}}
	for pos := 0; pos < len(frames); {
		n, used := readVarint(frames[pos:])
		if used <= 0 || pos+used+int(n) > len(frames) || n == 0 {
			return st, false
		}
		msg := frames[pos+used : pos+used+int(n)]
		pos += used + int(n)
		_, skip := readVarint(msg[1:])
		body := msg[1+skip:]
		switch msg[0] {
		case msgBase:
			st.Base = base64.StdEncoding.EncodeToString(body)
		case msgUpdate:
			if len(body) > 8 {
				st.Updates = append(st.Updates, base64.StdEncoding.EncodeToString(body[8:]))
			}
		}
	}
	return st, true
}

func (s *Server) docState(id string) (engineState, bool) {
	frames, _, found := s.stateFrames(id)
	if !found {
		return engineState{}, false
	}
	return framesState(frames)
}

// content runs an engine request for a member, answering its questions
// within the member's organisation, and reports failure on w.
func (s *Server) content(w http.ResponseWriter, r *http.Request, u *User, op string, args any, out any) bool {
	res, err := s.engine.run(r.Context(), op, args, func(call string, raw json.RawMessage) any {
		switch call {
		case "blob":
			var a struct{ Src string }
			json.Unmarshal(raw, &a)
			return s.blobForEngine(u, a.Src)
		case "store":
			var a struct{ Name, Mime, Data string }
			json.Unmarshal(raw, &a)
			data, err := base64.StdEncoding.DecodeString(a.Data)
			if err != nil {
				return nil
			}
			id, code, _ := s.storeBlob(u, a.Name, a.Mime, bytes.NewReader(data))
			if code != 0 {
				return nil
			}
			return map[string]string{"url": "/api/blobs/" + id}
		}
		return nil
	})
	if err != nil {
		if msg, refused := err.(engineError); refused {
			fail(w, 422, string(msg))
		} else {
			fail(w, 503, "Documents can't be read or changed through the API right now. Try again shortly.")
		}
		return false
	}
	if json.Unmarshal(res, out) != nil {
		fail(w, 500, "The content engine gave an unexpected answer.")
		return false
	}
	return true
}

var blobSrc = regexp.MustCompile(`^/api/(?:v1/)?blobs/([a-z0-9]{20})$`)

func (s *Server) blobForEngine(u *User, src string) any {
	m := blobSrc.FindStringSubmatch(src)
	if m == nil {
		return nil
	}
	var mime string
	if s.r.QueryRow(`SELECT mime FROM blobs WHERE id = ? AND org_id = ?`, m[1], u.OrgID).Scan(&mime) != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "blobs", m[1]))
	if err != nil {
		return nil
	}
	out := map[string]any{"data": base64.StdEncoding.EncodeToString(data), "mime": mime}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		out["w"], out["h"] = cfg.Width, cfg.Height
	}
	return out
}

// writeUpdate stores an update made on the member's behalf and sends it to
// everyone with the document open, exactly as if their browser had sent it.
// text is the document's plain text afterwards, for the search index; a
// change beside the text (a comment) passes nil and leaves the index be.
func (s *Server) writeUpdate(u *User, id, update string, text *string) {
	rm := s.hub.room(id)
	defer s.hub.release(rm)
	if data, err := base64.StdEncoding.DecodeString(update); err == nil && len(data) > 0 {
		s.applyUpdate(rm, nil, u.ID, append([]byte(newID(8)), data...))
	}
	if text != nil {
		s.indexText(rm, []byte(*text))
	}
}

type engineWrite struct {
	Update string `json:"update"`
	Text   string `json:"text"`
}

// docFor checks access for content operations; need is what the caller wants
// to do: read, edit or comment.
func (s *Server) contentDoc(w http.ResponseWriter, r *http.Request, u *User, kind, need string) (string, bool) {
	id := r.PathValue("id")
	role, k := s.docRole(u, id)
	switch {
	case role == "":
		fail(w, 404, "That document doesn't exist, or you can't open it.")
	case kind != "" && k != kind:
		fail(w, 409, "That is a "+kindNames[k]+"; this operation is for a "+kindNames[kind]+".")
	case need == "edit" && !canEdit(role):
		fail(w, 403, "You can read this document but not change it.")
	case need == "comment" && !canWrite(role, k):
		fail(w, 403, "You can read this document but not comment on it.")
	default:
		return k, true
	}
	return "", false
}

var kindNames = map[string]string{"doc": "text document", "sheet": "spreadsheet", "slides": "presentation"}

func (s *Server) stateOf(w http.ResponseWriter, id string) (engineState, bool) {
	st, found := s.docState(id)
	if !found {
		fail(w, 404, "That document doesn't exist.")
	}
	return st, found
}

// --- formats ------------------------------------------------------------------

// pandoc converts with the same sandboxed tool as /api/convert.
func (s *Server) pandoc(ctx context.Context, from, to string, in []byte) ([]byte, error) {
	c, found := conversions[from+">"+to]
	if !found {
		return nil, engineError("That conversion isn't supported.")
	}
	return runPandoc(ctx, c, from, bytes.NewReader(in))
}

func textHTML(text string) string {
	var out strings.Builder
	for _, para := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
		out.WriteString("<p>" + strings.ReplaceAll(html.EscapeString(para), "\n", "<br>") + "</p>")
	}
	return out.String()
}

// toHTML reads text an agent wrote into the HTML the editor understands.
func (s *Server) toHTML(ctx context.Context, format, content string) (string, error) {
	switch format {
	case "", "markdown":
		out, err := s.pandoc(ctx, "md", "html", []byte(content))
		return string(out), err
	case "html":
		return content, nil
	case "text":
		return textHTML(content), nil
	}
	return "", engineError("format is markdown, html or text.")
}

var imgSrc = regexp.MustCompile(`(<img[^>]*\ssrc=")(/api/blobs/[a-z0-9]{20})(")`)

// pictures rewrites the addresses of pictures in a document: for reading
// through the API (where /api/v1/blobs answers to the same credentials), or
// inlined for a file that has to stand on its own.
func (s *Server) pictures(r *http.Request, u *User, h string, inline bool) string {
	return imgSrc.ReplaceAllStringFunc(h, func(m string) string {
		parts := imgSrc.FindStringSubmatch(m)
		if !inline {
			return parts[1] + baseURL(r) + strings.Replace(parts[2], "/api/", "/api/v1/", 1) + parts[3]
		}
		b, _ := s.blobForEngine(u, parts[2]).(map[string]any)
		if b == nil {
			return m
		}
		return parts[1] + "data:" + b["mime"].(string) + ";base64," + b["data"].(string) + parts[3]
	})
}

// --- operations -----------------------------------------------------------------

func (s *Server) contentOps() []*apiOp {
	id := pathParam("id", "Document id.")
	thread := pathParam("thread", "Comment thread id.")
	commentSchema := object(js{
		"id":       str("Thread id."),
		"quote":    str("The text it is about."),
		"author":   object(js{"id": str(""), "name": str("")}),
		"at":       integer("Unix milliseconds."),
		"text":     str(""),
		"resolved": anyObject("Who resolved it and when, or null."),
		"replies":  array(object(js{"id": str(""), "author": object(js{"id": str(""), "name": str("")}), "at": integer(""), "text": str("")}), ""),
	}, "id", "text")
	slideOp := object(js{
		"op":       enum("What to do.", "addSlide", "setText", "setNotes", "moveSlide", "deleteSlide", "setTheme"),
		"slide":    str("Slide id (setText, setNotes, moveSlide, deleteSlide)."),
		"element":  str("Element id of a text box (setText)."),
		"text":     str("New text of the box (setText)."),
		"layout":   str("Layout of a new slide (addSlide), e.g. title, title-body; read_slides lists those in use."),
		"title":    str("Title of a new slide (addSlide)."),
		"body":     str("Body text of a new slide; lines starting with \"- \" become bullets (addSlide)."),
		"notes":    str("Speaker notes (addSlide, setNotes)."),
		"position": integer("1-based position (addSlide, moveSlide); default the end."),
		"theme":    str("Theme id (setTheme)."),
	}, "op")
	return []*apiOp{
		{Method: "POST", Path: "/api/v1/documents", ID: "create_document", Tag: "Documents", Summary: "Create a document, spreadsheet or presentation", Write: true,
			Desc: "Optionally with first content: text for a document (markdown by default), CSV for a spreadsheet, slide operations for a presentation (as edit_slides).",
			Body: object(js{
				"kind":    enum("", "doc", "sheet", "slides"),
				"title":   str(""),
				"folder":  str("Folder to file it in; absent for your top level."),
				"content": str("A document's text, or a spreadsheet's first sheet as CSV."),
				"format":  enum("How a document's content is written. Default markdown.", "markdown", "html", "text"),
				"slides":  array(slideOp, "A presentation's first slides."),
			}, "kind"),
			Result: ref("Doc"), H: s.handleDocumentCreate},
		{Method: "POST", Path: "/api/v1/documents/import", ID: "import_document", Tag: "Documents", Summary: "Import a file as a new document", Write: true,
			Desc:   "Word (.docx), OpenDocument (.odt), Markdown, HTML or text become a document; Excel (.xlsx) or CSV a spreadsheet; PowerPoint (.pptx) a presentation. The request body is the file.",
			Params: []apiParam{query("name", str("The file's name; its extension decides the kind.")), query("folder", str("Folder to file it in."))},
			Raw:    "The file's bytes.", Result: ref("Doc"), H: s.handleImport},
		{Method: "GET", Path: "/api/v1/documents/{id}/export", ID: "export_document", Tag: "Documents", Summary: "Download a document as a file",
			Desc:   "Documents: docx, odt, md, html or txt. Spreadsheets: xlsx or csv (one sheet). Presentations: pptx.",
			Params: []apiParam{id, query("format", enum("File format.", "docx", "odt", "md", "html", "txt", "xlsx", "csv", "pptx")), query("sheet", str("For csv: the sheet's name or 0-based index."))},
			File:   true, H: s.handleExport},
		{Method: "GET", Path: "/api/v1/documents/{id}/text", ID: "read_document", Tag: "Document content", Summary: "Read a text document",
			Desc:   "As it would read with every suggested change accepted, without comment markings.",
			Params: []apiParam{id, query("format", enum("Default markdown.", "markdown", "html", "text"))},
			Result: object(js{"format": str(""), "content": str("")}, "content"), H: s.handleReadText},
		{Method: "PUT", Path: "/api/v1/documents/{id}/text", ID: "write_document", Tag: "Document content", Summary: "Write a text document", Write: true,
			Desc:   "Replace the whole text, or add to the start or end. Merges with anyone editing at the same time: paragraphs that do not change are kept as they are, with their comments.",
			Params: []apiParam{id},
			Body: object(js{
				"content": str(""),
				"format":  enum("Default markdown.", "markdown", "html", "text"),
				"mode":    enum("Default replace.", "replace", "append", "prepend"),
			}, "content"),
			Result: okResult, H: s.handleWriteText},
		{Method: "GET", Path: "/api/v1/documents/{id}/comments", ID: "list_comments", Tag: "Document content", Summary: "List a document's comments",
			Params: []apiParam{id}, Result: object(js{"items": array(commentSchema, "")}), H: s.handleComments},
		{Method: "POST", Path: "/api/v1/documents/{id}/comments", ID: "add_comment", Tag: "Document content", Summary: "Comment on a passage", Write: true,
			Desc:   "Anchors a new comment thread to a passage, found by its exact text.",
			Params: []apiParam{id},
			Body:   object(js{"quote": str("Exact text in the document the comment is about."), "occurrence": integer("Which occurrence of the quote, from 1 (default)."), "text": str("The comment.")}, "quote", "text"),
			Result: commentSchema, H: s.handleCommentAdd},
		{Method: "POST", Path: "/api/v1/documents/{id}/comments/{thread}/replies", ID: "reply_to_comment", Tag: "Document content", Summary: "Reply to a comment", Write: true,
			Desc: "A reply reopens a resolved thread.", Params: []apiParam{id, thread}, Body: object(js{"text": str("")}, "text"), Result: okResult, H: s.handleCommentReply},
		{Method: "PATCH", Path: "/api/v1/documents/{id}/comments/{thread}", ID: "resolve_comment", Tag: "Document content", Summary: "Resolve or reopen a comment thread", Write: true,
			Params: []apiParam{id, thread}, Body: object(js{"resolved": boolean("")}, "resolved"), Result: okResult, H: s.handleCommentResolve},
		{Method: "GET", Path: "/api/v1/documents/{id}/cells", ID: "read_cells", Tag: "Spreadsheet content", Summary: "Read a spreadsheet's cells",
			Desc:   "Values as shown, and what was typed (formulas), for one sheet's range; also the list of sheets.",
			Params: []apiParam{id, query("sheet", str("Sheet name or 0-based index; default the first.")), query("range", str("A1 notation like A1:D20; default everything used."))},
			Result: object(js{
				"sheets":   array(object(js{"name": str(""), "index": integer(""), "rows": integer(""), "cols": integer("")}), ""),
				"sheet":    str(""),
				"range":    str(""),
				"values":   array(array(str(""), ""), "Rows of formatted values."),
				"formulas": array(array(str(""), ""), "Rows of cell contents as typed."),
				"csv":      str("The range as CSV."),
			}), H: s.handleReadCells},
		{Method: "PUT", Path: "/api/v1/documents/{id}/cells", ID: "write_cells", Tag: "Spreadsheet content", Summary: "Write cells", Write: true,
			Desc:   "Write a block of values starting at a cell (text starting with = is a formula; null leaves a cell as it is), or paste CSV, or clear a range. Recalculates as typing would, and merges with anyone editing.",
			Params: []apiParam{id},
			Body: object(js{
				"sheet":  str("Sheet name or 0-based index; default the first."),
				"start":  str("Top-left cell, like B2. Default A1."),
				"values": array(array(js{"type": []string{"string", "number", "boolean", "null"}}, ""), "Rows of values."),
				"csv":    str("Or CSV to paste at start."),
				"clear":  str("Or a range to empty, like A1:C9."),
			}),
			Result: okResult, H: s.handleWriteCells},
		{Method: "POST", Path: "/api/v1/documents/{id}/sheets", ID: "add_sheet", Tag: "Spreadsheet content", Summary: "Add a sheet", Write: true,
			Params: []apiParam{id}, Body: object(js{"name": str("")}, "name"), Result: okResult, H: s.handleAddSheet},
		{Method: "GET", Path: "/api/v1/documents/{id}/slides", ID: "read_slides", Tag: "Presentation content", Summary: "Read a presentation",
			Desc:   "Every slide in order with its layout, notes and elements (text boxes with their text, pictures, lines), and the theme.",
			Params: []apiParam{id}, Result: anyObject("{theme, slides:[{id, position, layout, notes, elements:[{id, type, role, text, html, x, y, w, h, ...}]}]}"), H: s.handleReadSlides},
		{Method: "POST", Path: "/api/v1/documents/{id}/slides", ID: "edit_slides", Tag: "Presentation content", Summary: "Change a presentation", Write: true,
			Desc:   "Applies operations in order, as one change: add a slide with a title, body and notes; replace a text box's text; change notes; move or delete a slide; switch the theme. Merges with anyone editing.",
			Params: []apiParam{id}, Body: object(js{"ops": array(slideOp, "")}, "ops"), Result: okResult, H: s.handleEditSlides},
		{Method: "GET", Path: "/api/v1/documents/{id}/versions/{version}/content", ID: "read_version", Tag: "Documents", Summary: "Read a past version",
			Desc:   "A document's text (markdown), a spreadsheet's cells or a presentation's slides as they were.",
			Params: []apiParam{id, pathParam("version", "Version id."), query("sheet", str("For a spreadsheet: sheet name or index.")), query("range", str("For a spreadsheet: A1 range."))},
			Result: anyObject("As read_document, read_cells or read_slides."), H: s.handleReadVersion},
		{Method: "POST", Path: "/api/v1/documents/{id}/versions/{version}/restore", ID: "restore_version", Tag: "Documents", Summary: "Restore a past version", Write: true,
			Desc:   "Makes the document as it was. What was there first is saved as a version, so a restore can be undone by restoring that.",
			Params: []apiParam{id, pathParam("version", "Version id.")}, Result: okResult, H: s.handleRestore},
	}
}

func (s *Server) handleDocumentCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Kind, Title, Folder, Content, Format string
		Slides                               []json.RawMessage
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if !docKinds[in.Kind] {
		fail(w, 400, "kind is doc, sheet or slides.")
		return
	}
	var snap []byte
	var text, update string
	empty := engineState{Updates: []string{}}
	author := map[string]string{"id": u.ID, "name": u.Name}
	switch {
	case in.Kind == "doc" && in.Content != "":
		h, err := s.toHTML(r.Context(), in.Format, in.Content)
		if err != nil {
			fail(w, 422, err.Error())
			return
		}
		var res engineWrite
		if !s.content(w, r, u, "doc.write", map[string]any{"state": empty, "html": h, "mode": "replace", "author": author}, &res) {
			return
		}
		update, text = res.Update, res.Text
	case in.Kind == "sheet" && in.Content != "":
		var res struct{ Snapshot, Text string }
		if !s.content(w, r, u, "sheet.fromCsv", map[string]any{"csv": in.Content, "name": in.Title}, &res) {
			return
		}
		snap, _ = base64.StdEncoding.DecodeString(res.Snapshot)
		text = res.Text
	case in.Kind == "slides" && len(in.Slides) > 0:
		var res engineWrite
		if !s.content(w, r, u, "slides.write", map[string]any{"state": empty, "ops": in.Slides, "author": author}, &res) {
			return
		}
		update, text = res.Update, res.Text
	}
	d, code, msg := s.createDoc(u, "", in.Kind, in.Title, in.Folder, snap)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	if update != "" || text != "" {
		s.writeUpdate(u, d.ID, update, &text)
	}
	s.handleDocCreated(w, r, u, d.ID)
}

func (s *Server) handleDocCreated(w http.ResponseWriter, r *http.Request, u *User, id string) {
	if d := s.docFor(r, u, id); d != nil {
		ok(w, d)
		return
	}
	fail(w, 500, "storage error")
}

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request, u *User) {
	name := cleanName(r.URL.Query().Get("name"))
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	title := strings.TrimSuffix(name, filepath.Ext(name))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 40<<20))
	if err != nil {
		fail(w, 413, "That file is too large (40 MB limit).")
		return
	}
	if !s.lim.allow("convert:"+u.ID, 30, time.Minute) {
		fail(w, 429, "Too many conversions. Try again in a minute.")
		return
	}
	author := map[string]string{"id": u.ID, "name": u.Name}
	kind, text, update := "doc", "", ""
	var snap []byte
	switch ext {
	case "docx", "odt", "md", "markdown", "html", "htm", "txt":
		var h string
		switch ext {
		case "docx", "odt":
			out, err := s.pandoc(r.Context(), ext, "html", body)
			if err != nil {
				fail(w, 422, "That file couldn't be read: "+err.Error())
				return
			}
			h = string(out)
		case "md", "markdown":
			h, err = s.toHTML(r.Context(), "markdown", string(body))
		case "txt":
			h = textHTML(string(body))
		default:
			h = string(body)
		}
		if err != nil {
			fail(w, 422, err.Error())
			return
		}
		var res engineWrite
		if !s.content(w, r, u, "doc.write", map[string]any{"state": engineState{Updates: []string{}}, "html": h, "mode": "replace", "author": author}, &res) {
			return
		}
		update, text = res.Update, res.Text
	case "xlsx", "csv", "pptx":
		var res struct{ Snapshot, Text string }
		op, args := "sheet.fromXlsx", map[string]any{"xlsx": base64.StdEncoding.EncodeToString(body), "name": title}
		kind = "sheet"
		if ext == "csv" {
			op, args = "sheet.fromCsv", map[string]any{"csv": string(body), "name": title}
		} else if ext == "pptx" {
			op, args, kind = "slides.fromPptx", map[string]any{"pptx": base64.StdEncoding.EncodeToString(body)}, "slides"
		}
		if !s.content(w, r, u, op, args, &res) {
			return
		}
		snap, _ = base64.StdEncoding.DecodeString(res.Snapshot)
		text = res.Text
	default:
		fail(w, 415, "Import .docx, .odt, .md, .html, .txt, .xlsx, .csv or .pptx files.")
		return
	}
	d, code, msg := s.createDoc(u, "", kind, title, r.URL.Query().Get("folder"), snap)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	s.writeUpdate(u, d.ID, update, &text)
	s.handleDocCreated(w, r, u, d.ID)
}

// readText returns a text document in a format; inline puts pictures inside
// (for files that leave the suite).
func (s *Server) readText(w http.ResponseWriter, r *http.Request, u *User, st engineState, format string, inline bool) (string, bool) {
	var res struct{ HTML, Text string }
	if !s.content(w, r, u, "doc.read", map[string]any{"state": st}, &res) {
		return "", false
	}
	switch format {
	case "text":
		return res.Text, true
	case "html":
		return s.pictures(r, u, res.HTML, inline), true
	case "", "markdown":
		out, err := s.pandoc(r.Context(), "html", "md", []byte(s.pictures(r, u, res.HTML, false)))
		if err != nil {
			fail(w, 500, "That document couldn't be converted.")
			return "", false
		}
		return string(out), true
	}
	fail(w, 400, "format is markdown, html or text.")
	return "", false
}

func (s *Server) handleReadText(w http.ResponseWriter, r *http.Request, u *User) {
	if _, allowed := s.contentDoc(w, r, u, "doc", "read"); !allowed {
		return
	}
	st, found := s.stateOf(w, r.PathValue("id"))
	if !found {
		return
	}
	format := r.URL.Query().Get("format")
	if text, done := s.readText(w, r, u, st, format, false); done {
		if format == "" {
			format = "markdown"
		}
		ok(w, map[string]string{"format": format, "content": text})
	}
}

func (s *Server) handleWriteText(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Content, Format, Mode string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.Mode == "" {
		in.Mode = "replace"
	}
	if in.Mode != "replace" && in.Mode != "append" && in.Mode != "prepend" {
		fail(w, 400, "mode is replace, append or prepend.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "doc", "edit"); !allowed {
		return
	}
	h, err := s.toHTML(r.Context(), in.Format, in.Content)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	s.edit(w, r, u, "doc.write", map[string]any{"html": h, "mode": in.Mode})
}

// edit runs a change through the engine against the current state and
// stores the update it produces.
func (s *Server) edit(w http.ResponseWriter, r *http.Request, u *User, op string, args map[string]any) {
	id := r.PathValue("id")
	st, found := s.stateOf(w, id)
	if !found {
		return
	}
	args["state"] = st
	args["author"] = map[string]string{"id": u.ID, "name": u.Name}
	var res engineWrite
	if !s.content(w, r, u, op, args, &res) {
		return
	}
	s.writeUpdate(u, id, res.Update, &res.Text)
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleComments(w http.ResponseWriter, r *http.Request, u *User) {
	if _, allowed := s.contentDoc(w, r, u, "doc", "read"); !allowed {
		return
	}
	st, found := s.stateOf(w, r.PathValue("id"))
	if !found {
		return
	}
	var res struct {
		Threads []json.RawMessage `json:"threads"`
	}
	if s.content(w, r, u, "doc.comments", map[string]any{"state": st}, &res) {
		if res.Threads == nil {
			res.Threads = []json.RawMessage{}
		}
		ok(w, map[string]any{"items": res.Threads})
	}
}

func (s *Server) handleCommentAdd(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Quote, Text string
		Occurrence  int
	}
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Quote) == "" || strings.TrimSpace(in.Text) == "" {
		fail(w, 400, "Say which text the comment is about (quote) and what it says (text).")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "doc", "comment"); !allowed {
		return
	}
	id := r.PathValue("id")
	st, found := s.stateOf(w, id)
	if !found {
		return
	}
	var res struct {
		Update string          `json:"update"`
		Thread json.RawMessage `json:"thread"`
	}
	if !s.content(w, r, u, "doc.comment", map[string]any{"state": st, "quote": in.Quote, "occurrence": max(1, in.Occurrence), "text": in.Text,
		"author": map[string]string{"id": u.ID, "name": u.Name}}, &res) {
		return
	}
	s.writeUpdate(u, id, res.Update, nil)
	ok(w, res.Thread)
}

func (s *Server) handleCommentReply(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Text string }
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Text) == "" {
		fail(w, 400, "Write the reply in text.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "doc", "comment"); allowed {
		s.commentEdit(w, r, u, "doc.reply", map[string]any{"thread": r.PathValue("thread"), "text": in.Text})
	}
}

func (s *Server) handleCommentResolve(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Resolved *bool }
	if readJSON(r, &in) != nil || in.Resolved == nil {
		fail(w, 400, "Say resolved: true or false.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "doc", "comment"); allowed {
		s.commentEdit(w, r, u, "doc.resolve", map[string]any{"thread": r.PathValue("thread"), "resolved": *in.Resolved})
	}
}

// commentEdit is edit without touching the search index: comments live
// beside the text, not in it.
func (s *Server) commentEdit(w http.ResponseWriter, r *http.Request, u *User, op string, args map[string]any) {
	id := r.PathValue("id")
	st, found := s.stateOf(w, id)
	if !found {
		return
	}
	args["state"] = st
	args["author"] = map[string]string{"id": u.ID, "name": u.Name}
	var res engineWrite
	if !s.content(w, r, u, op, args, &res) {
		return
	}
	s.writeUpdate(u, id, res.Update, nil)
	ok(w, map[string]bool{"ok": true})
}

func cellsArgs(r *http.Request, st engineState) map[string]any {
	args := map[string]any{"state": st}
	q := r.URL.Query()
	if v := q.Get("sheet"); v != "" {
		args["sheet"] = sheetRef(v)
	}
	if v := q.Get("range"); v != "" {
		args["range"] = v
	}
	return args
}

// sheetRef passes a sheet given by number as a number.
func sheetRef(v string) any {
	if n, err := json.Number(v).Int64(); err == nil {
		return n
	}
	return v
}

func (s *Server) handleReadCells(w http.ResponseWriter, r *http.Request, u *User) {
	if _, allowed := s.contentDoc(w, r, u, "sheet", "read"); !allowed {
		return
	}
	st, found := s.stateOf(w, r.PathValue("id"))
	if !found {
		return
	}
	var res json.RawMessage
	if s.content(w, r, u, "sheet.read", cellsArgs(r, st), &res) {
		ok(w, res)
	}
}

func (s *Server) handleWriteCells(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Sheet             json.RawMessage
		Start, CSV, Clear string
		Values            [][]any
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if boolCount(in.Values != nil, in.CSV != "", in.Clear != "") != 1 {
		fail(w, 400, "Send exactly one of values, csv or clear.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "sheet", "edit"); !allowed {
		return
	}
	args := map[string]any{"start": in.Start}
	if in.Start == "" {
		args["start"] = "A1"
	}
	if len(in.Sheet) > 0 {
		args["sheet"] = in.Sheet
	}
	switch {
	case in.Values != nil:
		args["values"] = in.Values
	case in.CSV != "":
		args["csv"] = in.CSV
	default:
		args["clear"] = in.Clear
	}
	s.edit(w, r, u, "sheet.write", args)
}

func boolCount(bs ...bool) int {
	n := 0
	for _, b := range bs {
		if b {
			n++
		}
	}
	return n
}

func (s *Server) handleAddSheet(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Name string }
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
		fail(w, 400, "Give the sheet a name.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "sheet", "edit"); allowed {
		s.edit(w, r, u, "sheet.addSheet", map[string]any{"name": strings.TrimSpace(in.Name)})
	}
}

func (s *Server) handleReadSlides(w http.ResponseWriter, r *http.Request, u *User) {
	if _, allowed := s.contentDoc(w, r, u, "slides", "read"); !allowed {
		return
	}
	st, found := s.stateOf(w, r.PathValue("id"))
	if !found {
		return
	}
	var res json.RawMessage
	if s.content(w, r, u, "slides.read", map[string]any{"state": st}, &res) {
		ok(w, res)
	}
}

func (s *Server) handleEditSlides(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Ops []json.RawMessage }
	if readJSON(r, &in) != nil || len(in.Ops) == 0 {
		fail(w, 400, "Send the changes as ops.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, "slides", "edit"); allowed {
		s.edit(w, r, u, "slides.write", map[string]any{"ops": in.Ops})
	}
}

var exportTypes = map[string]string{
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"odt":  "application/vnd.oasis.opendocument.text",
	"md":   "text/markdown; charset=utf-8",
	"html": "text/html; charset=utf-8",
	"txt":  "text/plain; charset=utf-8",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"csv":  "text/csv; charset=utf-8",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

var exportKinds = map[string]string{"docx": "doc", "odt": "doc", "md": "doc", "html": "doc", "txt": "doc", "xlsx": "sheet", "csv": "sheet", "pptx": "slides"}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request, u *User) {
	format := r.URL.Query().Get("format")
	kind, known := exportKinds[format]
	if !known {
		fail(w, 400, "format is docx, odt, md, html or txt for documents, xlsx or csv for spreadsheets, pptx for presentations.")
		return
	}
	if _, allowed := s.contentDoc(w, r, u, kind, "read"); !allowed {
		return
	}
	id := r.PathValue("id")
	st, found := s.stateOf(w, id)
	if !found {
		return
	}
	var title string
	s.r.QueryRow(`SELECT title FROM docs WHERE id = ?`, id).Scan(&title)
	if title == "" {
		title = "Untitled"
	}
	var out []byte
	switch format {
	case "docx", "odt", "html":
		h, done := s.readText(w, r, u, st, "html", true)
		if !done {
			return
		}
		h = "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + html.EscapeString(title) + "</title></head><body>" + h + "</body></html>"
		if format == "html" {
			out = []byte(h)
			break
		}
		var err error
		if out, err = s.pandoc(r.Context(), "html", format, []byte(h)); err != nil {
			fail(w, 500, "That document couldn't be converted.")
			return
		}
	case "md", "txt":
		text, done := s.readText(w, r, u, st, map[string]string{"md": "markdown", "txt": "text"}[format], false)
		if !done {
			return
		}
		out = []byte(text)
	case "xlsx", "pptx":
		var res map[string]string
		op, args := "sheet.xlsx", map[string]any{"state": st}
		if format == "pptx" {
			op, args = "slides.pptx", map[string]any{"state": st, "title": title}
		}
		if !s.content(w, r, u, op, args, &res) {
			return
		}
		out, _ = base64.StdEncoding.DecodeString(res[format])
	case "csv":
		var res struct{ CSV string }
		if !s.content(w, r, u, "sheet.read", cellsArgs(r, st), &res) {
			return
		}
		out = []byte(res.CSV)
	}
	w.Header().Set("Content-Type", exportTypes[format])
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(cleanName(title)+"."+format))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}

func (s *Server) handleReadVersion(w http.ResponseWriter, r *http.Request, u *User) {
	id, kind, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	frames, found := s.versionState(id, r.PathValue("version"))
	if !found {
		fail(w, 404, "That version no longer exists.")
		return
	}
	st, valid := framesState(frames)
	if !valid {
		fail(w, 500, "This version is damaged.")
		return
	}
	var res json.RawMessage
	switch kind {
	case "doc":
		if text, done := s.readText(w, r, u, st, "markdown", false); done {
			ok(w, map[string]string{"format": "markdown", "content": text})
		}
		return
	case "sheet":
		if !s.content(w, r, u, "sheet.read", cellsArgs(r, st), &res) {
			return
		}
	default:
		if !s.content(w, r, u, "slides.read", map[string]any{"state": st}, &res) {
			return
		}
	}
	ok(w, res)
}

// handleRestore restores a version: spreadsheets the way the app does it, on
// the server (handleVersionRestore); text documents as an edit that makes the
// text what it was, like the app's restore, after filing the present as a
// version so the restore itself can be undone.
func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request, u *User) {
	id, kind, allowed := s.versionAccess(w, r, u)
	if !allowed {
		return
	}
	switch kind {
	case "sheet":
		s.handleVersionRestore(w, r, u)
		return
	case "slides":
		fail(w, 409, "Presentations have no version history yet.")
		return
	}
	frames, found := s.versionState(id, r.PathValue("version"))
	if !found {
		fail(w, 404, "That version no longer exists.")
		return
	}
	version, valid := framesState(frames)
	st, found := s.docState(id)
	if !valid || !found {
		fail(w, 500, "This version is damaged.")
		return
	}
	var res engineWrite
	if !s.content(w, r, u, "doc.restore", map[string]any{"state": st, "version": version, "author": map[string]string{"id": u.ID, "name": u.Name}}, &res) {
		return
	}
	rm := s.hub.room(id)
	rm.mu.Lock()
	if rm.seq > rm.verSeq {
		s.takeVersion(rm, "", true)
	}
	rm.mu.Unlock()
	s.hub.release(rm)
	s.writeUpdate(u, id, res.Update, &res.Text)
	ok(w, map[string]bool{"ok": true})
}
