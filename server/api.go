package main

// The public API, /api/v1. Every operation is one entry in a table: method,
// path, what it accepts and returns, whether it changes anything, and the
// handler. The same table routes requests, writes the OpenAPI document and
// the reference page (openapi.go), and becomes the MCP server's tools
// (mcp.go), so a program, an AI agent and the description of both always see
// the same thing. Handlers are the app's own wherever the app already does
// the job; the rest are written once, here or beside the area they serve.
//
// A caller is a member, identified by a Bearer token (tokens.go, oauth.go) or
// by the app's session cookie, and can do exactly what that member can do in
// the app: their own data, their organisation's shared data, and the admin
// operations if they are an administrator.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type apiParam struct {
	Name, In, Desc string // In is "path" or "query"
	Schema         js
	Required       bool
}

type apiOp struct {
	Method, Path string
	ID           string // operationId, and the MCP tool's name
	Tag          string
	Summary      string
	Desc         string
	Write        bool // changes something: refused to read-only tokens
	Admin        bool // administrators only
	Params       []apiParam
	Body         js     // a JSON request body (an object), or nil
	Raw          string // instead of Body: the request body is raw bytes, described here
	Result       js     // the JSON response; nil when File is set
	File         bool   // the response is a file's bytes
	H            authed
}

func pathParam(name, desc string) apiParam {
	return apiParam{Name: name, In: "path", Desc: desc, Schema: js{"type": "string"}, Required: true}
}

func query(name string, schema js) apiParam {
	return apiParam{Name: name, In: "query", Desc: schema["description"].(string), Schema: schema}
}

var pageParams = []apiParam{
	query("limit", integer("Items per page, 1 to 200 (default 50).")),
	query("cursor", str("The `next` value of the previous page.")),
}

func (s *Server) apiOps() []*apiOp {
	var all []*apiOp
	for _, group := range [][]*apiOp{s.accountOps(), s.groupOps(), s.adminOps(), s.mailOps(), s.calendarOps(), s.contactOps(), s.chatOps(), s.meetOps(), s.fileOps(), s.docOps(), s.contentOps(), s.searchOps()} {
		all = append(all, group...)
	}
	return all
}

func (s *Server) routesAPI(m *http.ServeMux) {
	s.ops = s.apiOps()
	for _, op := range s.ops {
		m.HandleFunc(op.Method+" "+op.Path, s.v1(op))
	}
	m.HandleFunc("OPTIONS /api/v1/", preflight)
	m.HandleFunc("GET /api/v1/openapi.json", s.handleOpenAPI)
	m.HandleFunc("GET /api/v1/reference", s.handleReference)
	m.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		allowCORS(w)
		fail(w, 404, "No such operation. The reference is at /api/v1/reference.")
	})
}

// allowCORS lets pages on other sites call the API with a token. Cookies are
// never honoured across sites: the browser does not send them to a wildcard
// origin, and guard refuses cross-site writes that carry one.
func allowCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Expose-Headers", "WWW-Authenticate, Retry-After, Content-Disposition")
}

func preflight(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	h := w.Header()
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID")
	h.Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(204)
}

// apiCaller identifies who is calling: a Bearer token when one is sent (and
// then only the token counts), otherwise the session cookie.
func (s *Server) apiCaller(r *http.Request) (*User, *Grant) {
	if r.Header.Get("Authorization") != "" {
		return s.bearerUser(r)
	}
	return s.sessionUser(r), nil
}

