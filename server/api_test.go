package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// bearer calls the API with a token, the way a program would.
func bearer(t *testing.T, ts *httptest.Server, token, method, path string, body any, out any) int {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, ts.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if out != nil {
		json.Unmarshal(b, out)
	}
	return res.StatusCode
}

func (c *client) token(name string, readOnly bool) string {
	c.t.Helper()
	var tok Token
	if code := c.do("POST", "/api/v1/tokens", map[string]any{"name": name, "readOnly": readOnly}, &tok); code != 200 || tok.Secret == "" {
		c.t.Fatalf("create token: %d %+v", code, tok)
	}
	return tok.Secret
}

// Tokens are stored as hashes, act as their member, can be read-only, and
// stop working when revoked, expired or when their member is suspended.
func TestTokens(t *testing.T) {
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	secret := a.token("Script", false)
	if !strings.HasPrefix(secret, "os_") {
		t.Errorf("secret %q lacks its prefix", secret)
	}
	var stored int
	s.r.QueryRow(`SELECT count(*) FROM api_tokens WHERE hash = ?`, secret).Scan(&stored)
	if stored != 0 {
		t.Error("a secret is stored in the clear")
	}
	var me struct {
		User struct{ Email string }
	}
	if code := bearer(t, ts, secret, "GET", "/api/v1/me", nil, &me); code != 200 || me.User.Email != "alice@office.test" {
		t.Fatalf("me with a token: %d %+v", code, me)
	}
	var list struct{ Items []Token }
	a.do("GET", "/api/v1/tokens", nil, &list)
	if len(list.Items) != 1 || list.Items[0].Secret != "" || list.Items[0].Prefix != secret[:8] {
		t.Errorf("token list = %+v", list.Items)
	}

	// Unknown and malformed credentials.
	for _, tok := range []string{"os_nope", "nope", ""} {
		if code := bearer(t, ts, tok, "GET", "/api/v1/me", nil, nil); code != 401 {
			t.Errorf("token %q: %d, want 401", tok, code)
		}
	}
	res, _ := http.Get(ts.URL + "/api/v1/me")
	if !strings.Contains(res.Header.Get("WWW-Authenticate"), "resource_metadata=") {
		t.Errorf("401 without a pointer to the metadata: %q", res.Header.Get("WWW-Authenticate"))
	}

	// Read-only tokens read but never write.
	ro := a.token("Reader", true)
	if code := bearer(t, ts, ro, "GET", "/api/v1/documents", nil, nil); code != 200 {
		t.Errorf("read-only list: %d", code)
	}
	if code := bearer(t, ts, ro, "POST", "/api/v1/documents", map[string]string{"kind": "doc", "title": "x"}, nil); code != 403 {
		t.Errorf("read-only create: %d, want 403", code)
	}
	if code := bearer(t, ts, ro, "POST", "/api/v1/tokens", map[string]string{"name": "escalate"}, nil); code != 403 {
		t.Errorf("read-only token minting a full one: %d, want 403", code)
	}

	// Expiry.
	s.w.Exec(`UPDATE api_tokens SET until = 1 WHERE name = 'Reader'`)
	if code := bearer(t, ts, ro, "GET", "/api/v1/me", nil, nil); code != 401 {
		t.Errorf("expired token: %d, want 401", code)
	}

	// Revocation.
	a.do("GET", "/api/v1/tokens", nil, &list)
	for _, tok := range list.Items {
		if tok.Name == "Script" {
			a.do("DELETE", "/api/v1/tokens/"+tok.ID, nil, nil)
		}
	}
	if code := bearer(t, ts, secret, "GET", "/api/v1/me", nil, nil); code != 401 {
		t.Errorf("revoked token: %d, want 401", code)
	}

	// A token's Bearer header overrides a cookie, and a cookie never vouches
	// for a cross-site write.
	req, _ := http.NewRequest("POST", ts.URL+"/api/v1/meetings", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://evil.example")
	if res, _ := a.http.Do(req); res.StatusCode != 403 {
		t.Errorf("cross-site write with the cookie: %d, want 403", res.StatusCode)
	}
	full := a.token("Cross-site", false)
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/meetings", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://tool.example")
	req.Header.Set("Authorization", "Bearer "+full)
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("cross-site write with a token: %d", res.StatusCode)
	}
	req, _ = http.NewRequest("GET", ts.URL+"/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer os_wrong")
	if res, _ := a.http.Do(req); res.StatusCode != 401 {
		t.Errorf("a bad token with a good cookie: %d, want 401", res.StatusCode)
	}
}

