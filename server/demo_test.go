package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The seed must be complete: every asset present, every reference resolved,
// and the documents' stand-ins all replaced at a reset.
func TestDemoSeed(t *testing.T) {
	seed, err := loadDemoSeed()
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, p := range seed.People {
		keys[p.Key] = true
	}
	folders, rooms := map[string]bool{"": true}, map[string]bool{"": true}
	for _, f := range seed.Folders {
		if !folders[f.Parent] || !keys[f.Owner] {
			t.Errorf("folder %s: unknown parent or owner", f.Name)
		}
		folders[f.Key] = true
	}
	for _, m := range seed.Meetings {
		rooms[m.Key] = true
	}
	assets := []string{}
	for _, f := range seed.Files {
		assets = append(assets, f.Asset)
		if !folders[f.Folder] || !keys[f.Owner] {
			t.Errorf("file %s: unknown folder or owner", f.Name)
		}
	}
	for _, d := range seed.Docs {
		assets = append(assets, d.Asset)
		if !folders[d.Folder] || !keys[d.Owner] || !docKinds[d.Kind] {
			t.Errorf("document %s: unknown folder, owner or kind", d.Title)
		}
	}
	for _, b := range seed.Blobs {
		assets = append(assets, b.Asset)
	}
	for _, a := range assets {
		if _, err := demoFiles.ReadFile("demo/" + a); err != nil {
			t.Errorf("asset %s: %v", a, err)
		}
	}
	for _, e := range seed.Events {
		if !rooms[e.Meeting] || !keys[e.Owner] || !strings.Contains("montuewedthufrisatsun", e.Day) || (!e.AllDay && e.Minutes == 0) {
			t.Errorf("event %s: unknown room, owner or day, or no length", e.Title)
		}
	}
	for _, g := range seed.Groups {
		if validUsername(g.Login) != "" || !slices.Contains(postingRules, g.Posting) || keys[g.Key] {
			t.Errorf("group %s: bad address, rule or key", g.Name)
		}
		for _, m := range g.Members {
			if !keys[m[0]] || !slices.Contains(groupRoles, m[1]) {
				t.Errorf("group %s: unknown member %s or role %s", g.Name, m[0], m[1])
			}
		}
	}
	sent := map[string]bool{}
	for _, m := range seed.Mail {
		for _, who := range append(append([]string{}, m.ReadBy...), m.RepliedBy...) {
			if !keys[who] {
				t.Errorf("mail %s: marked by unknown %s", m.Key, who)
			}
		}
		if m.ReplyTo != "" && !sent[m.ReplyTo] {
			t.Errorf("mail %s answers %s, which comes later or not at all", m.Key, m.ReplyTo)
		}
		if m.Day >= 0 {
			t.Errorf("mail %s is not in the past", m.Key)
		}
		sent[m.Key] = true
	}

	people := map[string]*User{"ada": {ID: "adaid0000001", Email: "ada@x"}, "grace": {ID: "graceid00001", Email: "grace@x"}}
	at := time.Date(2026, 11, 26, 4, 0, 0, 0, time.UTC)
	brief, err := demoPersonalise(demoAsset("brief.bin"), people, at)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(brief, []byte("@ada@")) || bytes.Contains(brief, []byte("@grace@")) || !bytes.Contains(brief, []byte("graceid00001")) {
		t.Error("people's stand-ins were not replaced")
	}
	if again, _ := demoPersonalise(brief, people, at.Add(time.Hour)); !bytes.Equal(again, brief) {
		t.Error("a time stand-in survived the first pass")
	}
	if len(brief) != len(demoAsset("brief.bin")) {
		t.Error("personalising changed the length of the state")
	}
}

