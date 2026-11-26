package main

// The MCP server at /mcp: everything the public API can do, as tools an AI
// assistant can call, over the Streamable HTTP transport. Each tool is one
// operation of the API (api.go) and runs through the same permission checks
// and the same handler as the HTTP call would, so the two cannot differ.
//
// It speaks the current protocol (2026-07-28: stateless, every request
// carries its version) and, for clients that still open with an initialize
// handshake, the three revisions before it. Nothing here keeps state between
// requests: there are no sessions, and no messages are pushed to clients.
// Credentials are Bearer tokens only: an API token, or one obtained through
// OAuth (oauth.go), which is how assistants connect by URL alone.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

const mcpModern = "2026-07-28"

var mcpLegacy = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

const mcpInstructions = `Open Suite is an office suite: mail, calendar, contacts, chat, video meetings, files, documents, spreadsheets and presentations. ` +
	`These tools act as the signed-in member, with exactly their permissions. Start with get_me to learn who that is. ` +
	`Use search to find things across the suite. Text documents are read and written as Markdown (read_document, write_document); ` +
	`spreadsheets as cells (read_cells, write_cells); presentations as slides (read_slides, edit_slides). ` +
	`Changes merge with people editing at the same time. Ask before sending mail or invitations on someone's behalf.`

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func rpcReply(w http.ResponseWriter, status int, id json.RawMessage, result any, e *rpcError) {
	msg := map[string]any{"jsonrpc": "2.0"}
	if len(id) > 0 {
		msg["id"] = id
	}
	if e != nil {
		msg["error"] = e
	} else {
		msg["result"] = result
	}
	allowCORS(w)
	writeJSON(w, status, msg)
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "OPTIONS":
		preflight(w, r)
		return
	case "POST":
	default:
		allowCORS(w)
		w.Header().Set("Allow", "POST")
		fail(w, 405, "The MCP endpoint takes POST requests (Streamable HTTP).")
		return
	}
	u, g := s.bearerUser(r)
	if u == nil {
		allowCORS(w)
		s.unauthorized(w, r, "/mcp")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		rpcReply(w, 400, nil, nil, &rpcError{-32700, "Parse error", nil})
		return
	}
	var req rpcRequest
	if json.Unmarshal(body, &req) != nil || req.JSONRPC != "2.0" || req.Method == "" {
		rpcReply(w, 400, nil, nil, &rpcError{-32600, "Invalid request: one JSON-RPC request or notification per POST.", nil})
		return
	}
	var params struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	json.Unmarshal(req.Params, &params)
	var version string
	json.Unmarshal(params.Meta["io.modelcontextprotocol/protocolVersion"], &version)
	modern := version != ""
	if len(req.ID) == 0 {
		// Notifications (initialized, cancelled) need no answer.
		allowCORS(w)
		w.WriteHeader(202)
		return
	}
	if modern {
		if version != mcpModern {
			rpcReply(w, 400, req.ID, nil, &rpcError{-32022, "Unsupported protocol version",
				map[string]any{"supported": append([]string{mcpModern}, mcpLegacy...), "requested": version}})
			return
		}
		if msg := mcpHeaders(r, req); msg != "" {
			rpcReply(w, 400, req.ID, nil, &rpcError{-32020, msg, nil})
			return
		}
	}
	result, e := s.mcpCall(r, u, g, req, modern)
	status := 200
	if e != nil && e.Code == -32601 && modern {
		status = 404
	}
	if e == nil && modern {
		result["resultType"] = "complete"
		meta, _ := result["_meta"].(map[string]any)
		if meta == nil {
			meta = map[string]any{}
		}
		meta["io.modelcontextprotocol/serverInfo"] = serverInfo
		result["_meta"] = meta
	}
	rpcReply(w, status, req.ID, result, e)
}

var serverInfo = map[string]string{"name": "Open Suite", "version": "1.0.0"}

// mcpHeaders checks that the headers mirroring the request (for proxies to
// route on) say the same as its body.
func mcpHeaders(r *http.Request, req rpcRequest) string {
	if r.Header.Get("MCP-Protocol-Version") != mcpModern {
		return "Header mismatch: MCP-Protocol-Version must be " + mcpModern + ", as in the request's _meta."
	}
	if m := r.Header.Get("Mcp-Method"); m != req.Method {
		return "Header mismatch: Mcp-Method header value '" + m + "' does not match body value '" + req.Method + "'"
	}
	var p struct{ Name, URI string }
	json.Unmarshal(req.Params, &p)
	want := p.Name
	if req.Method == "resources/read" {
		want = p.URI
	}
	if req.Method == "tools/call" || req.Method == "resources/read" || req.Method == "prompts/get" {
		got := r.Header.Get("Mcp-Name")
		if enc, found := strings.CutPrefix(got, "=?base64?"); found && strings.HasSuffix(enc, "?=") {
			b, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(enc, "?="))
			if err != nil {
				return "Header mismatch: Mcp-Name is not valid Base64."
			}
			got = string(b)
		}
		if got != want {
			return "Header mismatch: Mcp-Name header value '" + got + "' does not match body value '" + want + "'"
		}
	}
	return ""
}