// One organisation's token never reaches another organisation's data, and a
// member's token never reaches the administration.
func TestTokenIsolation(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a, b := newClient(t, ts), newClient(t, ts)
	a.signup("Alpha", "alice")
	b.signup("Beta", "bob")
	var doc Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Plan"}, &doc)
	a.do("PATCH", "/api/docs/"+doc.ID, map[string]string{"access": "org"}, nil)
	var folder Node
	a.do("POST", "/api/files/folders", map[string]string{"name": "Shared"}, &folder)
	a.do("PATCH", "/api/files/"+folder.ID, map[string]string{"access": "org"}, nil)
	var alice struct{ User struct{ ID string } }
	a.do("GET", "/api/boot", nil, &alice)

	tb := b.token("Bob's", false)
	for _, probe := range []struct{ method, path string }{
		{"GET", "/api/v1/documents/" + doc.ID},
		{"GET", "/api/v1/documents/" + doc.ID + "/text"},
		{"PATCH", "/api/v1/documents/" + doc.ID},
		{"DELETE", "/api/v1/documents/" + doc.ID},
		{"GET", "/api/v1/files/" + folder.ID},
		{"GET", "/api/v1/people/" + alice.User.ID},
		{"GET", "/api/v1/people/alice@office.test"},
	} {
		if code := bearer(t, ts, tb, probe.method, probe.path, map[string]string{"title": "x"}, nil); code != 404 && code != 403 {
			t.Errorf("%s %s from another organisation: %d", probe.method, probe.path, code)
		}
	}
	var docs struct{ Items []Doc }
	bearer(t, ts, tb, "GET", "/api/v1/documents", nil, &docs)
	var people struct{ Items []Person }
	bearer(t, ts, tb, "GET", "/api/v1/people", nil, &people)
	if len(docs.Items) != 0 || len(people.Items) != 1 {
		t.Errorf("another organisation sees %d documents and %d people", len(docs.Items), len(people.Items))
	}

	// A member's token cannot administer.
	var made struct{ ID, Password string }
	a.do("POST", "/api/admin/users", map[string]string{"name": "Carol", "username": "carol"}, &made)
	carol := newClient(t, ts)
	carol.do("POST", "/api/login", map[string]string{"email": "carol", "password": made.Password}, nil)
	tc := carol.token("Carol's", false)
	for _, probe := range []struct{ method, path string }{
		{"GET", "/api/v1/admin/overview"},
		{"POST", "/api/v1/admin/people"},
		{"DELETE", "/api/v1/admin/people/" + alice.User.ID},
	} {
		if code := bearer(t, ts, tc, probe.method, probe.path, map[string]string{"name": "X", "username": "xavier"}, nil); code != 403 {
			t.Errorf("member %s %s: %d, want 403", probe.method, probe.path, code)
		}
	}
	// An admin of another organisation cannot touch Alpha's people.
	if code := bearer(t, ts, tb, "PATCH", "/api/v1/admin/people/"+made.ID, map[string]string{"status": "suspended"}, nil); code != 404 {
		t.Errorf("cross-organisation suspend: %d, want 404", code)
	}
}