func TestNextMorning(t *testing.T) {
	loc, _ := time.LoadLocation(demoZone)
	for _, c := range [][2]string{
		{"2026-11-26T03:59:00+01:00", "2026-11-26T04:00:00+01:00"},
		{"2026-11-26T04:00:00+01:00", "2026-11-27T04:00:00+01:00"},
		{"2026-11-26T15:00:00+01:00", "2026-11-27T04:00:00+01:00"},
		{"2026-03-28T12:00:00+01:00", "2026-03-29T04:00:00+02:00"}, // clocks go forward
	} {
		from, _ := time.Parse(time.RFC3339, c[0])
		want, _ := time.Parse(time.RFC3339, c[1])
		if got := nextMorning(from, loc); !got.Equal(want) {
			t.Errorf("after %s: %s, want %s", c[0], got, want)
		}
	}
}

// fakeMail stands in for the mail engine: it answers every call plausibly and
// records who called what.
type fakeMail struct {
	mu      sync.Mutex
	users   map[string]bool // accounts that were used, by sign-in
	methods []string
	emptied map[string]bool
	gone    []string // accounts destroyed
	imports []string // accounts mail was imported into
	n       int
}

func (f *fakeMail) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users, f.methods, f.gone, f.imports = map[string]bool{}, nil, nil, nil
}

func (f *fakeMail) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	user, _, _ := r.BasicAuth()
	if user != "admin" {
		f.users[user] = true
	}
	w.Header().Set("Content-Type", "application/json")
	if strings.HasPrefix(r.URL.Path, "/jmap/upload/") {
		f.n++
		json.NewEncoder(w).Encode(map[string]string{"blobId": "blob" + itoa(f.n)})
		return
	}
	var in struct{ MethodCalls [][]json.RawMessage }
	json.NewDecoder(r.Body).Decode(&in)
	var out [][]any
	for _, c := range in.MethodCalls {
		var name string
		var args map[string]json.RawMessage
		json.Unmarshal(c[0], &name)
		json.Unmarshal(c[1], &args)
		f.methods = append(f.methods, name)
		res := map[string]any{}
		switch {
		case name == "Mailbox/get":
			res["list"] = []map[string]string{{"id": "in", "role": "inbox"}, {"id": "old", "role": "", "name": "Old things"}}
		case name == "Calendar/get" || name == "AddressBook/get":
			res["list"] = []map[string]any{{"id": "def", "isDefault": true}, {"id": "extra"}}
		case name == "Email/query":
			res["ids"] = []string{}
			if !f.emptied[user] {
				res["ids"] = []string{"m1", "m2"}
			}
		case name == "Email/set":
			f.emptied[user] = true
		case name == "x:Domain/query":
			res["ids"] = []string{"dom"}
		case strings.HasSuffix(name, "/query"):
			res["ids"] = []string{"x1"}
		}
		created := map[string]any{}
		for _, key := range []string{"create", "emails"} {
			var objs map[string]json.RawMessage
			json.Unmarshal(args[key], &objs)
			for k := range objs {
				f.n++
				created[k] = map[string]string{"id": "id" + itoa(f.n)}
			}
		}
		if len(created) > 0 {
			res["created"] = created
		}
		if name == "x:Account/set" {
			var ids []string
			json.Unmarshal(args["destroy"], &ids)
			f.gone = append(f.gone, ids...)
		}
		if name == "Email/import" {
			var account string
			json.Unmarshal(args["accountId"], &account)
			f.imports = append(f.imports, account)
		}
		out = append(out, []any{name, res, "0"})
	}
	json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
}