// unauthorized answers a request without valid credentials, pointing OAuth
// clients at the metadata that explains how to get some (RFC 9728).
func (s *Server) unauthorized(w http.ResponseWriter, r *http.Request, resourcePath string) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="Open Suite", resource_metadata="`+baseURL(r)+"/.well-known/oauth-protected-resource"+resourcePath+`"`)
	fail(w, 401, "Sign in, or send an API token as \"Authorization: Bearer <token>\".")
}

// permit applies the rules every operation shares, whether it arrives over
// HTTP or as an MCP tool call.
func (s *Server) permit(w http.ResponseWriter, op *apiOp, u *User, g *Grant) bool {
	key := "u:" + u.ID
	if g != nil {
		key = "t:" + g.ID
	}
	if !s.apiAllowed(w, key) {
		return false
	}
	if op.Write && g != nil && g.ReadOnly {
		fail(w, 403, "This token can only read. Create one with full access to make changes.")
		return false
	}
	if op.Admin && !u.isAdmin() {
		fail(w, 403, "administrators only")
		return false
	}
	return true
}

func (s *Server) v1(op *apiOp) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		allowCORS(w)
		u, g := s.apiCaller(r)
		if u == nil {
			s.unauthorized(w, r, "")
			return
		}
		if s.permit(w, op, u, g) {
			op.H(w, r, u)
		}
	}
}

// baseURL is the address the caller used to reach us. Behind nginx the
// scheme is always https; a development server is reached over plain http.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// page cuts one page out of a list. The cursor is the position of the next
// item; callers treat it as opaque.
func page[T any](r *http.Request, items []T) map[string]any {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	from, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	from = max(0, min(from, len(items)))
	to := min(from+limit, len(items))
	out := map[string]any{"items": items[from:to]}
	if to < len(items) {
		out["next"] = strconv.Itoa(to)
	}
	return out
}

func matches(q string, fields ...string) bool {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return true
	}
	for _, f := range fields {
		if strings.Contains(strings.ToLower(f), q) {
			return true
		}
	}
	return false
}

// --- account and directory --------------------------------------------------

func (s *Server) accountOps() []*apiOp {
	me := object(js{
		"user":     object(js{"id": str(""), "name": str(""), "email": str(""), "role": str(""), "agent": boolean("")}),
		"org":      object(js{"id": str(""), "name": str(""), "plan": str(""), "limits": anyObject("The plan's limits.")}),
		"readOnly": boolean("True when the caller's token can only read."),
	})
	tokenBody := object(js{
		"name":          str("What the token is for, e.g. \"Invoice agent\"."),
		"readOnly":      boolean("Allow reading only. Default false."),
		"expiresInDays": integer("Days until it stops working; 0 or absent for never."),
	}, "name")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/me", ID: "get_me", Tag: "Account", Summary: "Who am I",
			Desc: "The member the credentials act as, their organisation and its plan. A good first call.", Result: me, H: s.handleMe},
		{Method: "GET", Path: "/api/v1/tokens", ID: "list_tokens", Tag: "Account", Summary: "List my API tokens",
			Desc: "Your tokens and connected apps. Secrets are never shown again after creation.", Result: list(ref("Token")), H: s.handleTokenList},
		{Method: "POST", Path: "/api/v1/tokens", ID: "create_token", Tag: "Account", Summary: "Create an API token", Write: true,
			Desc: "A token acts as you, with your permissions. The secret is in this response only.", Body: tokenBody, Result: ref("Token"), H: s.handleTokenCreate},
		{Method: "DELETE", Path: "/api/v1/tokens/{id}", ID: "revoke_token", Tag: "Account", Summary: "Revoke an API token or connected app", Write: true,
			Params: []apiParam{pathParam("id", "Token id.")}, Result: okResult, H: s.handleTokenRevoke},
		{Method: "GET", Path: "/api/v1/people", ID: "list_people", Tag: "People", Summary: "List the organisation's people",
			Desc:   "Everyone in your organisation, agents included, sorted by name.",
			Params: append([]apiParam{query("q", str("Only people whose name or address contains this."))}, pageParams...), Result: list(ref("Person")), H: s.handlePeople},
		{Method: "GET", Path: "/api/v1/people/{id}", ID: "get_person", Tag: "People", Summary: "Get a person",
			Params: []apiParam{pathParam("id", "Member id, or their mail address.")}, Result: ref("Person"), H: s.handlePerson},
	}
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, u *User) {
	var orgName, plan string
	s.r.QueryRow(`SELECT name, plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&orgName, &plan)
	_, g := s.apiCaller(r)
	ok(w, map[string]any{
		"user":     map[string]any{"id": u.ID, "name": u.Name, "email": u.Email, "role": u.Role, "agent": u.isAgent()},
		"org":      map[string]any{"id": u.OrgID, "name": orgName, "plan": plan, "limits": planFor(plan)},
		"readOnly": g != nil && g.ReadOnly,
	})
}

func (s *Server) handlePeople(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query().Get("q")
	out := []Person{}
	for _, p := range s.people(u.OrgID) {
		if matches(q, p.Name, p.Email) {
			out = append(out, p)
		}
	}
	ok(w, page(r, out))
}

// personIn finds a member of the organisation by id or address.
func (s *Server) personIn(orgID, key string) *Person {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, p := range s.people(orgID) {
		if p.ID == key || strings.ToLower(p.Email) == key {
			return &p
		}
	}
	return nil
}