// Agents are members without a password: an administrator creates them and
// their tokens; they act only through those tokens; made administrators they
// can administer; suspending or removing them stops their tokens.
func TestAgents(t *testing.T) {
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var agent struct {
		ID, Email, Password string
		Agent               bool
	}
	if code := a.do("POST", "/api/admin/users", map[string]any{"name": "Invoice bot", "username": "invoices", "agent": true}, &agent); code != 200 {
		t.Fatalf("create agent: %d", code)
	}
	if agent.Password != "" || !agent.Agent {
		t.Errorf("agent creation = %+v", agent)
	}
	if code := newClient(t, ts).do("POST", "/api/login", map[string]string{"email": "invoices", "password": ""}, nil); code != 401 {
		t.Errorf("agent password sign-in: %d, want 401", code)
	}
	if code := a.do("PATCH", "/api/admin/users/"+agent.ID, map[string]any{"resetPassword": true}, nil); code != 409 {
		t.Errorf("agent password reset: %d, want 409", code)
	}
	if code := a.do("PATCH", "/api/admin/users/"+agent.ID, map[string]any{"role": "owner"}, nil); code != 409 {
		t.Errorf("agent as owner: %d, want 409", code)
	}
	var people struct{ Items []Person }
	a.do("GET", "/api/v1/people", nil, &people)
	found := false
	for _, p := range people.Items {
		found = found || (p.ID == agent.ID && p.Agent)
	}
	if !found {
		t.Errorf("the agent is not marked in the directory: %+v", people.Items)
	}

	var tok Token
	if code := a.do("POST", "/api/v1/admin/people/"+agent.ID+"/tokens", map[string]any{"name": "prod"}, &tok); code != 200 || tok.Secret == "" {
		t.Fatalf("agent token: %d", code)
	}
	var alice struct{ User struct{ ID string } }
	a.do("GET", "/api/boot", nil, &alice)
	if code := a.do("POST", "/api/v1/admin/people/"+alice.User.ID+"/tokens", map[string]any{"name": "x"}, nil); code != 409 {
		t.Errorf("admin minting a person's token: %d, want 409", code)
	}
	var me struct{ User struct{ Agent bool } }
	if code := bearer(t, ts, tok.Secret, "GET", "/api/v1/me", nil, &me); code != 200 || !me.User.Agent {
		t.Errorf("agent me: %d %+v", code, me)
	}
	// As a member, the agent cannot administer; made admin, it can.
	if code := bearer(t, ts, tok.Secret, "POST", "/api/v1/admin/people", map[string]any{"name": "Dan", "username": "dan"}, nil); code != 403 {
		t.Errorf("member agent adding a person: %d, want 403", code)
	}
	a.do("PATCH", "/api/admin/users/"+agent.ID, map[string]any{"role": "admin"}, nil)
	var dan struct{ ID, Password string }
	if code := bearer(t, ts, tok.Secret, "POST", "/api/v1/admin/people", map[string]any{"name": "Dan", "username": "dan"}, &dan); code != 200 || dan.Password == "" {
		t.Errorf("admin agent adding a person: %d", code)
	}
	if code := bearer(t, ts, tok.Secret, "POST", "/api/v1/admin/domains", map[string]any{"domain": "alpha.example"}, nil); code != 200 {
		t.Errorf("admin agent adding a domain: %d", code)
	}
	if code := bearer(t, ts, tok.Secret, "PATCH", "/api/v1/admin/people/"+dan.ID, map[string]any{"status": "suspended"}, nil); code != 200 {
		t.Errorf("admin agent suspending a person: %d", code)
	}
	// Suspension stops the agent's tokens; reactivation restores them.
	a.do("PATCH", "/api/admin/users/"+agent.ID, map[string]any{"status": "suspended"}, nil)
	if code := bearer(t, ts, tok.Secret, "GET", "/api/v1/me", nil, nil); code != 401 {
		t.Errorf("suspended agent: %d, want 401", code)
	}
	a.do("PATCH", "/api/admin/users/"+agent.ID, map[string]any{"status": "active"}, nil)
	if code := bearer(t, ts, tok.Secret, "GET", "/api/v1/me", nil, nil); code != 200 {
		t.Errorf("reactivated agent: %d", code)
	}
	// Removal takes the tokens with it.
	a.do("DELETE", "/api/admin/users/"+agent.ID, nil, nil)
	var left int
	s.r.QueryRow(`SELECT count(*) FROM api_tokens WHERE user_id = ?`, agent.ID).Scan(&left)
	if left != 0 || bearer(t, ts, tok.Secret, "GET", "/api/v1/me", nil, nil) != 401 {
		t.Errorf("removed agent's tokens: %d left", left)
	}
}

// Agents count towards the plan's people limit, like anyone with a mailbox.
func TestAgentsCountTowardsPlan(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	for i, name := range []string{"bot-a", "bot-b", "bot-c", "bot-d", "bot-e"} {
		code := a.do("POST", "/api/admin/users", map[string]any{"name": name, "username": name, "agent": true}, nil)
		if want := map[bool]int{true: 200, false: 402}[i < 4]; code != want {
			t.Errorf("agent %d: %d, want %d", i+1, code, want)
		}
	}
}

