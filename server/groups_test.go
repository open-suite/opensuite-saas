package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// groupEngine stands in for the mail engine in the group tests: accounts are
// made with the ids it hands out, every group has the standard folders, and
// it records each call with the account it was signed in as.
type groupEngine struct {
	mu    sync.Mutex
	n     int
	calls []engineCall
}

type engineCall struct {
	user, name string
	args       map[string]json.RawMessage
}

func (f *groupEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	user, _, _ := r.BasicAuth()
	w.Header().Set("Content-Type", "application/json")
	if strings.HasPrefix(r.URL.Path, "/jmap/upload/") {
		json.NewEncoder(w).Encode(map[string]string{"blobId": "blob"})
		return
	}
	var in struct{ MethodCalls [][]json.RawMessage }
	json.NewDecoder(r.Body).Decode(&in)
	var out [][]any
	for _, c := range in.MethodCalls {
		var name, account string
		var args map[string]json.RawMessage
		json.Unmarshal(c[0], &name)
		json.Unmarshal(c[1], &args)
		json.Unmarshal(args["accountId"], &account)
		f.calls = append(f.calls, engineCall{user, name, args})
		res := map[string]any{}
		switch name {
		case "x:Account/set", "Email/set", "Mailbox/set", "SieveScript/set":
			created := map[string]any{}
			var objs map[string]json.RawMessage
			json.Unmarshal(args["create"], &objs)
			for k := range objs {
				f.n++
				created[k] = map[string]string{"id": "g" + itoa(f.n), "threadId": "t"}
			}
			res["created"] = created
		case "x:Domain/query":
			res["ids"] = []string{"dom"}
		case "Mailbox/get":
			res["list"] = []map[string]string{{"id": "in", "role": "inbox"}, {"id": "dr", "role": "drafts"}, {"id": "se", "role": "sent"}}
		case "Identity/get":
			email := "alice@office.test"
			if strings.HasPrefix(account, "g") {
				email = "sales@office.test"
			}
			res["list"] = []map[string]string{{"id": "idn", "email": email}}
		}
		out = append(out, []any{name, res, c[2]})
	}
	json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
}

func (f *groupEngine) take() []engineCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.calls
	f.calls = nil
	return out
}

// groupOrg is an organisation with an owner, three members, one of them an
// agent, and another organisation beside it, all with mailboxes.
type groupOrg struct {
	s                       *Server
	ts                      *httptest.Server
	engine                  *groupEngine
	alice, bob, carol, dave *client
	ids                     map[string]string // name -> member id
	botToken                string
}

func newGroupOrg(t *testing.T) *groupOrg {
	engine := &groupEngine{}
	fake := httptest.NewServer(engine)
	t.Cleanup(fake.Close)
	s, ts := newTestServer(t, func(c *Config) { c.MailURL, c.MailAdmin = fake.URL, "admin:secret" })
	o := &groupOrg{s: s, ts: ts, engine: engine, ids: map[string]string{}}
	o.alice, o.dave = newClient(t, ts), newClient(t, ts)
	o.alice.signup("Alpha", "alice")
	o.dave.signup("Beta", "dave")
	for _, name := range []string{"bob", "carol"} {
		var made struct{ ID, Password string }
		o.alice.do("POST", "/api/admin/users", map[string]string{"name": name, "username": name}, &made)
		c := newClient(t, ts)
		c.do("POST", "/api/login", map[string]string{"email": name, "password": made.Password}, nil)
		c.do("POST", "/api/account/password", map[string]string{"password": "a-long-password"}, nil)
		o.ids[name] = made.ID
		if name == "bob" {
			o.bob = c
		} else {
			o.carol = c
		}
	}
	var bot struct{ ID string }
	o.alice.do("POST", "/api/admin/users", map[string]any{"name": "Bot", "username": "bot", "agent": true}, &bot)
	o.ids["bot"] = bot.ID
	var tok Token
	o.alice.do("POST", "/api/v1/admin/people/"+bot.ID+"/tokens", map[string]string{"name": "bot"}, &tok)
	o.botToken = tok.Secret
	s.w.Exec(`UPDATE users SET mail_ready = 1, mail_id = 'm-' || substr(email, 1, instr(email, '@') - 1)`)
	for _, name := range []string{"alice", "dave"} {
		var id string
		s.r.QueryRow(`SELECT id FROM users WHERE email = ?`, name+"@office.test").Scan(&id)
		o.ids[name] = id
	}
	engine.take()
	return o
}