func (s *Server) handlePerson(w http.ResponseWriter, r *http.Request, u *User) {
	if p := s.personIn(u.OrgID, r.PathValue("id")); p != nil {
		ok(w, p)
		return
	}
	fail(w, 404, "No such person.")
}

// --- administration ---------------------------------------------------------

func (s *Server) adminOps() []*apiOp {
	id := pathParam("id", "Member id.")
	tokenBody := object(js{
		"name":          str("What the token is for."),
		"readOnly":      boolean("Allow reading only."),
		"expiresInDays": integer("Days until it stops working; 0 for never."),
	}, "name")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/admin/overview", ID: "admin_overview", Tag: "Administration", Summary: "Organisation overview", Admin: true,
			Desc:   "People, custom domains, storage used and the plan's limits.",
			Result: object(js{"people": array(ref("Person"), ""), "domains": array(ref("Domain"), ""), "usage": anyObject("Bytes used."), "limits": anyObject("The plan's limits."), "plan": str("")}),
			H:      s.handleAdminOverview},
		{Method: "POST", Path: "/api/v1/admin/people", ID: "admin_add_person", Tag: "Administration", Summary: "Add a person or an agent", Admin: true, Write: true,
			Desc: "Adds a person (who gets a temporary password to change at first sign-in) or, with `agent`, an agent: a member without a password that acts only through API tokens. " +
				"Both get a mailbox, calendar, files and chat, and both count towards the plan's people limit.",
			Body: object(js{
				"name":     str("Display name."),
				"username": str("The part of the address before @: 3 to 32 lowercase letters, digits, dots or dashes."),
				"domain":   str("A mail domain of the organisation; default is the installation's."),
				"role":     enum("Default member.", "member", "admin"),
				"agent":    boolean("Add an agent instead of a person."),
			}, "name", "username"),
			Result: object(js{"id": str(""), "email": str(""), "password": str("A person's temporary password."), "agent": boolean("")}),
			H:      s.handleUserCreate},
		{Method: "PATCH", Path: "/api/v1/admin/people/{id}", ID: "admin_update_person", Tag: "Administration", Summary: "Change a person's name, role or status, or reset their password", Admin: true, Write: true,
			Desc:   "Suspending signs a person out everywhere and stops their tokens working until they are reactivated. Only an owner can appoint or change an owner; agents cannot be owners and have no password to reset.",
			Params: []apiParam{id},
			Body: object(js{
				"name":          str(""),
				"role":          enum("", "owner", "admin", "member"),
				"status":        enum("", "active", "suspended"),
				"resetPassword": boolean("Give a person a new temporary password (returned)."),
			}),
			Result: object(js{"ok": boolean(""), "password": str("The new temporary password, after a reset.")}),
			H:      s.handleUserUpdate},
		{Method: "DELETE", Path: "/api/v1/admin/people/{id}", ID: "admin_remove_person", Tag: "Administration", Summary: "Remove a person or agent", Admin: true, Write: true,
			Desc:   "Their documents and meeting rooms pass to you; their mailbox and chat account are closed.",
			Params: []apiParam{id}, Result: okResult, H: s.handleUserDelete},
		{Method: "GET", Path: "/api/v1/admin/people/{id}/tokens", ID: "admin_list_agent_tokens", Tag: "Administration", Summary: "List an agent's tokens", Admin: true,
			Params: []apiParam{id}, Result: list(ref("Token")), H: s.handleAgentTokenList},
		{Method: "POST", Path: "/api/v1/admin/people/{id}/tokens", ID: "admin_create_agent_token", Tag: "Administration", Summary: "Create a token for an agent", Admin: true, Write: true,
			Desc:   "Agents have no password; this is how they get credentials. The secret is in this response only.",
			Params: []apiParam{id}, Body: tokenBody, Result: ref("Token"), H: s.handleAgentTokenCreate},
		{Method: "DELETE", Path: "/api/v1/admin/people/{id}/tokens/{token}", ID: "admin_revoke_agent_token", Tag: "Administration", Summary: "Revoke an agent's token", Admin: true, Write: true,
			Params: []apiParam{id, pathParam("token", "Token id.")}, Result: okResult, H: s.handleAgentTokenRevoke},
		{Method: "PATCH", Path: "/api/v1/admin/org", ID: "admin_rename_org", Tag: "Administration", Summary: "Rename the organisation", Admin: true, Write: true,
			Body: object(js{"name": str("")}, "name"), Result: okResult, H: s.handleOrgUpdate},
		{Method: "POST", Path: "/api/v1/admin/domains", ID: "admin_add_domain", Tag: "Administration", Summary: "Connect a custom domain", Admin: true, Write: true,
			Desc: "Returns the DNS records to publish. Then call admin_verify_domain.",
			Body: object(js{"domain": str("e.g. example.com")}, "domain"), Result: object(js{"domains": array(ref("Domain"), "")}), H: s.handleDomainAdd},
		{Method: "POST", Path: "/api/v1/admin/domains/{domain}/verify", ID: "admin_verify_domain", Tag: "Administration", Summary: "Check a domain's DNS and switch on what is ready", Admin: true, Write: true,
			Params: []apiParam{pathParam("domain", "")}, Result: object(js{"domains": array(ref("Domain"), ""), "checks": array(object(js{"ok": boolean(""), "text": str("")}), "")}), H: s.handleDomainVerify},
		{Method: "DELETE", Path: "/api/v1/admin/domains/{domain}", ID: "admin_remove_domain", Tag: "Administration", Summary: "Disconnect a custom domain", Admin: true, Write: true,
			Params: []apiParam{pathParam("domain", "")}, Result: object(js{"domains": array(ref("Domain"), "")}), H: s.handleDomainDelete},
	}
}