func TestRateLimit(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	tok := a.token("busy", false)
	other := a.token("quiet", false)
	was := apiCallsPerMinute
	apiCallsPerMinute = 3
	defer func() { apiCallsPerMinute = was }()
	for i := 0; i < 3; i++ {
		bearer(t, ts, tok, "GET", "/api/v1/me", nil, nil)
	}
	if code := bearer(t, ts, tok, "GET", "/api/v1/me", nil, nil); code != 429 {
		t.Errorf("fourth call: %d, want 429", code)
	}
	if code := bearer(t, ts, other, "GET", "/api/v1/me", nil, nil); code != 200 {
		t.Errorf("another token is limited separately: %d", code)
	}
}

// Files, documents and meetings through the API, on the app's own handlers.
func TestAPIFilesDocsMeetings(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	tok := a.token("t", false)
	var folder Node
	if code := bearer(t, ts, tok, "POST", "/api/v1/files/folders", map[string]string{"name": "Reports"}, &folder); code != 200 {
		t.Fatalf("folder: %d", code)
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/v1/files?name=notes.txt&folder="+folder.ID, strings.NewReader("hello there"))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "text/plain")
	res, _ := http.DefaultClient.Do(req)
	var file Node
	json.NewDecoder(res.Body).Decode(&file)
	if res.StatusCode != 200 || file.Parent != folder.ID {
		t.Fatalf("upload: %d %+v", res.StatusCode, file)
	}
	var list struct {
		Items []Node
		Next  string
	}
	bearer(t, ts, tok, "GET", "/api/v1/files", nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != folder.ID {
		t.Errorf("top level = %+v", list.Items)
	}
	bearer(t, ts, tok, "GET", "/api/v1/files?folder="+folder.ID, nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != file.ID {
		t.Errorf("folder = %+v", list.Items)
	}
	req, _ = http.NewRequest("GET", ts.URL+"/api/v1/files/"+file.ID+"/content", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, _ = http.DefaultClient.Do(req)
	body, _ := io.ReadAll(res.Body)
	if string(body) != "hello there" {
		t.Errorf("download = %q", body)
	}
	var linked struct {
		Node
		PublicURL string
	}
	bearer(t, ts, tok, "PATCH", "/api/v1/files/"+file.ID, map[string]any{"link": true, "name": "renamed.txt"}, &linked)
	if linked.Name != "renamed.txt" || !strings.Contains(linked.PublicURL, "/f/") {
		t.Errorf("update = %+v", linked)
	}
	var search map[string]json.RawMessage
	bearer(t, ts, tok, "GET", "/api/v1/search?q=renamed&in=files,people", nil, &search)
	if !strings.Contains(string(search["files"]), file.ID) {
		t.Errorf("search = %s", search["files"])
	}

	var doc docOut
	if code := bearer(t, ts, tok, "POST", "/api/v1/documents", map[string]string{"kind": "sheet", "title": "Budget", "folder": folder.ID}, &doc); code != 200 || !strings.HasSuffix(doc.URL, "/s/"+doc.ID) {
		t.Fatalf("create document: %d %+v", code, doc)
	}
	bearer(t, ts, tok, "PATCH", "/api/v1/documents/"+doc.ID, map[string]any{"title": "Budget 2027"}, &doc)
	if doc.Title != "Budget 2027" {
		t.Errorf("rename = %+v", doc)
	}
	var docs struct{ Items []docOut }
	bearer(t, ts, tok, "GET", "/api/v1/documents?kind=sheet&folder="+folder.ID, nil, &docs)
	if len(docs.Items) != 1 {
		t.Errorf("documents = %+v", docs.Items)
	}
	for i := 0; i < 3; i++ {
		bearer(t, ts, tok, "POST", "/api/v1/meetings", map[string]string{"title": "Stand-up"}, nil)
	}
	var meets struct {
		Items []Meeting
		Next  string
	}
	bearer(t, ts, tok, "GET", "/api/v1/meetings?limit=2", nil, &meets)
	if len(meets.Items) != 2 || meets.Next != "2" || !strings.Contains(meets.Items[0].URL, "/meet/") {
		t.Errorf("meetings page = %+v", meets)
	}
	cursor := meets.Next
	meets.Next = ""
	bearer(t, ts, tok, "GET", "/api/v1/meetings?limit=2&cursor="+cursor, nil, &meets)
	if len(meets.Items) != 1 || meets.Next != "" {
		t.Errorf("second page = %+v", meets)
	}
}

// fakeMail answers the JMAP calls the mail API makes, and records them.
func fakeMail(t *testing.T) (*httptest.Server, func() [][]json.RawMessage) {
	var mu sync.Mutex
	var seen [][]json.RawMessage
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ MethodCalls [][]json.RawMessage }
		json.NewDecoder(r.Body).Decode(&in)
		mu.Lock()
		seen = append(seen, in.MethodCalls...)
		mu.Unlock()
		var out [][]any
		for _, c := range in.MethodCalls {
			var name string
			json.Unmarshal(c[0], &name)
			var res any = map[string]any{}
			switch name {
			case "Mailbox/get":
				res = map[string]any{"list": []map[string]any{{"id": "in", "name": "Inbox", "role": "inbox"}, {"id": "dr", "name": "Drafts", "role": "drafts"}, {"id": "se", "name": "Sent", "role": "sent"}}}
			case "Identity/get":
				res = map[string]any{"list": []map[string]any{{"id": "idn", "email": "alice@office.test"}}}
			case "Email/set":
				res = map[string]any{"created": map[string]any{"m": map[string]string{"id": "M1", "threadId": "T1"}}}
			}
			out = append(out, []any{name, res, c[2]})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
	}))
	t.Cleanup(engine.Close)
	return engine, func() [][]json.RawMessage { mu.Lock(); defer mu.Unlock(); return seen }
}

// Mail sent through the API passes the same rule as the app's: a free
// organisation mails only addresses hosted here.
func TestAPISendFollowsPlan(t *testing.T) {
	s, ts := newTestServer(t, nil)
	engine, seen := fakeMail(t)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	s.cfg.MailURL = engine.URL
	s.w.Exec(`UPDATE users SET mail_ready = 1, mail_id = 'acc'`)
	tok := a.token("mailer", false)
	if code := bearer(t, ts, tok, "POST", "/api/v1/mail/send", map[string]any{"to": []string{"Someone <someone@gmail.com>"}, "subject": "Hi", "text": "Hello"}, nil); code != 403 {
		t.Errorf("free plan mailing outside: %d, want 403", code)
	}
	for _, c := range seen() {
		if strings.Contains(string(c[0]), "EmailSubmission") {
			t.Fatal("a refused message reached the engine")
		}
	}
	var sent struct{ ID string }
	if code := bearer(t, ts, tok, "POST", "/api/v1/mail/send", map[string]any{"to": []string{"bob@office.test"}, "subject": "Hi", "text": "Hello"}, &sent); code != 200 || sent.ID != "M1" {
		t.Errorf("mailing a colleague: %d %+v", code, sent)
	}
	var account string
	for _, c := range seen() {
		var args map[string]any
		json.Unmarshal(c[1], &args)
		account, _ = args["accountId"].(string)
		if account != "acc" {
			t.Errorf("call pinned to %q", account)
		}
	}
	s.w.Exec(`UPDATE orgs SET plan = 'team'`)
	if code := bearer(t, ts, tok, "POST", "/api/v1/mail/send", map[string]any{"to": []string{"someone@gmail.com"}, "subject": "Hi", "text": "Hello"}, nil); code != 200 {
		t.Errorf("team plan mailing outside: %d", code)
	}
	if code := bearer(t, ts, tok, "POST", "/api/v1/mail/send", map[string]any{"to": []string{"not an address"}, "subject": "Hi"}, nil); code != 400 {
		t.Errorf("bad address: %d, want 400", code)
	}
}

func pkce() (verifier, challenge string) {
	verifier = newToken()
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// The OAuth flow an MCP client follows: discovery, registration, consent,
// code exchange with PKCE, refresh rotation and revocation.
func TestOAuth(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")

	var prm struct {
		Resource             string
		AuthorizationServers []string `json:"authorization_servers"`
	}
	bearer(t, ts, "", "GET", "/.well-known/oauth-protected-resource/mcp", nil, &prm)
	if prm.Resource != ts.URL+"/mcp" || len(prm.AuthorizationServers) != 1 {
		t.Fatalf("resource metadata = %+v", prm)
	}
	var meta map[string]any
	bearer(t, ts, "", "GET", "/.well-known/oauth-authorization-server", nil, &meta)
	if meta["issuer"] != ts.URL || meta["client_id_metadata_document_supported"] != true {
		t.Fatalf("server metadata = %v", meta)
	}

	var reg map[string]any
	if code := bearer(t, ts, "", "POST", "/oauth/register", map[string]any{"client_name": "Claude", "redirect_uris": []string{"https://claude.example/cb"}, "token_endpoint_auth_method": "none"}, &reg); code != 201 {
		t.Fatalf("register: %d %v", code, reg)
	}
	if code := bearer(t, ts, "", "POST", "/oauth/register", map[string]any{"redirect_uris": []string{"javascript:alert(1)"}}, nil); code != 400 {
		t.Errorf("registering a script address: %d", code)
	}
	clientID := reg["client_id"].(string)
	verifier, challenge := pkce()
	q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {"https://claude.example/cb"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"xyz"}, "scope": {"read write"}, "resource": {ts.URL + "/mcp"}}

	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, _ := noFollow.Get(ts.URL + "/oauth/authorize?" + q.Encode())
	if res.StatusCode != 200 {
		t.Errorf("authorize page: %d", res.StatusCode)
	}
	bad := url.Values{}
	for k, v := range q {
		bad[k] = v
	}
	bad.Set("redirect_uri", "https://evil.example/cb")
	if res, _ := noFollow.Get(ts.URL + "/oauth/authorize?" + bad.Encode()); res.StatusCode != 400 {
		t.Errorf("unregistered redirect: %d, want 400 and no redirect", res.StatusCode)
	}
	bad.Set("redirect_uri", "https://claude.example/cb")
	bad.Set("code_challenge_method", "plain")
	if res, _ := noFollow.Get(ts.URL + "/oauth/authorize?" + bad.Encode()); res.StatusCode != 302 || !strings.Contains(res.Header.Get("Location"), "error=invalid_request") {
		t.Errorf("plain PKCE: %d %s", res.StatusCode, res.Header.Get("Location"))
	}

	var info struct {
		Client            struct{ Name string }
		CanChooseReadOnly bool
	}
	if code := a.do("GET", "/api/oauth/request?"+q.Encode(), nil, &info); code != 200 || info.Client.Name != "Claude" || !info.CanChooseReadOnly {
		t.Fatalf("consent request: %d %+v", code, info)
	}
	if code := newClient(t, ts).do("POST", "/api/oauth/approve", map[string]any{"query": q.Encode()}, nil); code != 401 {
		t.Errorf("approval signed out: %d", code)
	}
	var approved struct{ Redirect string }
	a.do("POST", "/api/oauth/approve", map[string]any{"query": q.Encode()}, &approved)
	back, _ := url.Parse(approved.Redirect)
	code := back.Query().Get("code")
	if back.Host != "claude.example" || back.Query().Get("state") != "xyz" || back.Query().Get("iss") != ts.URL || code == "" {
		t.Fatalf("redirect = %s", approved.Redirect)
	}

	exchange := func(form url.Values) (int, tokenAnswer) {
		res, _ := http.PostForm(ts.URL+"/oauth/token", form)
		var out tokenAnswer
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {clientID}, "redirect_uri": {"https://claude.example/cb"}, "resource": {ts.URL + "/mcp"}}
	form.Set("code_verifier", "wrong")
	if status, _ := exchange(form); status != 400 {
		t.Errorf("wrong verifier: %d", status)
	}
	// The failed attempt used the code up; approve again.
	a.do("POST", "/api/oauth/approve", map[string]any{"query": q.Encode()}, &approved)
	back, _ = url.Parse(approved.Redirect)
	form.Set("code", back.Query().Get("code"))
	form.Set("code_verifier", verifier)
	status, tok := exchange(form)
	if status != 200 || tok.AccessToken == "" || tok.RefreshToken == "" || tok.Scope != "read write" {
		t.Fatalf("exchange: %d %+v", status, tok)
	}
	if status, _ := exchange(form); status != 400 {
		t.Errorf("code reused: %d", status)
	}
	if code := bearer(t, ts, tok.AccessToken, "GET", "/api/v1/me", nil, nil); code != 200 {
		t.Errorf("access token: %d", code)
	}
	var conns struct{ Items []Token }
	a.do("GET", "/api/v1/tokens", nil, &conns)
	if len(conns.Items) != 1 || conns.Items[0].Kind != "connection" || conns.Items[0].Name != "Claude" {
		t.Errorf("connections = %+v", conns.Items)
	}

	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok.RefreshToken}, "client_id": {clientID}}
	status, next := exchange(refresh)
	if status != 200 || next.AccessToken == tok.AccessToken {
		t.Fatalf("refresh: %d", status)
	}
	if status, _ := exchange(refresh); status != 400 {
		t.Errorf("refresh token reused: %d", status)
	}
	if code := bearer(t, ts, tok.AccessToken, "GET", "/api/v1/me", nil, nil); code != 401 {
		t.Errorf("old access token after refresh: %d", code)
	}
	// Narrowing to read on refresh.
	status, ro := exchange(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {next.RefreshToken}, "client_id": {clientID}, "scope": {"read"}})
	if status != 200 || ro.Scope != "read" || bearer(t, ts, ro.AccessToken, "POST", "/api/v1/meetings", map[string]string{}, nil) != 403 {
		t.Errorf("narrowed refresh: %d %+v", status, ro)
	}
	http.PostForm(ts.URL+"/oauth/revoke", url.Values{"token": {ro.RefreshToken}, "client_id": {clientID}})
	if code := bearer(t, ts, ro.AccessToken, "GET", "/api/v1/me", nil, nil); code != 401 {
		t.Errorf("revoked connection: %d", code)
	}
}

