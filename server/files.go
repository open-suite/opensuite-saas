package main

// Files: the drive. Folders and uploaded files are "nodes" in a tree; the
// metadata lives in SQLite and the content on disk under <data>/files, written
// and read as streams. Documents and spreadsheets sit in the same folders
// through docs.folder_id.
//
// Access works like documents (owner, everyone in the organisation, named
// people) and is inherited: whoever may open a folder may open what is inside
// it, and the owner of a folder owns its contents.

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const schemaFiles = `
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL DEFAULT 'private',
  link TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_org ON nodes(org_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_link ON nodes(link) WHERE link != '';
CREATE TABLE IF NOT EXISTS node_shares(
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'edit',
  PRIMARY KEY(node_id, user_id)
) WITHOUT ROWID;
`

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		if _, err := w.Exec(schemaFiles); err != nil {
			return err
		}
		return ensureColumn(w, "docs", "folder_id", "TEXT NOT NULL DEFAULT ''")
	})
}

const (
	maxFileSize  = 2 << 30  // one upload
	maxMailCopy  = 50 << 20 // what the mail engine accepts as one attachment
	maxNodeDepth = 32
	maxNodes     = 20000 // sent to one device
)

type Node struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"` // folder | file
	Name    string  `json:"name"`
	Parent  string  `json:"parent"`
	Owner   string  `json:"owner"`
	Role    string  `json:"role"` // owner | edit | view, inherited from folders
	Access  string  `json:"access"`
	Mime    string  `json:"mime,omitempty"`
	Size    int64   `json:"size"`
	Created int64   `json:"created"`
	Updated int64   `json:"updated"`
	Trashed int64   `json:"trashed,omitempty"`
	Link    string  `json:"link,omitempty"` // public link token, shown to the owner only
	Shares  []Share `json:"shares"`

	share string // the caller's own entry in node_shares
}

const nodeCols = `n.id, n.kind, n.name, n.parent_id, n.owner_id, n.access, n.mime, n.size, n.created, n.updated, n.trashed, n.link`