// --- meetings ---------------------------------------------------------------

func (s *Server) meetOps() []*apiOp {
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/meetings", ID: "list_meetings", Tag: "Meetings", Summary: "List my meeting rooms",
			Desc: "Permanent video rooms you own, most recently used first.", Params: pageParams, Result: list(ref("Meeting")), H: s.handleMeetingsV1},
		{Method: "POST", Path: "/api/v1/meetings", ID: "create_meeting", Tag: "Meetings", Summary: "Create a meeting room", Write: true,
			Desc: "Returns a permanent link. Members join as themselves; anyone else with the link joins as a named guest.",
			Body: object(js{"title": str("Optional title.")}), Result: ref("Meeting"), H: s.handleMeetingCreateV1},
		{Method: "DELETE", Path: "/api/v1/meetings/{code}", ID: "delete_meeting", Tag: "Meetings", Summary: "Delete a meeting room", Write: true,
			Params: []apiParam{pathParam("code", "Room code.")}, Result: okResult, H: s.handleMeetDelete},
	}
}

func (s *Server) handleMeetingsV1(w http.ResponseWriter, r *http.Request, u *User) {
	list := s.meetList(u)
	for i := range list {
		list[i].URL = baseURL(r) + "/meet/" + list[i].Code
	}
	ok(w, page(r, list))
}

func (s *Server) handleMeetingCreateV1(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Title string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	m, code, msg := s.createMeeting(u, "", in.Title)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	m.URL = baseURL(r) + "/meet/" + m.Code
	ok(w, m)
}

// --- files ------------------------------------------------------------------

