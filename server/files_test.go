package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"testing"
)

func (c *client) upload(name, parent, ctype string, body []byte, out *Node) int {
	c.t.Helper()
	req, _ := http.NewRequest("POST", c.base+"/api/files/upload?name="+url.QueryEscape(name)+"&parent="+parent, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if out != nil && res.StatusCode == 200 {
		*out = Node{}
		if err := json.Unmarshal(b, out); err != nil {
			c.t.Fatal(err)
		}
	}
	return res.StatusCode
}

func (c *client) get(path string, header ...string) *http.Response {
	c.t.Helper()
	req, _ := http.NewRequest("GET", c.base+path, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	return res
}

func (c *client) files() map[string]Node {
	c.t.Helper()
	var out struct{ Nodes []Node }
	if code := c.do("GET", "/api/files", nil, &out); code != 200 {
		c.t.Fatalf("list files: %d", code)
	}
	m := map[string]Node{}
	for _, n := range out.Nodes {
		m[n.ID] = n
	}
	return m
}

func (c *client) me() string {
	var boot struct {
		User struct{ ID string } `json:"user"`
	}
	c.do("GET", "/api/boot", nil, &boot)
	return boot.User.ID
}

// addColleague creates a second person in the caller's organisation and
// returns their signed-in client.
func (c *client) addColleague(username string) *client {
	c.t.Helper()
	var made struct{ ID, Password string }
	if code := c.do("POST", "/api/admin/users", map[string]string{"name": username, "username": username}, &made); code != 200 {
		c.t.Fatalf("add %s: %d", username, code)
	}
	jar, _ := cookiejar.New(nil)
	other := &client{c.t, c.base, &http.Client{Jar: jar}}
	if code := other.do("POST", "/api/login", map[string]string{"email": username, "password": made.Password}, nil); code != 200 {
		c.t.Fatalf("login %s: %d", username, code)
	}
	return other
}

// One organisation must never reach another's files, and inside an
// organisation a file is private until it, or a folder above it, is shared.
func TestFilesIsolationAndSharing(t *testing.T) {
	s, ts := newTestServer(t, nil)
	alice, bob := newClient(t, ts), newClient(t, ts)
	alice.signup("Alpha", "alice")
	bob.signup("Beta", "bob")
	carol := alice.addColleague("carol")

	var folder, file, loose Node
	if code := alice.do("POST", "/api/files/folders", map[string]string{"name": "Plans"}, &folder); code != 200 {
		t.Fatalf("create folder: %d", code)
	}
	if code := alice.upload("budget.txt", folder.ID, "text/plain", []byte("secret numbers"), &file); code != 200 {
		t.Fatalf("upload: %d", code)
	}
	alice.upload("loose.txt", "", "text/plain", []byte("top level"), &loose)
	if file.Size != 14 || file.Parent != folder.ID || file.Role != "owner" {
		t.Errorf("uploaded node = %+v", file)
	}
	// Even org-wide access stays inside the organisation.
	alice.do("PATCH", "/api/files/"+folder.ID, map[string]string{"access": "org"}, nil)
	alice.do("PATCH", "/api/files/"+folder.ID, map[string]bool{"link": false}, nil)

	if n := len(bob.files()); n != 0 {
		t.Errorf("another organisation lists %d files", n)
	}
	for _, probe := range [][2]string{
		{"GET", "/api/files/" + file.ID + "/content"},
		{"PATCH", "/api/files/" + file.ID},
		{"DELETE", "/api/files/" + file.ID},
		{"DELETE", "/api/files/" + folder.ID},
		{"POST", "/api/files/" + file.ID + "/to-mail"},
	} {
		if code := bob.do(probe[0], probe[1], map[string]string{"name": "x"}, nil); code != 404 {
			t.Errorf("%s %s from another organisation: %d, want 404", probe[0], probe[1], code)
		}
	}
	if code := bob.upload("planted.txt", folder.ID, "text/plain", []byte("x"), nil); code != 404 {
		t.Errorf("upload into another organisation's folder: %d, want 404", code)
	}
	if code := bob.do("POST", "/api/files/folders", map[string]string{"name": "x", "parent": folder.ID}, nil); code != 404 {
		t.Errorf("folder inside another organisation's folder: %d, want 404", code)
	}
	if code := bob.do("POST", "/api/docs", map[string]string{"kind": "doc", "folder": folder.ID}, nil); code != 404 {
		t.Errorf("document inside another organisation's folder: %d, want 404", code)
	}
	var theirs Node
	bob.upload("bob.txt", "", "text/plain", []byte("bob"), &theirs)
	if code := bob.do("PATCH", "/api/files/"+theirs.ID, map[string]string{"parent": folder.ID}, nil); code != 404 {
		t.Errorf("moving into another organisation's folder: %d, want 404", code)
	}
	// Sharing with someone from another organisation does nothing.
	alice.do("PATCH", "/api/files/"+loose.ID, map[string]any{"shares": []Share{{User: bob.me(), Role: "edit"}}}, nil)
	if n := len(bob.files()); n != 1 {
		t.Errorf("after a cross-organisation share the other side lists %d files, want only its own", n)
	}

	// Inside the organisation: the folder is open to everyone, so Carol can
	// edit what is in it but does not own it; the loose file stays private.
	seen := carol.files()
	if seen[file.ID].Role != "edit" || seen[folder.ID].Role != "edit" {
		t.Errorf("inherited role = %q (file), %q (folder), want edit", seen[file.ID].Role, seen[folder.ID].Role)
	}
	if _, found := seen[loose.ID]; found {
		t.Error("a private file is listed for a colleague")
	}
	if res := carol.get("/api/files/" + loose.ID + "/content"); res.StatusCode != 404 {
		t.Errorf("colleague reading a private file: %d", res.StatusCode)
	}
	if res := carol.get("/api/files/" + file.ID + "/content"); res.StatusCode != 200 {
		t.Errorf("colleague reading a shared file: %d", res.StatusCode)
	}
	if code := carol.do("DELETE", "/api/files/"+file.ID, nil, nil); code != 403 {
		t.Errorf("editor deleting for ever: %d, want 403", code)
	}
	if code := carol.do("PATCH", "/api/files/"+file.ID, map[string]string{"access": "private"}, nil); code != 200 || alice.files()[folder.ID].Access != "org" {
		t.Errorf("an editor must not change sharing (%d)", code)
	}
	// What Carol adds to Alice's folder belongs to Carol but Alice controls it.
	var hers Node
	if code := carol.upload("notes.md", folder.ID, "text/markdown", []byte("# hi"), &hers); code != 200 {
		t.Fatalf("upload into a shared folder: %d", code)
	}
	if got := alice.files()[hers.ID]; got.Owner != carol.me() || got.Role != "owner" {
		t.Errorf("file added by a colleague: owner %q role %q", got.Owner, got.Role)
	}
	// View-only sharing of one file.
	alice.do("PATCH", "/api/files/"+loose.ID, map[string]any{"shares": []Share{{User: carol.me(), Role: "view"}}}, nil)
	if carol.files()[loose.ID].Role != "view" {
		t.Error("view share not applied")
	}
	if code := carol.do("PATCH", "/api/files/"+loose.ID, map[string]string{"name": "renamed"}, nil); code != 403 {
		t.Errorf("viewer renaming: %d, want 403", code)
	}
	// A document filed in the shared folder is open to the colleague too.
	var doc Doc
	alice.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Filed", "folder": folder.ID}, &doc)
	var listed []Doc
	carol.do("GET", "/api/docs", nil, &listed)
	if len(listed) != 1 || listed[0].Role != "edit" || listed[0].Folder != folder.ID {
		t.Errorf("document in a shared folder as the colleague sees it: %+v", listed)
	}
	bob.do("GET", "/api/docs", nil, &listed)
	if len(listed) != 0 {
		t.Errorf("another organisation lists %d documents", len(listed))
	}

	// A folder cannot swallow itself.
	var inner Node
	alice.do("POST", "/api/files/folders", map[string]string{"name": "Inner", "parent": folder.ID}, &inner)
	if code := alice.do("PATCH", "/api/files/"+folder.ID, map[string]string{"parent": inner.ID}, nil); code != 409 {
		t.Errorf("moving a folder into itself: %d, want 409", code)
	}
	// An editor may rearrange inside the shared folder, but not carry things
	// off into a folder of their own (where they would come to own them).
	var den Node
	carol.do("POST", "/api/files/folders", map[string]string{"name": "Carol's own"}, &den)
	if code := carol.do("PATCH", "/api/files/"+file.ID, map[string]string{"parent": den.ID}, nil); code != 403 {
		t.Errorf("editor moving a file into their own folder: %d, want 403", code)
	}
	if code := carol.do("PATCH", "/api/docs/"+doc.ID, map[string]string{"folder": den.ID}, nil); code != 403 {
		t.Errorf("editor moving a document into their own folder: %d, want 403", code)
	}
	if code := carol.do("PATCH", "/api/files/"+file.ID, map[string]string{"parent": inner.ID}, nil); code != 200 {
		t.Errorf("editor moving a file within the shared folder: %d, want 200", code)
	}
	if got := alice.files()[file.ID]; got.Parent != inner.ID {
		t.Errorf("file is in %q after the allowed move", got.Parent)
	}
	carol.do("DELETE", "/api/files/"+den.ID, nil, nil)

	// Trash hides the whole folder from the colleague; deleting it for ever
	// removes the content from disk and the documents filed in it.
	alice.do("PATCH", "/api/files/"+folder.ID, map[string]bool{"trashed": true}, nil)
	if seen := carol.files(); len(seen) != 1 {
		t.Errorf("colleague still lists %d items after the folder was trashed, want only the loose file", len(seen))
	}
	if code := alice.do("DELETE", "/api/files/"+folder.ID, nil, nil); code != 200 {
		t.Fatalf("delete folder: %d", code)
	}
	if _, err := os.Stat(s.filePath(file.ID)); !os.IsNotExist(err) {
		t.Error("content left on disk after delete")
	}
	alice.do("GET", "/api/docs", nil, &listed)
	if len(listed) != 0 {
		t.Errorf("%d documents survive their folder", len(listed))
	}
}

// Uploaded content is hostile until proven otherwise: nothing may run as a
// page on our origin.
func TestFilesAreServedInert(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	page := []byte("<!doctype html><script>alert(document.cookie)</script>")
	cases := []struct {
		name, uploaded, wantType, wantDisposition string
		sandbox                                   bool
	}{
		{"evil.html", "text/html", "text/plain; charset=utf-8", "inline", true},
		{"evil.xhtml", "application/xhtml+xml", "application/octet-stream", "attachment", true},
		{"evil.svg", "image/svg+xml", "image/svg+xml", "inline", true},
		{"script.js", "application/javascript", "text/plain; charset=utf-8", "inline", true},
		{"photo.png", "image/png", "image/png", "inline", true},
		{"paper.pdf", "application/pdf", "application/pdf", "inline", false},
		{"tool.exe", "application/x-msdownload", "application/octet-stream", "attachment", true},
		{"no-type", "", "application/octet-stream", "attachment", true},
		{"lying.html", "application/octet-stream", "text/plain; charset=utf-8", "inline", true},
		{"naïve \"name\"\r\n.txt", "text/plain", "text/plain; charset=utf-8", "inline", true},
	}
	for _, c := range cases {
		var n Node
		if code := a.upload(c.name, "", c.uploaded, page, &n); code != 200 {
			t.Fatalf("%s: upload %d", c.name, code)
		}
		res := a.get("/api/files/" + n.ID + "/content")
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		h := res.Header
		if res.StatusCode != 200 || !bytes.Equal(body, page) {
			t.Errorf("%s: status %d, %d bytes", c.name, res.StatusCode, len(body))
		}
		if got := h.Get("Content-Type"); got != c.wantType {
			t.Errorf("%s: served as %q, want %q", c.name, got, c.wantType)
		}
		if got := h.Get("Content-Disposition"); !strings.HasPrefix(got, c.wantDisposition+"; filename*=UTF-8''") || strings.ContainsAny(got, "\r\n\"") {
			t.Errorf("%s: disposition %q", c.name, got)
		}
		if h.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", c.name)
		}
		csp := h.Get("Content-Security-Policy")
		if !strings.Contains(csp, "default-src 'none'") || strings.Contains(csp, "script-src") || strings.HasPrefix(csp, "sandbox") != c.sandbox {
			t.Errorf("%s: policy %q", c.name, csp)
		}
		// Asking for a download always gets an opaque attachment.
		res = a.get("/api/files/" + n.ID + "/content?dl=1")
		res.Body.Close()
		if res.Header.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") {
			t.Errorf("%s: download served as %q %q", c.name, res.Header.Get("Content-Type"), res.Header.Get("Content-Disposition"))
		}
	}

	// Media can be fetched in ranges.
	var clip Node
	a.upload("clip.mp4", "", "video/mp4", []byte("0123456789"), &clip)
	res := a.get("/api/files/"+clip.ID+"/content", "Range", "bytes=2-5")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 206 || string(body) != "2345" || res.Header.Get("Content-Range") != "bytes 2-5/10" {
		t.Errorf("range request: %d %q %q", res.StatusCode, body, res.Header.Get("Content-Range"))
	}
}