func TestDemoReset(t *testing.T) {
	engine := &fakeMail{emptied: map[string]bool{}}
	engine.reset()
	fake := httptest.NewServer(engine)
	defer fake.Close()
	s, ts := newTestServer(t, func(c *Config) { c.MailURL, c.MailAdmin = fake.URL, "admin:secret" })

	ada := newClient(t, ts)
	ada.signup("Scratch", "ada")
	var org string
	s.r.QueryRow(`SELECT org_id FROM users WHERE email = 'ada@office.test'`).Scan(&org)
	s.demo = &demoConfig{org: org, passwords: map[string]string{"ada": "ada-demo-password", "grace.hopper": "grace-demo-password"}}

	// What the owner leaves behind after trying things.
	var junk Doc
	ada.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Untitled"}, &junk)
	var meet Meeting
	ada.do("POST", "/api/meet", map[string]string{"title": "Test room"}, &meet)
	var carol struct{ ID string }
	ada.do("POST", "/api/admin/users", map[string]string{"name": "Carol", "username": "carol"}, &carol)
	var agent struct{ ID string }
	ada.do("POST", "/api/admin/users", map[string]any{"name": "Bot", "username": "bot", "agent": true}, &agent)
	var agentToken Token
	ada.do("POST", "/api/v1/admin/people/"+agent.ID+"/tokens", map[string]string{"name": "bot"}, &agentToken)
	adaToken := ada.token("visitor's script", false)
	ada.do("PATCH", "/api/admin/org", map[string]string{"name": "Renamed"}, nil)
	ada.do("POST", "/api/admin/domains", map[string]string{"domain": "scratch.example"}, nil)
	upload := func(c *client, name string) *Node {
		req, _ := http.NewRequest("POST", ts.URL+"/api/files/upload?name="+name, strings.NewReader("contents of "+name))
		res, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		n := &Node{}
		json.NewDecoder(res.Body).Decode(n)
		return n
	}
	junkFile := upload(ada, "notes.txt")
	live := dial(t, ada, "/api/docs/"+junk.ID+"/sync")
	next(t, live, msgSynced)

	// Another organisation on the same server.
	bob := newClient(t, ts)
	bob.signup("Beta", "bob")
	var bobDoc Doc
	bob.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Beta plans"}, &bobDoc)
	var bobMeet Meeting
	bob.do("POST", "/api/meet", map[string]string{"title": "Beta sync"}, &bobMeet)
	bobFile := upload(bob, "beta.txt")
	var bobMail string
	s.r.QueryRow(`SELECT mail_id FROM users WHERE email = 'bob@office.test'`).Scan(&bobMail)
	var carolMail, agentMail string
	for i := 0; i < 100 && (carolMail == "" || agentMail == ""); i++ { // mailboxes are made in the background
		time.Sleep(10 * time.Millisecond)
		s.r.QueryRow(`SELECT mail_id FROM users WHERE id = ?`, carol.ID).Scan(&carolMail)
		s.r.QueryRow(`SELECT mail_id FROM users WHERE id = ?`, agent.ID).Scan(&agentMail)
	}
	var stray Group
	if code := ada.do("POST", "/api/v1/groups", map[string]string{"name": "Stray", "username": "stray"}, &stray); code != 200 {
		t.Fatalf("a visitor's group: %d", code)
	}
	ada.do("PUT", "/api/v1/groups/"+stray.ID+"/members/"+carol.ID, map[string]string{"role": "user"}, nil)
	var strayMail string
	s.r.QueryRow(`SELECT mail_id FROM mail_groups WHERE id = ?`, stray.ID).Scan(&strayMail)

	engine.reset()
	if err := s.resetDemo(context.Background()); err != nil {
		t.Fatal(err)
	}

	// People: exactly the seed's, with its names, roles and passwords.
	var people []Person
	rows, _ := s.r.Query(`SELECT name, email, role, status FROM users WHERE org_id = ? ORDER BY email`, org)
	for rows.Next() {
		var p Person
		rows.Scan(&p.Name, &p.Email, &p.Role, &p.Status)
		people = append(people, p)
	}
	rows.Close()
	want := []Person{{Name: "Ada Lovelace", Email: "ada@office.test", Role: "owner", Status: "active"}, {Name: "Grace Hopper", Email: "grace.hopper@office.test", Role: "member", Status: "active"}}
	if len(people) != 2 || people[0] != want[0] || people[1] != want[1] {
		t.Errorf("people = %+v", people)
	}
	// Tokens and agents visitors made are gone with them.
	for _, secret := range []string{adaToken, agentToken.Secret} {
		if code := bearer(t, ts, secret, "GET", "/api/v1/me", nil, nil); code != 401 {
			t.Errorf("a token from before the reset: %d, want 401", code)
		}
	}
	var tokens int
	s.r.QueryRow(`SELECT count(*) FROM api_tokens`).Scan(&tokens)
	if tokens != 0 {
		t.Errorf("%d tokens survived the reset", tokens)
	}
	if code := newClient(t, ts).do("POST", "/api/login", map[string]string{"email": "ada", "password": "a-long-password"}, nil); code != 401 {
		t.Errorf("old password: %d, want 401", code)
	}
	grace := newClient(t, ts)
	var gboot struct {
		User struct{ MustChange bool } `json:"user"`
	}
	if code := grace.do("POST", "/api/login", map[string]string{"email": "grace.hopper", "password": "grace-demo-password"}, &gboot); code != 200 || gboot.User.MustChange {
		t.Errorf("grace signing in: %d, must change %v", code, gboot.User.MustChange)
	}
	var name, plan string
	s.r.QueryRow(`SELECT name, plan FROM orgs WHERE id = ?`, org).Scan(&name, &plan)
	if name != "Analytical Engines" || plan != "team" {
		t.Errorf("organisation is %s on %s", name, plan)
	}

	// Content: the seed's and nothing else. Ada's session survived.
	var docs []Doc
	if code := ada.do("GET", "/api/docs", nil, &docs); code != 200 {
		t.Fatalf("ada after the reset: %d", code)
	}
	titles := []string{}
	for _, d := range docs {
		titles = append(titles, d.Title)
	}
	slices.Sort(titles)
	if strings.Join(titles, "|") != "Launch budget|Launch stand-up notes|Loom 1.0 launch brief|Loom 1.0 release checklist|Loom launch plan" {
		t.Errorf("documents = %v", titles)
	}
	var gdocs []Doc
	grace.do("GET", "/api/docs", nil, &gdocs)
	if len(gdocs) != len(docs) {
		t.Errorf("grace sees %d documents, ada %d", len(gdocs), len(docs))
	}
	var files struct{ Nodes []Node }
	ada.do("GET", "/api/files", nil, &files)
	if len(files.Nodes) != 5 {
		t.Errorf("files = %+v", files.Nodes)
	}
	if _, err := os.Stat(s.filePath(junkFile.ID)); err == nil {
		t.Error("an old file is still on disk")
	}
	var meetings []Meeting
	ada.do("GET", "/api/meet", nil, &meetings)
	if len(meetings) != 2 {
		t.Errorf("meetings = %+v", meetings)
	}
	var adaID string
	s.r.QueryRow(`SELECT id FROM users WHERE email = 'ada@office.test'`).Scan(&adaID)
	for _, d := range docs {
		if d.Title == "Loom 1.0 launch brief" {
			res, _ := ada.http.Get(ts.URL + "/api/docs/" + d.ID + "/state")
			var state bytes.Buffer
			state.ReadFrom(res.Body)
			res.Body.Close()
			if !bytes.Contains(state.Bytes(), []byte(adaID)) || bytes.Contains(state.Bytes(), []byte("@ada@")) {
				t.Error("the brief's comments are not Ada's")
			}
		}
	}
	if res, _ := ada.http.Get(ts.URL + "/api/blobs/demoplannerscreen0001"); res.StatusCode != 200 {
		t.Errorf("picture in the presentation: %d", res.StatusCode)
	}
	var domains int
	s.r.QueryRow(`SELECT count(*) FROM domains WHERE org_id = ?`, org).Scan(&domains)
	if domains != 0 {
		t.Error("the custom domain survived")
	}
	// Whoever had a deleted document open was disconnected.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		if _, _, err := live.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Error("an editor of a deleted document is still connected")
			}
			break
		}
	}

	// The other organisation is untouched.
	var bobDocs []Doc
	bob.do("GET", "/api/docs", nil, &bobDocs)
	if len(bobDocs) != 1 || bobDocs[0].ID != bobDoc.ID {
		t.Errorf("Beta's documents = %+v", bobDocs)
	}
	if res, _ := bob.http.Get(ts.URL + "/api/files/" + bobFile.ID + "/content"); res.StatusCode != 200 {
		t.Errorf("Beta's file: %d", res.StatusCode)
	}
	if code := bob.do("GET", "/api/meet/"+bobMeet.Code, nil, nil); code != 200 {
		t.Errorf("Beta's meeting room: %d", code)
	}

	// The mail engine was used only through the demo's own accounts, an
	// account was removed only for the person who was, and nothing was sent.
	for u := range engine.users {
		if u != "ada@office.test" && u != "grace.hopper@office.test" {
			t.Errorf("the reset used the mailbox of %s", u)
		}
	}
	slices.Sort(engine.gone)
	removed := []string{carolMail, agentMail, strayMail}
	slices.Sort(removed)
	if !slices.Equal(engine.gone, removed) || slices.Contains(removed, bobMail) {
		t.Errorf("mail accounts removed: %v (carol %s, agent %s, stray group %s)", engine.gone, carolMail, agentMail, strayMail)
	}
	// Groups: exactly the seed's, with its members, and its mail imported
	// into the group's own mailbox.
	var groups struct{ Items []Group }
	grace.do("GET", "/api/v1/groups", nil, &groups)
	if len(groups.Items) != 1 || groups.Items[0].Email != "sales@office.test" || len(groups.Items[0].Members) != 2 || groups.Items[0].Role != "user" {
		t.Fatalf("groups after the reset = %+v", groups.Items)
	}
	salesMail := groups.Items[0].AccountID
	imported := false
	for _, c := range engine.imports {
		imported = imported || c == salesMail
	}
	if !imported {
		t.Errorf("no mail imported into the group's mailbox %s: %v", salesMail, engine.imports)
	}
	for _, m := range engine.methods {
		if strings.HasPrefix(m, "EmailSubmission") {
			t.Error("the reset sent mail")
		}
	}
	if !slices.Contains(engine.methods, "Email/import") || !slices.Contains(engine.methods, "CalendarEvent/set") || !slices.Contains(engine.methods, "ContactCard/set") {
		t.Errorf("seed not written to the mail engine: %v", engine.methods)
	}

	// Again, on demand: same story, new documents.
	if code := bob.do("POST", "/api/operator/demo-reset", nil, nil); code != 403 {
		t.Errorf("reset by someone who is not an operator: %d", code)
	}
	s.cfg.Operators = []string{"ada@office.test"}
	if code := ada.do("POST", "/api/operator/demo-reset", nil, nil); code != 200 {
		t.Fatalf("operator reset: %d", code)
	}
	var again []Doc
	ada.do("GET", "/api/docs", nil, &again)
	if len(again) != len(docs) || again[0].ID == docs[0].ID {
		t.Error("a second reset did not make a fresh copy")
	}
	var orgs []struct {
		ID   string
		Demo bool
	}
	ada.do("GET", "/api/operator/orgs", nil, &orgs)
	for _, o := range orgs {
		if o.Demo != (o.ID == org) {
			t.Errorf("organisation %s marked demo: %v", o.ID, o.Demo)
		}
	}
}

func TestParseDemo(t *testing.T) {
	c, err := parseDemo("j7axt4urdx, ada:correct-horse-41 ,grace.hopper:another-password")
	if err != nil || c.org != "j7axt4urdx" || c.passwords["grace.hopper"] != "another-password" {
		t.Errorf("parseDemo = %+v, %v", c, err)
	}
	for _, bad := range []string{"j7axt4urdx,ada:correct-horse-41", "j7axt4urdx,ada:short,grace.hopper:another-password", ",ada:correct-horse-41,grace.hopper:another-password"} {
		if _, err := parseDemo(bad); err == nil {
			t.Errorf("parseDemo(%q) accepted", bad)
		}
	}
}