func (s *Server) fileOps() []*apiOp {
	id := pathParam("id", "File or folder id.")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/files", ID: "list_files", Tag: "Files", Summary: "List files and folders",
			Desc: "The contents of one folder (folders first, then by name), your top level, the trash, or a search by name. " +
				"Documents, spreadsheets and presentations are listed by list_documents with the same `folder`.",
			Params: append([]apiParam{
				query("folder", str("Folder id; absent for the top level (your own items and what is shared with you).")),
				query("trashed", boolean("List what you put in the trash instead.")),
				query("q", str("Find files and folders anywhere whose name contains this.")),
			}, pageParams...),
			Result: list(ref("Node")), H: s.handleFilesV1},
		{Method: "GET", Path: "/api/v1/files/{id}", ID: "get_file", Tag: "Files", Summary: "Get a file's or folder's details",
			Params: []apiParam{id}, Result: with(ref("Node"), js{"publicUrl": str("The public link, if switched on (owner only).")}), H: s.handleFileGetV1},
		{Method: "GET", Path: "/api/v1/files/{id}/content", ID: "download_file", Tag: "Files", Summary: "Download a file",
			Params: []apiParam{id}, File: true, H: s.handleFileContent},
		{Method: "POST", Path: "/api/v1/files", ID: "upload_file", Tag: "Files", Summary: "Upload a file", Write: true,
			Desc: "The request body is the file's bytes, with Content-Type and Content-Length set. Counts against the organisation's storage.",
			Params: []apiParam{
				query("name", str("File name, with extension.")),
				query("folder", str("Folder id; absent for your top level.")),
			},
			Raw: "The file's bytes.", Result: ref("Node"), H: s.handleUploadV1},
		{Method: "POST", Path: "/api/v1/files/folders", ID: "create_folder", Tag: "Files", Summary: "Create a folder", Write: true,
			Body: object(js{"name": str(""), "parent": str("Parent folder id; absent for your top level.")}, "name"), Result: ref("Node"), H: s.handleFolderCreate},
		{Method: "PATCH", Path: "/api/v1/files/{id}", ID: "update_file", Tag: "Files", Summary: "Rename, move, trash, share or publish a file or folder", Write: true,
			Desc: "Everyone who may edit can rename and move within a shared folder. Only the owner can change access, share, put in the trash or switch the public link on and off. " +
				"`shares` replaces the whole list of people it is shared with.",
			Params: []apiParam{id},
			Body: object(js{
				"name":    str("New name."),
				"parent":  str("Folder to move it into; empty string for your top level."),
				"access":  enum("org lets everyone in the organisation edit.", "private", "org"),
				"trashed": boolean("Put in or take out of the trash."),
				"shares":  array(object(js{"user": str("Member id."), "role": enum("", "view", "edit")}, "user"), "People it is shared with."),
				"link":    boolean("Switch the public link on or off. Anyone with the link can download."),
			}),
			Result: with(ref("Node"), js{"publicUrl": str("")}), H: s.handleFileUpdateV1},
		{Method: "DELETE", Path: "/api/v1/files/{id}", ID: "delete_file", Tag: "Files", Summary: "Delete a file or folder for good", Write: true,
			Desc:   "Owner only. A folder goes with everything in it, documents included. To keep a way back, put it in the trash with update_file instead.",
			Params: []apiParam{id}, Result: okResult, H: s.handleNodeDelete},
		{Method: "GET", Path: "/api/v1/blobs/{id}", ID: "get_image", Tag: "Files", Summary: "Download a picture used in a document or presentation",
			Desc: "Pictures inside documents are addressed as /api/v1/blobs/<id>.", Params: []apiParam{pathParam("id", "")}, File: true, H: s.handleBlobGet},
	}
}

func (s *Server) publicURL(r *http.Request, n *Node) string {
	if n.Link == "" {
		return ""
	}
	return baseURL(r) + "/f/" + n.Link
}

type nodeOut struct {
	*Node
	PublicURL string `json:"publicUrl,omitempty"`
}