func TestFilesQuota(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	saved := plans["free"]
	t.Cleanup(func() { plans["free"] = saved })

	var n Node
	if code := a.upload("fits.bin", "", "application/octet-stream", make([]byte, 4096), &n); code != 200 {
		t.Fatalf("upload within quota: %d", code)
	}
	var list struct{ Usage, Quota int64 }
	a.do("GET", "/api/files", nil, &list)
	if list.Usage != 4096 || list.Quota != 5<<30 {
		t.Errorf("usage %d of %d", list.Usage, list.Quota)
	}
	var overview struct {
		Usage struct{ Storage, Files int64 } `json:"usage"`
	}
	a.do("GET", "/api/admin/overview", nil, &overview)
	if overview.Usage.Storage != 4096 || overview.Usage.Files != 4096 {
		t.Errorf("admin overview usage = %+v", overview.Usage)
	}
	// With no room left, files and document attachments are both refused.
	plans["free"] = Plan{"Free", 5, 0, 1, false}
	if code := a.upload("over.bin", "", "application/octet-stream", make([]byte, 10), nil); code != 507 {
		t.Errorf("upload over quota: %d, want 507", code)
	}
	if code := a.do("POST", "/api/blobs?name=x", map[string]string{"a": "b"}, nil); code != 507 {
		t.Errorf("attachment over quota: %d, want 507", code)
	}
}