// Client ID Metadata Documents: the client's https URL is its id.
func TestOAuthClientMetadataDocument(t *testing.T) {
	_, ts := newTestServer(t, nil)
	var doc *httptest.Server
	doc = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"client_id": doc.URL + "/client.json", "client_name": "Doc Client", "redirect_uris": []string{"http://127.0.0.1:3000/cb"}, "token_endpoint_auth_method": "none"})
	}))
	defer doc.Close()
	was := metadataClient
	metadataClient = doc.Client() // the real one refuses loopback addresses
	defer func() { metadataClient = was }()

	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	_, challenge := pkce()
	q := url.Values{"response_type": {"code"}, "client_id": {doc.URL + "/client.json"}, "redirect_uri": {"http://127.0.0.1:49152/cb"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	var info struct{ Client struct{ Name string } }
	if code := a.do("GET", "/api/oauth/request?"+q.Encode(), nil, &info); code != 200 || info.Client.Name != "Doc Client" {
		t.Errorf("metadata document client (loopback port may vary): %d %+v", code, info)
	}
	if _, err := was.Get(doc.URL + "/client.json"); err == nil {
		t.Error("the metadata fetcher reached a loopback address")
	}
}

func mcpPost(t *testing.T, ts *httptest.Server, token string, headers map[string]string, msg any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(msg)
	req, _ := http.NewRequest("POST", ts.URL+"/mcp", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func modernMeta() map[string]any {
	return map[string]any{"io.modelcontextprotocol/protocolVersion": mcpModern, "io.modelcontextprotocol/clientCapabilities": map[string]any{}}
}

func TestMCP(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	tok := a.token("mcp", false)
	ro := a.token("mcp read", true)

	if status, _ := mcpPost(t, ts, "", nil, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}); status != 401 {
		t.Errorf("anonymous: %d", status)
	}
	if res, _ := http.Get(ts.URL + "/mcp"); res.StatusCode != 405 {
		t.Errorf("GET: %d, want 405", res.StatusCode)
	}

	// A client of an earlier revision: initialize, then calls.
	status, init := mcpPost(t, ts, tok, nil, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}})
	if status != 200 || init["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize: %d %v", status, init)
	}
	if status, _ := mcpPost(t, ts, tok, nil, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); status != 202 {
		t.Errorf("notification: %d", status)
	}
	_, list := mcpPost(t, ts, tok, map[string]string{"MCP-Protocol-Version": "2025-06-18"}, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	tools := list["result"].(map[string]any)["tools"].([]any)
	names := map[string]bool{}
	for _, tool := range tools {
		names[tool.(map[string]any)["name"].(string)] = true
	}
	if !names["send_mail"] || !names["write_document"] || !names["admin_add_person"] {
		t.Errorf("an owner's tools lack something: %d tools", len(tools))
	}
	_, roList := mcpPost(t, ts, ro, nil, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
	for _, tool := range roList["result"].(map[string]any)["tools"].([]any) {
		if tool.(map[string]any)["annotations"].(map[string]any)["readOnlyHint"] != true {
			t.Errorf("read-only token offered %v", tool.(map[string]any)["name"])
		}
	}
	_, call := mcpPost(t, ts, tok, nil, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": map[string]any{"name": "create_meeting", "arguments": map[string]any{"title": "From MCP"}}})
	result := call["result"].(map[string]any)
	if result["isError"] != false || !strings.Contains(result["structuredContent"].(map[string]any)["url"].(string), "/meet/") {
		t.Errorf("tool call = %v", call)
	}
	_, call = mcpPost(t, ts, ro, nil, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": map[string]any{"name": "create_meeting", "arguments": map[string]any{}}})
	if call["result"].(map[string]any)["isError"] != true {
		t.Errorf("read-only token wrote through MCP: %v", call)
	}

	// The current revision: stateless, with mirrored headers.
	headers := map[string]string{"MCP-Protocol-Version": mcpModern, "Mcp-Method": "server/discover"}
	status, disc := mcpPost(t, ts, tok, headers, map[string]any{"jsonrpc": "2.0", "id": 6, "method": "server/discover", "params": map[string]any{"_meta": modernMeta()}})
	if status != 200 || disc["result"].(map[string]any)["resultType"] != "complete" {
		t.Errorf("discover: %d %v", status, disc)
	}
	headers = map[string]string{"MCP-Protocol-Version": mcpModern, "Mcp-Method": "tools/call", "Mcp-Name": "get_me"}
	status, call = mcpPost(t, ts, tok, headers, map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": map[string]any{"name": "get_me", "_meta": modernMeta()}})
	if status != 200 || call["result"].(map[string]any)["isError"] != false {
		t.Errorf("modern call: %d %v", status, call)
	}
	headers["Mcp-Name"] = "list_people"
	if status, out := mcpPost(t, ts, tok, headers, map[string]any{"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": map[string]any{"name": "get_me", "_meta": modernMeta()}}); status != 400 || out["error"].(map[string]any)["code"] != float64(-32020) {
		t.Errorf("header mismatch: %d %v", status, out)
	}
	meta := modernMeta()
	meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01"
	if status, out := mcpPost(t, ts, tok, map[string]string{"MCP-Protocol-Version": "2099-01-01"}, map[string]any{"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": map[string]any{"_meta": meta}}); status != 400 || out["error"].(map[string]any)["code"] != float64(-32022) {
		t.Errorf("unknown version: %d %v", status, out)
	}
	if status, _ := mcpPost(t, ts, tok, map[string]string{"MCP-Protocol-Version": mcpModern, "Mcp-Method": "nope/nothing"}, map[string]any{"jsonrpc": "2.0", "id": 10, "method": "nope/nothing", "params": map[string]any{"_meta": modernMeta()}}); status != 404 {
		t.Errorf("unknown method: %d", status)
	}
}

// The OpenAPI document covers every operation once, with its parameters.
func TestOpenAPI(t *testing.T) {
	s, ts := newTestServer(t, nil)
	var doc struct {
		OpenAPI string
		Paths   map[string]map[string]struct {
			OperationID string
			Parameters  []struct{ Name, In string }
		}
	}
	bearer(t, ts, "", "GET", "/api/v1/openapi.json", nil, &doc)
	if doc.OpenAPI != "3.1.0" {
		t.Fatalf("openapi = %q", doc.OpenAPI)
	}
	ids := map[string]bool{}
	for path, item := range doc.Paths {
		for _, op := range item {
			if ids[op.OperationID] {
				t.Errorf("operation id %s used twice", op.OperationID)
			}
			ids[op.OperationID] = true
			for _, seg := range strings.Split(path, "/") {
				if strings.HasPrefix(seg, "{") {
					declared := false
					for _, p := range op.Parameters {
						declared = declared || (p.In == "path" && "{"+p.Name+"}" == strings.TrimSuffix(seg, "..."))
					}
					if !declared {
						t.Errorf("%s %s does not declare %s", op.OperationID, path, seg)
					}
				}
			}
		}
	}
	if len(ids) != len(s.ops) {
		t.Errorf("%d operations described, %d served", len(ids), len(s.ops))
	}
	res, _ := http.Get(ts.URL + "/api/v1/reference")
	page, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(page), "send_mail") || res.Header.Get("Content-Security-Policy") == "" {
		t.Error("reference page")
	}
}