func capabilities() map[string]any {
	return map[string]any{"tools": map[string]any{}, "resources": map[string]any{}}
}

func (s *Server) mcpCall(r *http.Request, u *User, g *Grant, req rpcRequest, modern bool) (map[string]any, *rpcError) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		version := mcpLegacy[0]
		if slices.Contains(mcpLegacy, p.ProtocolVersion) {
			version = p.ProtocolVersion
		}
		return map[string]any{"protocolVersion": version, "capabilities": capabilities(), "serverInfo": serverInfo, "instructions": mcpInstructions}, nil
	case "server/discover":
		return map[string]any{"supportedVersions": append([]string{mcpModern}, mcpLegacy...), "capabilities": capabilities(),
			"instructions": mcpInstructions, "ttlMs": 3600000, "cacheScope": "public"}, nil
	case "ping":
		if !modern {
			return map[string]any{}, nil
		}
	case "tools/list":
		out := map[string]any{"tools": s.mcpTools(u, g)}
		if modern {
			out["ttlMs"], out["cacheScope"] = 3600000, "private"
		}
		return out, nil
	case "tools/call":
		return s.mcpToolCall(r, u, g, req.Params)
	case "resources/list":
		out := s.mcpResources(r, u)
		if modern {
			out["ttlMs"], out["cacheScope"] = 60000, "private"
		}
		return out, nil
	case "resources/templates/list":
		out := map[string]any{"resourceTemplates": resourceTemplates}
		if modern {
			out["ttlMs"], out["cacheScope"] = 3600000, "public"
		}
		return out, nil
	case "resources/read":
		out, e := s.mcpRead(r, u, g, req.Params)
		if e == nil && modern {
			out["ttlMs"], out["cacheScope"] = 0, "private"
		}
		return out, e
	}
	return nil, &rpcError{-32601, "Method not found: " + req.Method, nil}
}

// --- tools ---------------------------------------------------------------------

// rawInput is how a tool takes what the HTTP operation takes as a raw body.
var rawInput = js{
	"text":          str("The content as text (for text files)."),
	"contentBase64": str("Or the content Base64-encoded (for anything else)."),
	"contentType":   str("Its content type, like application/pdf. Default from the file name."),
}

func toolSchema(op *apiOp) js {
	props := js{}
	var required []string
	for _, p := range op.Params {
		schema := js{}
		for k, v := range p.Schema {
			schema[k] = v
		}
		schema["description"] = p.Desc
		props[p.Name] = schema
		if p.Required {
			required = append(required, p.Name)
		}
	}
	if op.Body != nil {
		body := resolveRefs(op.Body).(js)
		for k, v := range body["properties"].(js) {
			props[k] = v
		}
		if req, has := body["required"].([]string); has {
			required = append(required, req...)
		}
	}
	if op.Raw != "" {
		for k, v := range rawInput {
			props[k] = v
		}
		if op.ID == "send_chat_file" {
			props["fileId"] = str("Or share a file from Files by its id.")
		}
	}
	schema := js{"type": "object", "properties": props}
	if len(required) > 0 {
		slices.Sort(required)
		schema["required"] = required
	}
	return schema
}

var openWorld = map[string]bool{"send_mail": true, "reply_to_message": true, "forward_message": true, "send_draft": true,
	"create_event": true, "update_event": true, "delete_event": true, "answer_invitation": true}

// mcpTools lists what the caller can use: a read-only token sees only the
// tools that read, and only administrators see the administration tools.
func (s *Server) mcpTools(u *User, g *Grant) []map[string]any {
	tools := []map[string]any{}
	for _, op := range s.ops {
		if (op.Write && g.ReadOnly) || (op.Admin && !u.isAdmin()) {
			continue
		}
		desc := op.Summary + "."
		if op.Desc != "" {
			desc += " " + op.Desc
		}
		tools = append(tools, map[string]any{
			"name":        op.ID,
			"title":       op.Summary,
			"description": desc,
			"inputSchema": toolSchema(op),
			"annotations": map[string]any{
				"title":           op.Summary,
				"readOnlyHint":    !op.Write,
				"destructiveHint": op.Method == "DELETE" || op.ID == "write_document" || op.ID == "restore_version",
				"idempotentHint":  op.Method == "GET" || op.Method == "PUT" || op.Method == "DELETE",
				"openWorldHint":   openWorld[op.ID],
			},
		})
	}
	return tools
}