// jmap sends one call through the app's mail endpoint, in a group's mailbox
// when group is set, and returns the status and the account it reached.
func (o *groupOrg) jmap(c *client, group, method string, args map[string]any) int {
	path := "/api/mail/jmap"
	if group != "" {
		path += "?group=" + group
	}
	return c.do("POST", path, map[string]any{"methodCalls": [][]any{{method, args, "0"}}}, nil)
}

func TestGroups(t *testing.T) {
	o := newGroupOrg(t)
	var sales Group
	if code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Sales", "username": "sales", "description": "Leads"}, &sales); code != 200 || sales.Email != "sales@office.test" {
		t.Fatalf("create group: %d %+v", code, sales)
	}
	created := o.engine.take()
	if len(created) == 0 || created[0].name != "x:Account/set" || !strings.Contains(string(created[0].args["create"]), `"@type":"Group"`) {
		t.Fatalf("the engine was not asked for a group account: %+v", created)
	}

	// Addresses are one space: a group cannot take a person's, nor a person a group's.
	if code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Bob", "username": "bob"}, nil); code != 409 {
		t.Errorf("group on a person's address: %d, want 409", code)
	}
	if code := o.alice.do("POST", "/api/admin/users", map[string]string{"name": "S", "username": "sales"}, nil); code != 409 {
		t.Errorf("person on a group's address: %d, want 409", code)
	}
	if code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Postmaster", "username": "postmaster"}, nil); code != 400 {
		t.Errorf("reserved address: %d, want 400", code)
	}
	if code := o.bob.do("POST", "/api/v1/groups", map[string]string{"name": "Mine", "username": "mine"}, nil); code != 403 {
		t.Errorf("member creating a group: %d, want 403", code)
	}

	// Members: bob answers, carol reads, the agent reads.
	for name, role := range map[string]string{"bob": "user", "carol": "viewer", "bot": "viewer"} {
		if code := o.alice.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids[name], map[string]string{"role": role}, nil); code != 200 {
			t.Fatalf("adding %s: %d", name, code)
		}
	}
	// In the engine users become members of the group and viewers see its folders.
	var joined, shared bool
	for _, c := range o.engine.take() {
		joined = joined || (c.name == "x:Account/set" && strings.Contains(string(c.args["update"]), `"m-bob":{"memberGroupIds/`+sales.AccountID))
		shared = shared || (c.name == "Mailbox/set" && strings.Contains(string(c.args["update"]), `"shareWith/m-carol":{"mayReadItems":true,"maySetSeen":true}`))
	}
	if !joined || !shared {
		t.Errorf("engine access: bob a member %v, carol's view shared %v", joined, shared)
	}
	o.alice.do("GET", "/api/v1/groups/"+sales.ID, nil, &sales)
	if len(sales.Members) != 3 {
		t.Errorf("members = %+v", sales.Members)
	}

	// Mail: a viewer reads and marks read; nothing more.
	var groupAcct string
	o.s.r.QueryRow(`SELECT mail_id FROM mail_groups WHERE id = ?`, sales.ID).Scan(&groupAcct)
	if code := o.jmap(o.carol, "sales@office.test", "Email/get", map[string]any{"accountId": "m-alice", "ids": []string{"x"}}); code != 200 {
		t.Errorf("viewer reading: %d", code)
	}
	if calls := o.engine.take(); len(calls) != 1 || string(calls[0].args["accountId"]) != `"`+groupAcct+`"` || calls[0].user != "carol@office.test" {
		t.Errorf("viewer's call reached %+v", calls)
	}
	for _, refused := range []struct {
		method string
		args   map[string]any
	}{
		{"Email/set", map[string]any{"create": map[string]any{"m": map[string]any{}}}},
		{"Email/set", map[string]any{"destroy": []string{"x"}}},
		{"Email/set", map[string]any{"update": map[string]any{"x": map[string]any{"keywords/$flagged": true}}}},
		{"Email/set", map[string]any{"update": map[string]any{"x": map[string]any{"keywords/" + readMark(o.ids["bob"]): true}}}},
		{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"emailId": "x"}}}},
		{"Identity/get", map[string]any{}},
	} {
		if code := o.jmap(o.carol, sales.ID, refused.method, refused.args); code != 403 {
			t.Errorf("viewer %s %v: %d, want 403", refused.method, refused.args, code)
		}
	}
	if code := o.jmap(o.carol, sales.ID, "Email/set", map[string]any{"update": map[string]any{"x": map[string]any{"keywords/$seen": true, "keywords/" + readMark(o.ids["carol"]): true}}}); code != 200 {
		t.Errorf("viewer marking read: %d", code)
	}
	upload := func(c *client, group string) int {
		req, _ := http.NewRequest("POST", o.ts.URL+"/api/mail/upload?group="+group, strings.NewReader("file"))
		res, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := upload(o.carol, sales.ID); code != 403 {
		t.Errorf("viewer uploading an attachment: %d, want 403", code)
	}

	// A user sends as the group, from the group's mailbox only.
	send := func(from string) []any {
		return []any{
			[]any{"Email/set", map[string]any{"create": map[string]any{"m": map[string]any{"from": []map[string]string{{"email": from}}, "to": []map[string]string{{"email": "alice@office.test"}}}}}, "0"},
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"identityId": "i", "emailId": "#m"}}}, "1"},
		}
	}
	if code := o.bob.do("POST", "/api/mail/jmap?group="+sales.ID, map[string]any{"methodCalls": send("sales@office.test")}, nil); code != 200 {
		t.Errorf("user sending as the group: %d", code)
	}
	if code := o.bob.do("POST", "/api/mail/jmap?group="+sales.ID, map[string]any{"methodCalls": send("bob@office.test")}, nil); code != 403 {
		t.Errorf("user sending from the group's mailbox as themselves: %d, want 403", code)
	}
	if code := o.bob.do("POST", "/api/mail/jmap", map[string]any{"methodCalls": send("sales@office.test")}, nil); code != 403 {
		t.Errorf("group's address from a personal mailbox: %d, want 403", code)
	}
	if code := o.carol.do("POST", "/api/mail/jmap", map[string]any{"methodCalls": send("sales@office.test")}, nil); code != 403 {
		t.Errorf("viewer sending as the group from her own mailbox: %d, want 403", code)
	}
	if code := upload(o.bob, sales.ID); code != 200 {
		t.Errorf("user uploading an attachment: %d", code)
	}
	for _, method := range []string{"Mailbox/set", "Identity/set", "VacationResponse/set", "Email/import", "CalendarEvent/get"} {
		if code := o.jmap(o.bob, sales.ID, method, map[string]any{}); code != 403 {
			t.Errorf("user calling %s in the group: %d, want 403", method, code)
		}
	}
	// Sharing a folder with someone is the suite's to do, never a browser's.
	if code := o.jmap(o.bob, "", "Mailbox/set", map[string]any{"update": map[string]any{"in": map[string]any{"shareWith/m-dave": map[string]bool{"mayReadItems": true}}}}); code != 403 {
		t.Errorf("sharing a folder: %d, want 403", code)
	}

	// Outsiders see nothing: not in another organisation, not as a non-member.
	o.engine.take()
	if code := o.jmap(o.dave, sales.ID, "Email/get", map[string]any{}); code != 404 {
		t.Errorf("another organisation reading the group: %d, want 404", code)
	}
	if code := o.jmap(o.dave, "sales@office.test", "Email/get", map[string]any{}); code != 404 {
		t.Errorf("another organisation by address: %d, want 404", code)
	}
	if code := o.jmap(o.alice, sales.ID, "Email/get", map[string]any{}); code != 404 {
		t.Errorf("the owner, who is not a member, reading the group: %d, want 404", code)
	}
	if calls := o.engine.take(); len(calls) != 0 {
		t.Errorf("refused requests reached the engine: %+v", calls)
	}
	var list struct{ Items []Group }
	o.dave.do("GET", "/api/v1/groups", nil, &list)
	if len(list.Items) != 0 || o.dave.do("GET", "/api/v1/groups/"+sales.ID, nil, nil) != 404 {
		t.Errorf("another organisation lists %+v", list.Items)
	}
	if code := o.dave.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["dave"], map[string]string{"role": "user"}, nil); code != 404 {
		t.Errorf("another organisation joining: %d, want 404", code)
	}
	if code := o.alice.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["dave"], map[string]string{"role": "user"}, nil); code != 404 {
		t.Errorf("adding someone from another organisation: %d, want 404", code)
	}
	var boot struct{ Groups []Group }
	o.carol.do("GET", "/api/boot", nil, &boot)
	if len(boot.Groups) != 1 || boot.Groups[0].Role != "viewer" || boot.Groups[0].AccountID != groupAcct {
		t.Errorf("carol's boot groups = %+v", boot.Groups)
	}

	// Group admins manage viewers and users of their own group; group admins
	// are appointed by the organisation's administrators.
	var partners Group
	if code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Partners", "username": "partners"}, &partners); code != 200 {
		t.Fatalf("second group: %d", code)
	}
	if code := o.bob.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["alice"], map[string]string{"role": "viewer"}, nil); code != 403 {
		t.Errorf("user managing members: %d, want 403", code)
	}
	if code := o.bob.do("PATCH", "/api/v1/groups/"+sales.ID, map[string]string{"name": "Bob's"}, nil); code != 403 {
		t.Errorf("user renaming the group: %d, want 403", code)
	}
	o.alice.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["bob"], map[string]string{"role": "admin"}, nil)
	for _, c := range []struct {
		method, who, role string
		want              int
	}{
		{"PUT", "alice", "viewer", 200},
		{"PUT", "carol", "user", 200},
		{"PUT", "carol", "admin", 403},
		{"PUT", "dave", "viewer", 404},
		{"DELETE", "alice", "", 200},
	} {
		if code := o.bob.do(c.method, "/api/v1/groups/"+sales.ID+"/members/"+o.ids[c.who], map[string]string{"role": c.role}, nil); code != c.want {
			t.Errorf("group admin %s %s %s: %d, want %d", c.method, c.who, c.role, code, c.want)
		}
	}
	if code := o.bob.do("PATCH", "/api/v1/groups/"+sales.ID, map[string]string{"name": "Sales team", "posting": "members"}, nil); code != 200 {
		t.Errorf("group admin renaming: %d", code)
	}
	o.alice.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["carol"], map[string]string{"role": "admin"}, nil)
	if code := o.bob.do("DELETE", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["carol"], nil, nil); code != 403 {
		t.Errorf("group admin removing another group admin: %d, want 403", code)
	}
	if code := o.bob.do("PUT", "/api/v1/groups/"+partners.ID+"/members/"+o.ids["carol"], map[string]string{"role": "viewer"}, nil); code != 403 {
		t.Errorf("group admin managing another group: %d, want 403", code)
	}
	if code := o.bob.do("DELETE", "/api/v1/groups/"+sales.ID, nil, nil); code != 403 {
		t.Errorf("group admin deleting the group: %d, want 403", code)
	}

	// Agents are members like anyone, through the API, with the same rules.
	bot := func(method, path string, body any) int { return bearer(t, o.ts, o.botToken, method, path, body, nil) }
	o.engine.take()
	if code := bot("GET", "/api/v1/mail/messages?group="+sales.ID, nil); code != 200 {
		t.Errorf("agent viewer listing the group's mail: %d", code)
	}
	if code := bot("POST", "/api/v1/mail/send?group="+sales.ID, map[string]any{"to": []string{"alice@office.test"}, "subject": "Hi", "text": "Hi"}); code != 403 {
		t.Errorf("agent viewer sending as the group: %d, want 403", code)
	}
	if code := bot("PATCH", "/api/v1/mail/messages/x?group="+sales.ID, map[string]any{"flagged": true}); code != 403 {
		t.Errorf("agent viewer flagging: %d, want 403", code)
	}
	if code := bot("PATCH", "/api/v1/mail/messages/x?group="+sales.ID, map[string]any{"unread": false}); code != 200 {
		t.Errorf("agent viewer marking read: %d", code)
	}
	_, call := mcpPost(t, o.ts, o.botToken, nil, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "send_mail",
		"arguments": map[string]any{"group": sales.ID, "to": []string{"alice@office.test"}, "subject": "Hi", "text": "Hi"}}})
	if result, _ := call["result"].(map[string]any); result["isError"] != true || !strings.Contains(string(mustJSON(result)), "viewer") {
		t.Errorf("agent viewer sending as the group through MCP: %v", call)
	}
	for _, c := range o.engine.take() {
		if strings.HasPrefix(c.name, "EmailSubmission") {
			t.Error("a viewer's message reached the engine")
		}
	}
	o.alice.do("PUT", "/api/v1/groups/"+partners.ID+"/members/"+o.ids["bot"], map[string]string{"role": "admin"}, nil)
	if code := bot("PUT", "/api/v1/groups/"+partners.ID+"/members/"+o.ids["carol"], map[string]string{"role": "user"}); code != 200 {
		t.Errorf("agent group admin adding a member: %d", code)
	}
	var sent struct{ ID string }
	o.alice.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["bot"], map[string]string{"role": "user"}, nil)
	if code := bearer(t, o.ts, o.botToken, "POST", "/api/v1/mail/send?group="+sales.ID, map[string]any{"to": []string{"alice@office.test"}, "subject": "Hi", "text": "Hi"}, &sent); code != 200 {
		t.Errorf("agent user sending as the group: %d", code)
	}
	var from string
	for _, c := range o.engine.take() {
		if c.name == "Email/set" && strings.Contains(string(c.args["create"]), "sales@office.test") {
			from = "sales"
		}
	}
	if from != "sales" {
		t.Error("the API did not send from the group's address")
	}

	// The organisation's administrators can do everything.
	if code := o.alice.do("DELETE", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["carol"], nil, nil); code != 200 {
		t.Errorf("owner removing a group admin: %d", code)
	}
	if code := o.alice.do("DELETE", "/api/v1/groups/"+sales.ID, nil, nil); code != 200 {
		t.Errorf("owner deleting the group: %d", code)
	}
	if code := o.jmap(o.bob, sales.ID, "Email/get", map[string]any{}); code != 404 {
		t.Errorf("a deleted group's mail: %d, want 404", code)
	}
}