func (s *Server) handleFilesV1(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	folder, search := q.Get("folder"), strings.TrimSpace(q.Get("q"))
	trashed := q.Get("trashed") == "true"
	if folder != "" {
		if role, n, gone := s.nodeRole(u, folder); n == nil || role == "" || n.Kind != "folder" || gone {
			fail(w, 404, "That folder doesn't exist.")
			return
		}
	}
	all := s.fileList(u)
	visible := map[string]bool{}
	for _, n := range all {
		visible[n.ID] = true
	}
	out := []*Node{}
	for _, n := range all {
		switch {
		case search != "":
			if n.Trashed == 0 && matches(search, n.Name) {
				out = append(out, n)
			}
		case trashed:
			if n.Trashed > 0 {
				out = append(out, n)
			}
		case n.Trashed > 0:
		case folder != "":
			if n.Parent == folder {
				out = append(out, n)
			}
		case n.Parent == "" || !visible[n.Parent]:
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind == "folder"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	ok(w, page(r, out))
}

func (s *Server) handleFileGetV1(w http.ResponseWriter, r *http.Request, u *User) {
	role, n, _ := s.nodeRole(u, r.PathValue("id"))
	if n == nil || role == "" {
		fail(w, 404, "That item doesn't exist.")
		return
	}
	s.nodeShares(n)
	ok(w, nodeOut{n, s.publicURL(r, n)})
}

// handleUploadV1 is the app's upload under the API's names for its
// parameters.
func (s *Server) handleUploadV1(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	if q.Get("name") == "" {
		fail(w, 400, "Say what the file is called: ?name=report.pdf")
		return
	}
	q.Set("parent", q.Get("folder"))
	q.Del("id")
	r.URL.RawQuery = q.Encode()
	s.handleFileUpload(w, r, u)
}

func (s *Server) handleFileUpdateV1(w http.ResponseWriter, r *http.Request, u *User) {
	rec := &recorder{header: http.Header{}}
	s.handleNodeUpdate(rec, r, u)
	if rec.code != 200 {
		rec.copyTo(w)
		return
	}
	_, n, _ := s.nodeRole(u, r.PathValue("id"))
	s.nodeShares(n)
	ok(w, nodeOut{n, s.publicURL(r, n)})
}

// --- documents --------------------------------------------------------------

var docPaths = map[string]string{"doc": "/d/", "sheet": "/s/", "slides": "/p/"}

type docOut struct {
	Doc
	URL string `json:"url"`
}

func (s *Server) docOps() []*apiOp {
	id := pathParam("id", "Document id.")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/documents", ID: "list_documents", Tag: "Documents", Summary: "List documents, spreadsheets and presentations",
			Desc: "Everything you can open, most recently changed first.",
			Params: append([]apiParam{
				query("kind", enum("Only this kind.", "doc", "sheet", "slides")),
				query("folder", str("Only those filed in this folder.")),
				query("q", str("Only those whose title contains this. For a search of the contents, use search.")),
				query("trashed", boolean("List your trashed documents instead.")),
			}, pageParams...),
			Result: list(ref("Doc")), H: s.handleDocsV1},
		{Method: "GET", Path: "/api/v1/documents/{id}", ID: "get_document", Tag: "Documents", Summary: "Get a document's details",
			Params: []apiParam{id}, Result: ref("Doc"), H: s.handleDocGetV1},
		{Method: "PATCH", Path: "/api/v1/documents/{id}", ID: "update_document", Tag: "Documents", Summary: "Rename, move, share or trash a document", Write: true,
			Desc:   "Editors can rename and move within a shared folder; only the owner can change access, share or trash. `shares` replaces the whole list.",
			Params: []apiParam{id},
			Body: object(js{
				"title":   str(""),
				"folder":  str("Folder to file it in; empty string for the owner's top level."),
				"access":  enum("org lets everyone in the organisation edit.", "private", "org"),
				"trashed": boolean(""),
				"shares":  array(shareSchema, "People it is shared with."),
			}),
			Result: ref("Doc"), H: s.handleDocUpdateV1},
		{Method: "DELETE", Path: "/api/v1/documents/{id}", ID: "delete_document", Tag: "Documents", Summary: "Delete a document for good", Write: true,
			Desc:   "Owner only; its history goes too. update_document with trashed:true keeps a way back for 30 days.",
			Params: []apiParam{id}, Result: okResult, H: s.handleDocDelete},
		{Method: "GET", Path: "/api/v1/documents/{id}/versions", ID: "list_versions", Tag: "Documents", Summary: "List a document's versions",
			Desc:   "Versions are taken automatically as people work, and by hand with a name. Needs edit access.",
			Params: append([]apiParam{id}, pageParams...), Result: list(ref("Version")), H: s.handleVersionsV1},
		{Method: "POST", Path: "/api/v1/documents/{id}/versions", ID: "create_version", Tag: "Documents", Summary: "Save the current state as a named version", Write: true,
			Params: []apiParam{id}, Body: object(js{"name": str("e.g. \"Sent to the client\".")}), Result: object(js{"id": str("Version id.")}), H: s.handleVersionCreate},
		{Method: "PATCH", Path: "/api/v1/documents/{id}/versions/{version}", ID: "rename_version", Tag: "Documents", Summary: "Name or rename a version", Write: true,
			Params: []apiParam{id, pathParam("version", "Version id.")}, Body: object(js{"name": str("Empty to make it an ordinary automatic version again.")}, "name"), Result: okResult, H: s.handleVersionRename},
	}
}

// docFor returns a document as the caller sees it.
func (s *Server) docFor(r *http.Request, u *User, id string) *docOut {
	for _, d := range s.docList(u) {
		if d.ID == id {
			return &docOut{d, baseURL(r) + docPaths[d.Kind] + d.ID}
		}
	}
	return nil
}

func (s *Server) handleDocsV1(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	kind, folder, title := q.Get("kind"), q.Get("folder"), q.Get("q")
	trashed := q.Get("trashed") == "true"
	out := []docOut{}
	for _, d := range s.docList(u) {
		if (d.Trashed > 0) != trashed || (kind != "" && d.Kind != kind) || (folder != "" && d.Folder != folder) || !matches(title, d.Title) {
			continue
		}
		out = append(out, docOut{d, baseURL(r) + docPaths[d.Kind] + d.ID})
	}
	ok(w, page(r, out))
}