func (s *Server) opByID(id string) *apiOp {
	for _, op := range s.ops {
		if op.ID == id {
			return op
		}
	}
	return nil
}

func argString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// runOp performs one API operation in-process, for the caller, exactly as an
// HTTP request to it would.
func (s *Server) runOp(r *http.Request, u *User, g *Grant, op *apiOp, args map[string]any) (*recorder, string) {
	path := op.Path
	q := url.Values{}
	used := map[string]bool{}
	for _, p := range op.Params {
		v, given := args[p.Name]
		used[p.Name] = true
		if !given || v == nil {
			if p.Required {
				return nil, "Missing " + p.Name + "."
			}
			continue
		}
		if p.In == "path" {
			path = strings.Replace(path, "{"+p.Name+"}", url.PathEscape(argString(v)), 1)
		} else {
			q.Set(p.Name, argString(v))
		}
	}
	var body io.Reader
	ctype := ""
	switch {
	case op.Body != nil:
		fields := map[string]any{}
		for k, v := range args {
			if !used[k] {
				fields[k] = v
			}
		}
		b, _ := json.Marshal(fields)
		body, ctype = bytes.NewReader(b), "application/json"
	case op.Raw != "":
		text, isText := args["text"].(string)
		enc, isB64 := args["contentBase64"].(string)
		fileID, isFile := args["fileId"].(string)
		switch {
		case isFile && op.ID == "send_chat_file":
			b, _ := json.Marshal(map[string]string{"fileId": fileID})
			body, ctype = bytes.NewReader(b), "application/json"
		case isB64:
			data, err := base64.StdEncoding.DecodeString(enc)
			if err != nil {
				return nil, "contentBase64 is not valid Base64."
			}
			body = bytes.NewReader(data)
		case isText:
			body = strings.NewReader(text)
		default:
			return nil, "Give the content as text or contentBase64."
		}
		ctype, _ = args["contentType"].(string)
		if ctype == "" && isFile {
			ctype = "application/json"
		}
	}
	target := path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(r.Context(), op.Method, target, body)
	if err != nil {
		return nil, "That request is not valid."
	}
	req.Host = r.Host
	req.RemoteAddr = r.RemoteAddr
	for _, h := range []string{"X-Forwarded-Proto", "X-Real-IP", "Authorization"} {
		req.Header.Set(h, r.Header.Get(h))
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if lr, has := body.(interface{ Len() int }); has {
		req.ContentLength = int64(lr.Len())
	}
	for _, p := range op.Params {
		if p.In == "path" {
			if v, given := args[p.Name]; given {
				req.SetPathValue(p.Name, argString(v))
			}
		}
	}
	rec := &recorder{header: http.Header{}}
	if s.permit(rec, op, u, g) {
		op.H(rec, req, u)
	}
	if rec.code == 0 {
		rec.code = 200
	}
	return rec, ""
}

const mcpInlineLimit = 8 << 20

func (s *Server) mcpToolCall(r *http.Request, u *User, g *Grant, raw json.RawMessage) (map[string]any, *rpcError) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return nil, &rpcError{-32602, "Invalid params", nil}
	}
	op := s.opByID(p.Name)
	if op == nil {
		return nil, &rpcError{-32602, "Unknown tool: " + p.Name, nil}
	}
	if p.Arguments == nil {
		p.Arguments = map[string]any{}
	}
	rec, msg := s.runOp(r, u, g, op, p.Arguments)
	if msg != "" {
		return toolError(msg), nil
	}
	if rec.code >= 300 {
		var e struct{ Error string }
		json.Unmarshal(rec.body, &e)
		if e.Error == "" {
			e.Error = http.StatusText(rec.code)
		}
		return toolError(e.Error), nil
	}
	if op.File {
		return fileResult(rec, "opensuite://"+strings.TrimPrefix(op.Path, "/api/v1/")), nil
	}
	out := map[string]any{"content": []map[string]any{{"type": "text", "text": string(bytes.TrimSpace(rec.body))}}, "isError": false}
	var structured any
	if json.Unmarshal(rec.body, &structured) == nil {
		if obj, isObj := structured.(map[string]any); isObj {
			out["structuredContent"] = obj
		}
	}
	return out, nil
}

func toolError(msg string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": msg}}, "isError": true}
}

func isTextType(ctype string) bool {
	return strings.HasPrefix(ctype, "text/") || strings.Contains(ctype, "json") || strings.Contains(ctype, "xml") || strings.Contains(ctype, "markdown")
}