func scanNode(row interface{ Scan(...any) error }, extra ...any) (*Node, error) {
	n := &Node{Shares: []Share{}}
	dest := append([]any{&n.ID, &n.Kind, &n.Name, &n.Parent, &n.Owner, &n.Access, &n.Mime, &n.Size, &n.Created, &n.Updated, &n.Trashed, &n.Link}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	return n, nil
}

var roleRank = map[string]int{"": 0, "view": 1, "edit": 2, "owner": 3}

func bestRole(a, b string) string {
	if roleRank[b] > roleRank[a] {
		return b
	}
	return a
}

func canEdit(role string) bool { return role == "owner" || role == "edit" }

// cleanName makes a display name safe to store and to put in a header.
func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	for len(s) > 255 {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	if s == "" || s == "." || s == ".." {
		return "Untitled"
	}
	return s
}

func validID(id string) bool { return len(id) == 14 && strings.Trim(id, idAlphabet) == "" }

func (s *Server) filePath(id string) string {
	return filepath.Join(s.cfg.DataDir, "files", id[:2], id)
}

// nodeRole answers "may this user reach this node, and how", walking up
// through its folders. trashed is true when the node or a folder above it is
// in the trash.
func (s *Server) nodeRole(u *User, id string) (role string, node *Node, trashed bool) {
	cur := id
	for depth := 0; cur != "" && depth <= maxNodeDepth+1; depth++ {
		var share string
		n, err := scanNode(s.r.QueryRow(`SELECT `+nodeCols+`, coalesce(sh.role, '') FROM nodes n
			LEFT JOIN node_shares sh ON sh.node_id = n.id AND sh.user_id = ?1 WHERE n.id = ?2 AND n.org_id = ?3`, u.ID, cur, u.OrgID), &share)
		if err != nil {
			if depth == 0 {
				return "", nil, false
			}
			break
		}
		if depth == 0 {
			node = n
		}
		if n.Trashed > 0 {
			trashed = true
		}
		role = bestRole(role, roleOf(u, n.Owner, n.Access, share))
		cur = n.Parent
	}
	if node != nil {
		node.Role = role
		if role != "owner" {
			node.Link = ""
		}
	}
	return role, node, trashed
}

// nodeTree is one organisation's folder structure as one person sees it.
type nodeTree struct {
	u     *User
	nodes map[string]*Node
	role  map[string]string
	gone  map[string]bool // a folder above is in the trash
}

func (s *Server) nodeTree(u *User) *nodeTree {
	t := &nodeTree{u: u, nodes: map[string]*Node{}, role: map[string]string{}, gone: map[string]bool{}}
	rows, err := s.r.Query(`SELECT `+nodeCols+`, coalesce(sh.role, '') FROM nodes n
		LEFT JOIN node_shares sh ON sh.node_id = n.id AND sh.user_id = ?1 WHERE n.org_id = ?2`, u.ID, u.OrgID)
	if err != nil {
		return t
	}
	defer rows.Close()
	for rows.Next() {
		var share string
		if n, err := scanNode(rows, &share); err == nil {
			n.share = share
			t.nodes[n.ID] = n
		}
	}
	return t
}

// resolve fills in the inherited role of a node and whether a folder above it
// is trashed.
func (t *nodeTree) resolve(id string, depth int) (role string, gone bool) {
	n := t.nodes[id]
	if n == nil || depth > maxNodeDepth+1 {
		return "", false
	}
	if r, done := t.role[id]; done {
		return r, t.gone[id]
	}
	role = roleOf(t.u, n.Owner, n.Access, n.share)
	if n.Parent != "" {
		if p := t.nodes[n.Parent]; p != nil {
			pr, pg := t.resolve(n.Parent, depth+1)
			role = bestRole(role, pr)
			gone = pg || p.Trashed > 0
		}
	}
	t.role[id], t.gone[id] = role, gone
	return role, gone
}

// folder reports the caller's role in a folder and whether it is usable (not
// in the trash). Used to place documents.
func (t *nodeTree) folder(id string) (role string, usable bool) {
	n := t.nodes[id]
	if n == nil {
		return "", false
	}
	role, gone := t.resolve(id, 0)
	return role, !gone && n.Trashed == 0
}

// fileList returns every folder and file the user can reach. Trashed items
// are listed for their owner only, and only the item that was trashed, not
// what is inside it.
func (s *Server) fileList(u *User) []*Node {
	t := s.nodeTree(u)
	out := []*Node{}
	idx := map[string]*Node{}
	for id, n := range t.nodes {
		role, gone := t.resolve(id, 0)
		if role == "" || gone || (n.Trashed > 0 && role != "owner") {
			continue
		}
		n.Role = role
		if role != "owner" {
			n.Link = ""
		}
		out = append(out, n)
		idx[id] = n
	}
	rows, err := s.r.Query(`SELECT sh.node_id, sh.user_id, sh.role FROM node_shares sh JOIN nodes n ON n.id = sh.node_id WHERE n.org_id = ?`, u.OrgID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			var sh Share
			rows.Scan(&id, &sh.User, &sh.Role)
			if n := idx[id]; n != nil {
				n.Shares = append(n.Shares, sh)
			}
		}
	}
	return out
}

func (s *Server) nodeShares(n *Node) {
	rows, err := s.r.Query(`SELECT user_id, role FROM node_shares WHERE node_id = ?`, n.ID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sh Share
		rows.Scan(&sh.User, &sh.Role)
		n.Shares = append(n.Shares, sh)
	}
}

func (s *Server) orgFileBytes(orgID string) int64 {
	var n int64
	s.r.QueryRow(`SELECT coalesce(sum(size), 0) FROM nodes WHERE org_id = ?`, orgID).Scan(&n)
	return n
}

func (s *Server) orgQuota(orgID string) int64 {
	var plan string
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, orgID).Scan(&plan)
	return int64(planFor(plan).StorageGB) << 30
}