// A public link opens exactly the linked item and what is inside it, to
// anyone, until it is switched off.
func TestFilesPublicLink(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var folder, sub, inside, deep, outside Node
	a.do("POST", "/api/files/folders", map[string]string{"name": "Press kit"}, &folder)
	a.do("POST", "/api/files/folders", map[string]string{"name": "Logos", "parent": folder.ID}, &sub)
	a.upload("readme.txt", folder.ID, "text/plain", []byte("hello world"), &inside)
	a.upload("logo.svg", sub.ID, "image/svg+xml", []byte("<svg/>"), &deep)
	a.upload("private.txt", "", "text/plain", []byte("not for you"), &outside)

	var linked Node
	a.do("PATCH", "/api/files/"+folder.ID, map[string]bool{"link": true}, &linked)
	if len(linked.Link) < 30 {
		t.Fatalf("link token %q", linked.Link)
	}
	guest := newClient(t, ts)
	var info struct {
		Root, At publicItem
		Org      string
		Items    []publicItem
		Path     []publicItem
	}
	if code := guest.do("GET", "/api/public/"+linked.Link, nil, &info); code != 200 || len(info.Items) != 2 || info.Org != "Alpha" {
		t.Fatalf("public folder: %d %+v", code, info)
	}
	if code := guest.do("GET", "/api/public/"+linked.Link+"?at="+sub.ID, nil, &info); code != 200 || len(info.Items) != 1 || len(info.Path) != 1 {
		t.Errorf("public subfolder: %d %+v", code, info)
	}
	res := guest.get("/api/public/" + linked.Link + "/content/" + deep.ID)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("public content: %d %q", res.StatusCode, res.Header.Get("Content-Security-Policy"))
	}
	for _, path := range []string{
		"/api/public/" + linked.Link + "/content/" + outside.ID,
		"/api/public/" + linked.Link + "?at=" + outside.ID,
		"/api/public/" + linked.Link + "/content/" + folder.ID,
		"/api/public/" + strings.Repeat("x", 43),
		"/api/public/",
		"/api/files/" + inside.ID + "/content",
	} {
		if res := guest.get(path); res.StatusCode == 200 {
			t.Errorf("guest reached %s", path)
		}
	}
	if n := len(guest.get("/api/files").Header.Get("Set-Cookie")); n != 0 {
		t.Error("a guest was given a session")
	}
	// In the trash, then switched off: the link is dead both times.
	a.do("PATCH", "/api/files/"+sub.ID, map[string]bool{"trashed": true}, nil)
	if res := guest.get("/api/public/" + linked.Link + "/content/" + deep.ID); res.StatusCode != 404 {
		t.Errorf("content of a trashed subfolder through the link: %d", res.StatusCode)
	}
	a.do("PATCH", "/api/files/"+folder.ID, map[string]bool{"link": false}, nil)
	if code := guest.do("GET", "/api/public/"+linked.Link, nil, nil); code != 404 {
		t.Errorf("switched-off link: %d, want 404", code)
	}
}