// Who may write to a restricted group is a filter on its account.
func TestGroupScript(t *testing.T) {
	o := newGroupOrg(t)
	var sales Group
	o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Sales", "username": "sales", "posting": "members"}, &sales)
	o.alice.do("PUT", "/api/v1/groups/"+sales.ID+"/members/"+o.ids["bob"], map[string]string{"role": "viewer"}, nil)
	var org string
	o.s.r.QueryRow(`SELECT org_id FROM users WHERE email = 'alice@office.test'`).Scan(&org)
	g := o.s.groupIn(org, sales.ID, nil)
	script := o.s.groupScript(g)
	for _, want := range []string{`if exists "Authentication-Results" { discard; stop; }`, `"sales@office.test", "bob@office.test"]`, `reject "Only members of sales@office.test may write to it."`} {
		if !strings.Contains(script, want) {
			t.Errorf("members-only script lacks %s:\n%s", want, script)
		}
	}
	if strings.Contains(script, "carol@") || strings.Contains(script, "dave@") {
		t.Errorf("members-only script lets others in:\n%s", script)
	}
	g.Posting = "organisation"
	script = o.s.groupScript(g)
	if !strings.Contains(script, "carol@office.test") || !strings.Contains(script, "bot@office.test") || strings.Contains(script, "dave@") {
		t.Errorf("organisation script:\n%s", script)
	}
	o.engine.take()
	if code := o.alice.do("PATCH", "/api/v1/groups/"+sales.ID, map[string]string{"posting": "anyone"}, nil); code != 200 {
		t.Fatalf("opening the group: %d", code)
	}
	if code := o.alice.do("PATCH", "/api/v1/groups/"+sales.ID, map[string]string{"posting": "everyone"}, nil); code != 400 {
		t.Errorf("unknown rule: %d, want 400", code)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func TestGroupPlanLimit(t *testing.T) {
	o := newGroupOrg(t)
	for i, name := range []string{"one", "two", "three", "four", "five", "six"} {
		code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": name, "username": "group-" + name}, nil)
		if want := map[bool]int{true: 200, false: 402}[i < 5]; code != want {
			t.Errorf("group %d: %d, want %d", i+1, code, want)
		}
	}
}

// Reserved names are refused on the installation's shared domain but are the
// organisation's to use on its own verified domain.
func TestGroupReservedNames(t *testing.T) {
	o := newGroupOrg(t)
	o.s.w.Exec(`INSERT INTO domains (domain, org_id, mail_ok, created) SELECT 'alpha.example', org_id, 1, 0 FROM users WHERE email = 'alice@office.test'`)
	if code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Support", "username": "support"}, nil); code != 400 {
		t.Errorf("support@ on the shared domain: %d, want 400", code)
	}
	var support struct{ Email string }
	if code := o.alice.do("POST", "/api/v1/groups", map[string]string{"name": "Support", "username": "support", "domain": "alpha.example"}, &support); code != 200 || support.Email != "support@alpha.example" {
		t.Errorf("support@ on own domain: %d %q, want 200", code, support.Email)
	}
	if code := o.alice.do("POST", "/api/admin/users", map[string]string{"name": "Info", "username": "info"}, nil); code != 400 {
		t.Errorf("person named info on the shared domain: %d, want 400", code)
	}
}