// Uploads in flight count against the quota before they are finished, so a
// burst of parallel uploads cannot overshoot it.
var quotaHold = struct {
	mu sync.Mutex
	m  map[string]int64
}{m: map[string]int64{}}

// reserve sets aside n bytes of an organisation's quota, or reports that
// they do not fit. The caller must release what it reserved.
func (s *Server) reserve(orgID string, n int64) bool {
	quotaHold.mu.Lock()
	defer quotaHold.mu.Unlock()
	if s.orgUsage(orgID)+quotaHold.m[orgID]+n > s.orgQuota(orgID) {
		return false
	}
	quotaHold.m[orgID] += n
	return true
}

func (s *Server) release(orgID string, n int64) {
	quotaHold.mu.Lock()
	defer quotaHold.mu.Unlock()
	if quotaHold.m[orgID] -= n; quotaHold.m[orgID] <= 0 {
		delete(quotaHold.m, orgID)
	}
}

func (s *Server) routesFiles(m *http.ServeMux) {
	m.HandleFunc("GET /api/files", s.auth(s.handleFileList))
	m.HandleFunc("POST /api/files/folders", s.auth(s.handleFolderCreate))
	m.HandleFunc("POST /api/files/upload", s.auth(s.handleFileUpload))
	m.HandleFunc("POST /api/files/from-mail", s.auth(s.handleFileFromMail))
	m.HandleFunc("PATCH /api/files/{id}", s.auth(s.handleNodeUpdate))
	m.HandleFunc("DELETE /api/files/{id}", s.auth(s.handleNodeDelete))
	m.HandleFunc("GET /api/files/{id}/content", s.auth(s.handleFileContent))
	m.HandleFunc("POST /api/files/{id}/to-mail", s.auth(s.handleFileToMail))
	// Public links: no account needed, the token is the permission.
	m.HandleFunc("GET /api/public/{token}", s.handlePublicInfo)
	m.HandleFunc("GET /api/public/{token}/content/{id}", s.handlePublicContent)
}

func (s *Server) handleFileList(w http.ResponseWriter, r *http.Request, u *User) {
	nodes := s.fileList(u)
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Updated > nodes[j].Updated || (nodes[i].Updated == nodes[j].Updated && nodes[i].ID < nodes[j].ID) })
	if len(nodes) > maxNodes {
		nodes = nodes[:maxNodes]
	}
	ok(w, map[string]any{"nodes": nodes, "usage": s.orgUsage(u.OrgID), "quota": s.orgQuota(u.OrgID), "maxFile": int64(maxFileSize)})
}

// placeIn checks that the user may add something to a folder ("" is their
// own top level).
func (s *Server) placeIn(u *User, parent string) (int, string) {
	if parent == "" {
		return 0, ""
	}
	role, p, trashed := s.nodeRole(u, parent)
	if p == nil || role == "" {
		return 404, "That folder doesn't exist."
	}
	if p.Kind != "folder" || trashed {
		return 409, "That folder is not available."
	}
	if !canEdit(role) {
		return 403, "You can't add to this folder."
	}
	if s.nodeDepth(parent) >= maxNodeDepth {
		return 409, "Folders can't be nested any deeper."
	}
	return 0, ""
}

// topFolder is the outermost folder around a node ("" for no folder).
func (s *Server) topFolder(id string) string {
	top := id
	for depth := 0; id != "" && depth <= maxNodeDepth+1; depth++ {
		top = id
		if s.r.QueryRow(`SELECT parent_id FROM nodes WHERE id = ?`, id).Scan(&id) != nil {
			break
		}
	}
	return top
}

// mayMove decides whether something may go from one folder to another.
// Whoever owns it may put it anywhere they can add to. Someone who can only
// edit it may rearrange it inside the shared folder it lives in, but not
// carry it off into a folder of their own, where they would come to own it.
func (s *Server) mayMove(u *User, role, owner, from, to string) (int, string) {
	if to == "" && owner != u.ID {
		return 403, "Only the owner can move this out of the shared folder."
	}
	if role != "owner" && (from == "" || s.topFolder(from) != s.topFolder(to)) {
		return 403, "Only the owner can move this out of the shared folder."
	}
	return s.placeIn(u, to)
}