// fileResult hands a download back to the model: text as text, anything else
// as an embedded resource, within a size a conversation can carry.
func fileResult(rec *recorder, uri string) map[string]any {
	ctype := rec.header.Get("Content-Type")
	name := ""
	if cd := rec.header.Get("Content-Disposition"); strings.Contains(cd, "UTF-8''") {
		name, _ = url.PathUnescape(cd[strings.Index(cd, "UTF-8''")+7:])
	}
	if len(rec.body) > mcpInlineLimit {
		return toolError("That file is larger than 8 MB, too large to pass through here. Download it with the API instead.")
	}
	if (isTextType(ctype) || ctype == "application/octet-stream") && utf8.Valid(rec.body) && !bytes.ContainsRune(rec.body, 0) {
		return map[string]any{"content": []map[string]any{{"type": "text", "text": string(rec.body)}}, "isError": false}
	}
	res := map[string]any{"uri": uri, "mimeType": ctype, "blob": base64.StdEncoding.EncodeToString(rec.body)}
	if name != "" {
		res["name"] = name
	}
	return map[string]any{"content": []map[string]any{{"type": "resource", "resource": res}}, "isError": false}
}

// --- resources -----------------------------------------------------------------

var resourceTemplates = []map[string]any{
	{"uriTemplate": "opensuite://documents/{id}", "name": "Document", "description": "A text document as Markdown, a spreadsheet's first sheet as CSV, or a presentation as JSON."},
	{"uriTemplate": "opensuite://files/{id}", "name": "File", "description": "A file from Files."},
	{"uriTemplate": "opensuite://mail/{id}", "name": "Mail message", "description": "A mail message as JSON."},
}

var docMime = map[string]string{"doc": "text/markdown", "sheet": "text/csv", "slides": "application/json"}

// mcpResources lists the caller's most recent documents, the things an
// assistant is most often asked about.
func (s *Server) mcpResources(r *http.Request, u *User) map[string]any {
	out := []map[string]any{}
	for _, d := range s.docList(u) {
		if d.Trashed > 0 {
			continue
		}
		title := d.Title
		if title == "" {
			title = "Untitled"
		}
		out = append(out, map[string]any{"uri": "opensuite://documents/" + d.ID, "name": title, "title": title, "mimeType": docMime[d.Kind],
			"description": kindNames[d.Kind] + ", changed " + strconv.FormatInt(d.Updated, 10)})
		if len(out) == 100 {
			break
		}
	}
	return map[string]any{"resources": out}
}

func (s *Server) mcpRead(r *http.Request, u *User, g *Grant, raw json.RawMessage) (map[string]any, *rpcError) {
	var p struct {
		URI string `json:"uri"`
	}
	json.Unmarshal(raw, &p)
	kind, id, found := strings.Cut(strings.TrimPrefix(p.URI, "opensuite://"), "/")
	if !strings.HasPrefix(p.URI, "opensuite://") || !found || id == "" {
		return nil, &rpcError{-32602, "Resource not found", map[string]string{"uri": p.URI}}
	}
	var opID string
	args := map[string]any{"id": id}
	switch kind {
	case "documents":
		k := ""
		s.r.QueryRow(`SELECT kind FROM docs WHERE id = ? AND org_id = ?`, id, u.OrgID).Scan(&k)
		opID = map[string]string{"doc": "read_document", "sheet": "export_document", "slides": "read_slides"}[k]
		if k == "sheet" {
			args["format"] = "csv"
		}
	case "files":
		opID = "download_file"
	case "mail":
		opID = "get_message"
	}
	op := s.opByID(opID)
	if op == nil {
		return nil, &rpcError{-32602, "Resource not found", map[string]string{"uri": p.URI}}
	}
	rec, msg := s.runOp(r, u, g, op, args)
	if msg != "" || rec.code >= 300 {
		return nil, &rpcError{-32602, "Resource not found", map[string]string{"uri": p.URI}}
	}
	ctype := rec.header.Get("Content-Type")
	content := map[string]any{"uri": p.URI, "mimeType": ctype}
	switch {
	case opID == "read_document":
		var t struct{ Content string }
		json.Unmarshal(rec.body, &t)
		content["mimeType"], content["text"] = "text/markdown", t.Content
	case !op.File:
		content["mimeType"], content["text"] = "application/json", string(rec.body)
	case len(rec.body) > mcpInlineLimit:
		return nil, &rpcError{-32603, "That file is larger than 8 MB; download it with the API.", nil}
	case isTextType(ctype) && utf8.Valid(rec.body):
		content["text"] = string(rec.body)
	default:
		content["blob"] = base64.StdEncoding.EncodeToString(rec.body)
	}
	return map[string]any{"contents": []map[string]any{content}}, nil
}