func (s *Server) handleDocGetV1(w http.ResponseWriter, r *http.Request, u *User) {
	if d := s.docFor(r, u, r.PathValue("id")); d != nil {
		ok(w, d)
		return
	}
	fail(w, 404, "That document doesn't exist, or you can't open it.")
}

func (s *Server) handleDocUpdateV1(w http.ResponseWriter, r *http.Request, u *User) {
	rec := &recorder{header: http.Header{}}
	s.handleDocUpdate(rec, r, u)
	if rec.code != 200 {
		rec.copyTo(w)
		return
	}
	s.handleDocGetV1(w, r, u)
}

func (s *Server) handleVersionsV1(w http.ResponseWriter, r *http.Request, u *User) {
	id, _, allowed := s.versionAccess(w, r, u)
	if allowed {
		ok(w, page(r, s.versionList(id)))
	}
}

// --- search -----------------------------------------------------------------

var searchKinds = []string{"documents", "files", "people", "mail", "events", "contacts"}

func (s *Server) searchOps() []*apiOp {
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/search", ID: "search", Tag: "Search", Summary: "Search everything",
			Desc: "One query over documents (titles and contents), files, people, mail, calendar events and contacts. " +
				"Use `in` to search fewer places. Each place returns its best matches.",
			Params: []apiParam{
				query("q", str("What to look for.")),
				query("in", str("Comma-separated: "+strings.Join(searchKinds, ", ")+". Default all.")),
				query("limit", integer("Matches per place, 1 to 50 (default 10).")),
			},
			Result: object(js{
				"documents": array(with(ref("Doc"), js{"snippet": str("Text around the match; matched words between \u0002 and \u0003.")}), ""),
				"files":     array(ref("Node"), ""),
				"people":    array(ref("Person"), ""),
				"mail":      array(ref("MessageSummary"), ""),
				"events":    array(ref("Event"), ""),
				"contacts":  array(ref("Contact"), ""),
			}),
			H: s.handleSearchV1},
	}
}

func (s *Server) handleSearchV1(w http.ResponseWriter, r *http.Request, u *User) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		fail(w, 400, "Say what to look for: ?q=...")
		return
	}
	if len(q) > 200 {
		q = q[:200]
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 50 {
		limit = 10
	}
	in := searchKinds
	if v := r.URL.Query().Get("in"); v != "" {
		in = strings.Split(v, ",")
	}
	out := map[string]any{}
	for _, kind := range in {
		switch strings.TrimSpace(kind) {
		case "documents":
			hits := s.searchDocs(u, q, limit)
			for i := range hits {
				hits[i].URL = baseURL(r) + docPaths[hits[i].Kind] + hits[i].ID
			}
			out["documents"] = hits
		case "files":
			found := []*Node{}
			for _, n := range s.fileList(u) {
				if n.Trashed == 0 && matches(q, n.Name) && len(found) < limit {
					found = append(found, n)
				}
			}
			out["files"] = found
		case "people":
			found := []Person{}
			for _, p := range s.people(u.OrgID) {
				if matches(q, p.Name, p.Email) && len(found) < limit {
					found = append(found, p)
				}
			}
			out["people"] = found
		case "mail":
			out["mail"] = s.searchMail(r, u, q, limit)
		case "events":
			out["events"] = s.searchEvents(r, u, q, limit)
		case "contacts":
			out["contacts"] = s.searchContacts(r, u, q, limit)
		default:
			fail(w, 400, "Search in: "+strings.Join(searchKinds, ", "))
			return
		}
	}
	ok(w, out)
}

// --- an in-process response, for reusing a handler's checks ----------------

type recorder struct {
	header http.Header
	code   int
	body   []byte
}

func (rec *recorder) Header() http.Header { return rec.header }
func (rec *recorder) Write(b []byte) (int, error) {
	if rec.code == 0 {
		rec.code = 200
	}
	rec.body = append(rec.body, b...)
	return len(b), nil
}
func (rec *recorder) WriteHeader(code int) {
	if rec.code == 0 {
		rec.code = code
	}
}

func (rec *recorder) copyTo(w http.ResponseWriter) {
	for k, v := range rec.header {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.code)
	w.Write(rec.body)
}