func (s *Server) nodeDepth(id string) int {
	d := 0
	for id != "" && d <= maxNodeDepth+1 {
		if s.r.QueryRow(`SELECT parent_id FROM nodes WHERE id = ?`, id).Scan(&id) != nil {
			break
		}
		d++
	}
	return d
}

func (s *Server) handleFolderCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ ID, Name, Parent string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if code, msg := s.placeIn(u, in.Parent); code != 0 {
		fail(w, code, msg)
		return
	}
	id := in.ID
	if !validID(id) {
		id = newID(14)
	}
	t := now()
	n := &Node{ID: id, Kind: "folder", Name: cleanName(in.Name), Parent: in.Parent, Owner: u.ID, Role: "owner", Access: "private", Created: t, Updated: t, Shares: []Share{}}
	if _, err := s.w.Exec(`INSERT INTO nodes(id, org_id, owner_id, parent_id, kind, name, created, updated) VALUES(?,?,?,?,?,?,?,?)`,
		id, u.OrgID, u.ID, n.Parent, "folder", n.Name, t, t); err != nil {
		fail(w, 409, "That folder already exists.")
		return
	}
	if in.Parent != "" {
		n.Role, _, _ = s.nodeRole(u, id)
	}
	ok(w, n)
}

// storeFile streams a body to disk and records it as a new file. The caller
// has already checked the destination and reserved limit bytes of quota.
func (s *Server) storeFile(u *User, id, parent, name, ctype string, body io.Reader, limit int64) (*Node, int, string) {
	if !validID(id) {
		id = newID(14)
	}
	tmpDir := filepath.Join(s.cfg.DataDir, "files", "tmp")
	if err := os.MkdirAll(tmpDir, 0o750); err != nil {
		return nil, 500, "storage error"
	}
	tmp, err := os.CreateTemp(tmpDir, "up-*")
	if err != nil {
		return nil, 500, "storage error"
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, io.LimitReader(body, limit+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, 400, "The upload was interrupted."
	}
	if size > limit {
		return nil, 413, "That file is too large."
	}
	name = cleanName(name)
	ctype, _, _ = mime.ParseMediaType(ctype)
	if ctype == "" || ctype == "application/octet-stream" {
		if byExt, _, _ := mime.ParseMediaType(mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))); byExt != "" {
			ctype = byExt
		} else {
			ctype = "application/octet-stream"
		}
	}
	t := now()
	if _, err := s.w.Exec(`INSERT INTO nodes(id, org_id, owner_id, parent_id, kind, name, mime, size, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		id, u.OrgID, u.ID, parent, "file", name, ctype, size, t, t); err != nil {
		return nil, 409, "That file already exists."
	}
	final := s.filePath(id)
	if err := os.MkdirAll(filepath.Dir(final), 0o750); err == nil {
		err = os.Rename(tmp.Name(), final)
	}
	if err != nil {
		s.w.Exec(`DELETE FROM nodes WHERE id = ?`, id)
		return nil, 500, "storage error"
	}
	n := &Node{ID: id, Kind: "file", Name: name, Parent: parent, Owner: u.ID, Role: "owner", Access: "private", Mime: ctype, Size: size, Created: t, Updated: t, Shares: []Share{}}
	if parent != "" {
		n.Role, _, _ = s.nodeRole(u, id)
	}
	return n, 0, ""
}

// handleFileUpload takes one file as the raw request body:
// POST /api/files/upload?name=..&parent=..&id=.. with Content-Length set.
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	parent := q.Get("parent")
	if code, msg := s.placeIn(u, parent); code != 0 {
		fail(w, code, msg)
		return
	}
	size := r.ContentLength
	if size < 0 {
		fail(w, 411, "The upload must say how large it is.")
		return
	}
	if size > maxFileSize {
		fail(w, 413, "That file is too large (2 GB limit).")
		return
	}
	if !s.reserve(u.OrgID, size) {
		fail(w, 507, "Your organisation's storage is full.")
		return
	}
	defer s.release(u.OrgID, size)
	n, code, msg := s.storeFile(u, q.Get("id"), parent, q.Get("name"), r.Header.Get("Content-Type"), r.Body, size)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	ok(w, n)
}

func (s *Server) handleNodeUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	role, n, _ := s.nodeRole(u, id)
	if n == nil || role == "" {
		fail(w, 404, "That item doesn't exist.")
		return
	}
	if !canEdit(role) {
		fail(w, 403, "You can't change this item.")
		return
	}
	var in struct {
		Name    *string
		Parent  *string
		Access  *string
		Trashed *bool
		Shares  *[]Share
		Link    *bool
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.Parent != nil && *in.Parent != n.Parent {
		dest := *in.Parent
		if code, msg := s.mayMove(u, role, n.Owner, n.Parent, dest); code != 0 {
			fail(w, code, msg)
			return
		}
		// A folder cannot be moved into itself or anything inside it.
		for cur, depth := dest, 0; cur != "" && depth <= maxNodeDepth+1; depth++ {
			if cur == id {
				fail(w, 409, "A folder can't be moved into itself.")
				return
			}
			if s.r.QueryRow(`SELECT parent_id FROM nodes WHERE id = ?`, cur).Scan(&cur) != nil {
				break
			}
		}
		s.w.Exec(`UPDATE nodes SET parent_id = ? WHERE id = ?`, dest, id)
	}
	if in.Name != nil {
		s.w.Exec(`UPDATE nodes SET name = ?, updated = ? WHERE id = ?`, cleanName(*in.Name), now(), id)
	}
	if role == "owner" {
		if in.Access != nil && (*in.Access == "private" || *in.Access == "org") {
			s.w.Exec(`UPDATE nodes SET access = ? WHERE id = ?`, *in.Access, id)
		}
		if in.Trashed != nil {
			t := int64(0)
			if *in.Trashed {
				t = now()
			}
			s.w.Exec(`UPDATE nodes SET trashed = ? WHERE id = ?`, t, id)
		}
		if in.Link != nil {
			link := ""
			if *in.Link {
				if link = n.Link; link == "" {
					link = newToken()
				}
			}
			s.w.Exec(`UPDATE nodes SET link = ? WHERE id = ?`, link, id)
		}
		if in.Shares != nil {
			if tx, err := s.w.Begin(); err == nil {
				tx.Exec(`DELETE FROM node_shares WHERE node_id = ?`, id)
				for _, sh := range *in.Shares {
					if sh.Role != "view" {
						sh.Role = "edit"
					}
					// Only people in the same organisation can be added.
					tx.Exec(`INSERT OR IGNORE INTO node_shares(node_id, user_id, role) SELECT ?, id, ? FROM users WHERE id = ? AND org_id = ?`,
						id, sh.Role, sh.User, u.OrgID)
				}
				tx.Commit()
			}
		}
	}
	_, fresh, _ := s.nodeRole(u, id)
	if fresh == nil {
		fail(w, 404, "That item doesn't exist.")
		return
	}
	s.nodeShares(fresh)
	ok(w, fresh)
}

// purgeNode removes a node, everything inside it and the documents filed
// there, for good.
func (s *Server) purgeNode(id string) {
	ids := []string{id}
	for i := 0; i < len(ids); i++ {
		rows, err := s.r.Query(`SELECT id FROM nodes WHERE parent_id = ?`, ids[i])
		if err != nil {
			continue
		}
		for rows.Next() {
			var c string
			rows.Scan(&c)
			ids = append(ids, c)
		}
		rows.Close()
	}
	for _, n := range ids {
		s.w.Exec(`DELETE FROM doc_updates WHERE doc_id IN (SELECT id FROM docs WHERE folder_id = ?)`, n)
		s.w.Exec(`DELETE FROM docs WHERE folder_id = ?`, n)
		s.w.Exec(`DELETE FROM nodes WHERE id = ?`, n)
		os.Remove(s.filePath(n))
	}
}

func (s *Server) handleNodeDelete(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	role, n, _ := s.nodeRole(u, id)
	if n == nil || role == "" {
		fail(w, 404, "That item doesn't exist.")
		return
	}
	if role != "owner" {
		fail(w, 403, "Only the owner can delete this.")
		return
	}
	s.purgeNode(id)
	ok(w, map[string]bool{"ok": true})
}

// filesJanitor empties what has been in the trash for a month and clears
// uploads that never finished.
func (s *Server) filesJanitor() {
	rows, err := s.r.Query(`SELECT id FROM nodes WHERE trashed > 0 AND trashed < ?`, now()-30*86400)
	if err == nil {
		var ids []string
		for rows.Next() {
			var id string
			rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
		for _, id := range ids {
			s.purgeNode(id)
		}
	}
	tmp := filepath.Join(s.cfg.DataDir, "files", "tmp")
	if entries, err := os.ReadDir(tmp); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > 24*time.Hour {
				os.Remove(filepath.Join(tmp, e.Name()))
			}
		}
	}
}

// --- serving content ------------------------------------------------------
//
// Everything in the drive was uploaded by someone and is served from our own
// origin, so nothing here may ever run as a page of ours. Only types on this
// list are shown in place, each as inert data; anything else is a download.

var inlineTypes = map[string]string{
	"image/png": "image/png", "image/jpeg": "image/jpeg", "image/gif": "image/gif", "image/webp": "image/webp",
	"image/avif": "image/avif", "image/bmp": "image/bmp", "image/svg+xml": "image/svg+xml",
	"video/mp4": "video/mp4", "video/webm": "video/webm", "video/ogg": "video/ogg", "video/quicktime": "video/quicktime",
	"audio/mpeg": "audio/mpeg", "audio/mp4": "audio/mp4", "audio/ogg": "audio/ogg", "audio/wav": "audio/wav",
	"audio/x-wav": "audio/wav", "audio/webm": "audio/webm", "audio/flac": "audio/flac", "audio/aac": "audio/aac",
	"audio/x-m4a": "audio/mp4",
	"application/pdf": "application/pdf",
}

// servedType maps what the uploader claimed to what we are willing to say.
// Text of every flavour (HTML, scripts, Markdown, JSON) goes out as plain
// text, which a browser displays and never interprets.
func servedType(stored string) (ctype string, inline bool) {
	if t, found := inlineTypes[stored]; found {
		return t, true
	}
	if strings.HasPrefix(stored, "text/") || stored == "application/json" || stored == "application/xml" ||
		stored == "application/javascript" || stored == "application/x-sh" || stored == "application/x-yaml" {
		return "text/plain; charset=utf-8", true
	}
	return "application/octet-stream", false
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, n *Node) {
	f, err := os.Open(s.filePath(n.ID))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	ctype, inline := servedType(n.Mime)
	disposition := "inline"
	if !inline || r.URL.Query().Has("dl") {
		ctype, disposition = "application/octet-stream", "attachment"
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", disposition+"; filename*=UTF-8''"+url.PathEscape(n.Name))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Referrer-Policy", "no-referrer")
	// A sandboxed response has no origin and runs no script, even if a
	// browser were talked into rendering it. The built-in PDF viewer refuses
	// to start inside a sandbox, so a PDF gets a policy that forbids
	// everything a document could load or run instead.
	if ctype == "application/pdf" {
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'")
	} else {
		h.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'")
	}
	h.Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, "", time.Unix(n.Updated, 0), f)
}

func (s *Server) handleFileContent(w http.ResponseWriter, r *http.Request, u *User) {
	role, n, _ := s.nodeRole(u, r.PathValue("id"))
	if n == nil || role == "" || n.Kind != "file" {
		http.NotFound(w, r)
		return
	}
	s.serveFile(w, r, n)
}

// --- public links ---------------------------------------------------------

// publicNode resolves a link token, and optionally an item inside the linked
// folder. It returns the linked node and the requested one.
func (s *Server) publicNode(token, id string) (root, at *Node) {
	if len(token) < 20 {
		return nil, nil
	}
	var orgID string
	root, err := scanNode(s.r.QueryRow(`SELECT `+nodeCols+`, n.org_id FROM nodes n WHERE n.link = ?`, token), &orgID)
	if err != nil {
		return nil, nil
	}
	// A link stops working while the item, or a folder above it, is in the trash.
	for cur, depth := root.ID, 0; cur != "" && depth <= maxNodeDepth+1; depth++ {
		var trashed int64
		if s.r.QueryRow(`SELECT parent_id, trashed FROM nodes WHERE id = ?`, cur).Scan(&cur, &trashed) != nil {
			break
		}
		if trashed > 0 {
			return nil, nil
		}
	}
	if id == "" || id == root.ID {
		return root, root
	}
	at, err = scanNode(s.r.QueryRow(`SELECT `+nodeCols+` FROM nodes n WHERE n.id = ? AND n.org_id = ?`, id, orgID))
	if err != nil || at.Trashed > 0 {
		return nil, nil
	}
	// The requested item must sit inside the linked folder.
	for cur, depth := at.Parent, 0; depth <= maxNodeDepth+1; depth++ {
		if cur == root.ID {
			return root, at
		}
		var trashed int64
		if cur == "" || s.r.QueryRow(`SELECT parent_id, trashed FROM nodes WHERE id = ?`, cur).Scan(&cur, &trashed) != nil || trashed > 0 {
			break
		}
	}
	return nil, nil
}

type publicItem struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Mime    string `json:"mime,omitempty"`
	Size    int64  `json:"size"`
	Updated int64  `json:"updated"`
}

func publicView(n *Node) publicItem {
	return publicItem{n.ID, n.Kind, n.Name, n.Mime, n.Size, n.Updated}
}

func (s *Server) handlePublicInfo(w http.ResponseWriter, r *http.Request) {
	if !s.lim.allow("public:"+clientIP(r), 600, time.Minute) {
		fail(w, 429, "Too many requests. Try again in a minute.")
		return
	}
	root, at := s.publicNode(r.PathValue("token"), r.URL.Query().Get("at"))
	if root == nil {
		fail(w, 404, "This link is not available. It may have been switched off.")
		return
	}
	var orgName string
	s.r.QueryRow(`SELECT o.name FROM orgs o JOIN nodes n ON n.org_id = o.id WHERE n.id = ?`, root.ID).Scan(&orgName)
	out := map[string]any{"root": publicView(root), "at": publicView(at), "org": orgName, "parent": ""}
	if at.ID != root.ID && at.Parent != root.ID {
		out["parent"] = at.Parent // a folder inside the linked one
	}
	if at.Kind == "folder" {
		items := []publicItem{}
		rows, err := s.r.Query(`SELECT `+nodeCols+` FROM nodes n WHERE n.parent_id = ? AND n.trashed = 0 ORDER BY n.kind DESC, n.name COLLATE NOCASE LIMIT 5000`, at.ID)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				if n, err := scanNode(rows); err == nil {
					items = append(items, publicView(n))
				}
			}
		}
		out["items"] = items
		// The way back up, never past the linked folder.
		path := []publicItem{}
		for cur := at; cur != nil && cur.ID != root.ID && len(path) <= maxNodeDepth; {
			path = append([]publicItem{publicView(cur)}, path...)
			next, err := scanNode(s.r.QueryRow(`SELECT `+nodeCols+` FROM nodes n WHERE n.id = ?`, cur.Parent))
			if err != nil {
				break
			}
			cur = next
		}
		out["path"] = path
	}
	ok(w, out)
}

func (s *Server) handlePublicContent(w http.ResponseWriter, r *http.Request) {
	if !s.lim.allow("public:"+clientIP(r), 600, time.Minute) {
		fail(w, 429, "Too many requests. Try again in a minute.")
		return
	}
	_, at := s.publicNode(r.PathValue("token"), r.PathValue("id"))
	if at == nil || at.Kind != "file" {
		http.NotFound(w, r)
		return
	}
	s.serveFile(w, r, at)
}

// --- mail -----------------------------------------------------------------

// handleFileFromMail copies an attachment from the caller's mailbox into the
// drive, engine to disk, without a trip through the browser.
func (s *Server) handleFileFromMail(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ ID, BlobID, Name, Type, Parent string }
	if readJSON(r, &in) != nil || in.BlobID == "" {
		fail(w, 400, "bad request")
		return
	}
	if !u.MailReady || s.cfg.MailURL == "" {
		fail(w, 503, "Your mailbox is being set up.")
		return
	}
	if code, msg := s.placeIn(u, in.Parent); code != 0 {
		fail(w, code, msg)
		return
	}
	name := cleanName(in.Name)
	if in.Type == "" {
		in.Type = "application/octet-stream"
	}
	path := "/jmap/download/" + url.PathEscape(u.MailID) + "/" + url.PathEscape(in.BlobID) + "/" + url.PathEscape(name) + "?accept=" + url.QueryEscape(in.Type)
	req, err := http.NewRequestWithContext(r.Context(), "GET", s.cfg.MailURL+path, nil)
	if err != nil {
		fail(w, 500, "mail error")
		return
	}
	req.SetBasicAuth(u.Email, u.MailSecret)
	res, err := mailClient.Do(req)
	if err != nil {
		fail(w, 502, "The mail service is not responding.")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		fail(w, 404, "That attachment is no longer available.")
		return
	}
	hold := int64(maxMailCopy)
	if res.ContentLength >= 0 && res.ContentLength < hold {
		hold = res.ContentLength
	}
	if !s.reserve(u.OrgID, hold) {
		fail(w, 507, "Your organisation's storage is full.")
		return
	}
	defer s.release(u.OrgID, hold)
	n, code, msg := s.storeFile(u, in.ID, in.Parent, name, in.Type, res.Body, hold)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	ok(w, n)
}

// handleFileToMail hands a file to the mail engine as an attachment for the
// message the caller is writing.
func (s *Server) handleFileToMail(w http.ResponseWriter, r *http.Request, u *User) {
	role, n, _ := s.nodeRole(u, r.PathValue("id"))
	if n == nil || role == "" || n.Kind != "file" {
		fail(w, 404, "That file doesn't exist.")
		return
	}
	if !u.MailReady || s.cfg.MailURL == "" {
		fail(w, 503, "Your mailbox is being set up.")
		return
	}
	if n.Size > maxMailCopy {
		fail(w, 413, "That file is too large to attach (50 MB limit). Share a link to it instead.")
		return
	}
	f, err := os.Open(s.filePath(n.ID))
	if err != nil {
		fail(w, 404, "That file doesn't exist.")
		return
	}
	defer f.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", s.cfg.MailURL+"/jmap/upload/"+url.PathEscape(u.MailID)+"/", f)
	if err != nil {
		fail(w, 500, "mail error")
		return
	}
	req.ContentLength = n.Size
	req.SetBasicAuth(u.Email, u.MailSecret)
	ctype := n.Mime
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	req.Header.Set("Content-Type", ctype)
	res, err := mailClient.Do(req)
	if err != nil {
		fail(w, 502, "The mail service is not responding.")
		return
	}
	defer res.Body.Close()
	var up struct {
		BlobID string `json:"blobId"`
	}
	if res.StatusCode >= 300 || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&up) != nil || up.BlobID == "" {
		fail(w, 502, "The mail service refused that file.")
		return
	}
	ok(w, map[string]any{"blobId": up.BlobID, "type": ctype, "name": n.Name, "size": n.Size})
}

// ensureColumn adds a column to a table created by an earlier version.
func ensureColumn(w *sql.DB, table, column, def string) error {
	rows, err := w.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		rows.Scan(&name)
		if name == column {
			rows.Close()
			return nil
		}
	}
	rows.Close()
	_, err = w.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + def)
	return err
}
