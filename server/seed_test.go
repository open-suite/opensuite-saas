package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

type testBoot struct {
	User struct{ ID, Email string } `json:"user"`
	Org  struct {
		ID          string
		MailDomains []string
		Example     bool
	} `json:"org"`
	People       []Person `json:"people"`
	ExampleError string   `json:"exampleError"`
}

// Organisations get their own domain under OS_ORG_DOMAIN_SUFFIX.
func TestOrgDomain(t *testing.T) {
	s, ts := newTestServer(t, func(c *Config) { c.OrgDomainSuffix = "orgs.test" })

	check := func(slug string) (bool, string) {
		var out struct {
			Available bool
			Reason    string
		}
		newClient(t, ts).do("GET", "/api/signup/check?slug="+slug, nil, &out)
		return out.Available, out.Reason
	}
	for slug, want := range map[string]bool{"shah-daughters": true, "office": false, "mail": false, "opensuite": false, "x": false, "a--b": false, "-ab": false} {
		if got, why := check(slug); got != want {
			t.Errorf("slug %q available = %v (%s), want %v", slug, got, why, want)
		}
	}
	if slugify("Shah & Daughters Ltd.") != "shah-daughters-ltd" || slugify("Café Zürich") != "cafe-zurich" {
		t.Errorf("slugify: %q, %q", slugify("Shah & Daughters Ltd."), slugify("Café Zürich"))
	}

	// The slug comes from the name when none is given; on its own domain an
	// organisation may use the names reserved on the shared one.
	jane := newClient(t, ts)
	var boot testBoot
	if code := jane.do("POST", "/api/signup", map[string]string{"org": "Shah & Daughters", "name": "Jane Shah", "username": "support", "password": "a-long-password"}, &boot); code != 200 {
		t.Fatalf("signup: %d", code)
	}
	if boot.User.Email != "support@shah-daughters.orgs.test" || len(boot.Org.MailDomains) != 1 || boot.Org.MailDomains[0] != "shah-daughters.orgs.test" {
		t.Errorf("address %s, domains %v", boot.User.Email, boot.Org.MailDomains)
	}
	if ok, _ := check("shah-daughters"); ok {
		t.Error("a slug in use is offered again")
	}
	if code := newClient(t, ts).do("POST", "/api/signup", map[string]string{"org": "Other", "slug": "shah-daughters", "name": "Bob", "username": "bob", "password": "a-long-password"}, nil); code != 409 {
		t.Errorf("a second organisation on the same domain: %d", code)
	}
	if code := newClient(t, ts).do("POST", "/api/signup", map[string]string{"org": "Mail", "slug": "mail", "name": "Bob", "username": "bob", "password": "a-long-password"}, nil); code != 409 {
		t.Errorf("a reserved slug: %d", code)
	}
	// Signing in takes the whole address.
	if code := newClient(t, ts).do("POST", "/api/login", map[string]string{"email": "support@shah-daughters.orgs.test", "password": "a-long-password"}, nil); code != 200 {
		t.Errorf("sign in: %d", code)
	}

	// People and groups default to the organisation's domain.
	var added struct{ Email string }
	if code := jane.do("POST", "/api/admin/users", map[string]string{"name": "Info Desk", "username": "info"}, &added); code != 200 || added.Email != "info@shah-daughters.orgs.test" {
		t.Errorf("add person: %d %s", code, added.Email)
	}
	if code := jane.do("POST", "/api/admin/users", map[string]string{"name": "Shared", "username": "sam", "domain": "office.test"}, nil); code != 400 {
		t.Errorf("a person on the shared domain: %d", code)
	}

	// It is listed, needs no records, does not count and cannot be removed;
	// nothing under the suffix can be claimed as a custom domain.
	var ov struct{ Domains []Domain }
	jane.do("GET", "/api/admin/overview", nil, &ov)
	if len(ov.Domains) != 1 || !ov.Domains[0].Included || len(ov.Domains[0].Records) != 0 || !ov.Domains[0].MailOK {
		t.Errorf("domains = %+v", ov.Domains)
	}
	if code := jane.do("DELETE", "/api/admin/domains/shah-daughters.orgs.test", nil, nil); code != 409 {
		t.Errorf("removing the organisation's domain: %d", code)
	}
	for _, d := range []string{"other.orgs.test", "orgs.test"} {
		if code := jane.do("POST", "/api/admin/domains", map[string]string{"domain": d}, nil); code != 400 {
			t.Errorf("claiming %s: %d", d, code)
		}
	}
	if code := jane.do("POST", "/api/admin/domains", map[string]string{"domain": "shahanddaughters.example"}, nil); code != 200 {
		t.Errorf("the free plan's one custom domain: %d", code)
	}

	// Free organisations may mail other organisations' own domains: they are
	// hosted here.
	other := newClient(t, ts)
	other.do("POST", "/api/signup", map[string]string{"org": "Hale and Co", "name": "Jonas", "username": "jonas", "password": "a-long-password"}, nil)
	u := s.userByID(boot.User.ID)
	send := func(to string) bool {
		calls := [][]json.RawMessage{
			{json.RawMessage(`"Email/set"`), json.RawMessage(`{"create":{"m":{"to":[{"email":"` + to + `"}]}}}`)},
			{json.RawMessage(`"EmailSubmission/set"`), json.RawMessage(`{"create":{"s":{"emailId":"#m"}}}`)},
		}
		return s.recipientsAllowed(u, calls)
	}
	if !send("jonas@hale-and-co.orgs.test") || send("someone@gmail.example") {
		t.Error("the free plan's mail rule does not know organisations' own domains")
	}
}

// Without the suffix, sign-up is as before and example data is not offered.
func TestNoOrgDomain(t *testing.T) {
	_, ts := newTestServer(t, nil)
	var boot testBoot
	if code := newClient(t, ts).do("POST", "/api/signup", map[string]string{"org": "Acme", "name": "Ann", "username": "ann", "password": "a-long-password"}, &boot); code != 200 || boot.User.Email != "ann@office.test" {
		t.Errorf("signup: %d %s", code, boot.User.Email)
	}
	if code := newClient(t, ts).do("POST", "/api/signup", map[string]any{"org": "Beta", "name": "Bo", "username": "bo", "password": "a-long-password", "example": true}, nil); code != 400 {
		t.Errorf("example data without own domains: %d", code)
	}
	if code := newClient(t, ts).do("GET", "/api/signup/check?slug=beta", nil, nil); code != 404 {
		t.Errorf("slug check without own domains: %d", code)
	}
}

func TestExampleData(t *testing.T) {
	engine := &fakeMail{emptied: map[string]bool{}}
	engine.reset()
	fake := httptest.NewServer(engine)
	defer fake.Close()
	s, ts := newTestServer(t, func(c *Config) {
		c.MailURL, c.MailAdmin, c.OrgDomainSuffix = fake.URL, "admin:secret", "orgs.test"
	})

	// The founder takes "ada", which the story's Ada would have had.
	me := newClient(t, ts)
	var boot testBoot
	if code := me.do("POST", "/api/signup", map[string]any{"org": "Ritza", "name": "Gareth Dwyer", "username": "ada", "password": "a-long-password", "example": true}, &boot); code != 200 || boot.ExampleError != "" {
		t.Fatalf("signup with example data: %d %s", code, boot.ExampleError)
	}
	org := boot.Org.ID
	if !boot.Org.Example || len(boot.People) != 3 {
		t.Fatalf("example %v, people %+v", boot.Org.Example, boot.People)
	}
	var examples []Person
	for _, p := range boot.People {
		if p.Example {
			examples = append(examples, p)
			if p.Photo == 0 || !strings.HasSuffix(p.Email, "@ritza.orgs.test") {
				t.Errorf("example colleague %+v", p)
			}
		}
	}
	if len(examples) != 2 || !slices.ContainsFunc(examples, func(p Person) bool { return p.Email == "ada-2@ritza.orgs.test" }) {
		t.Errorf("example colleagues = %+v", examples)
	}
	// They cannot sign in, and do not take places on the Free plan.
	if code := newClient(t, ts).do("POST", "/api/login", map[string]string{"email": examples[0].Email, "password": ""}, nil); code != 401 {
		t.Errorf("an example colleague signing in: %d", code)
	}
	if code := me.do("PATCH", "/api/admin/users/"+examples[0].ID, map[string]bool{"resetPassword": true}, nil); code != 409 {
		t.Errorf("giving an example colleague a password: %d", code)
	}
	for i, name := range []string{"bea", "cal", "dee", "eve", "fay"} {
		code := me.do("POST", "/api/admin/users", map[string]string{"name": name, "username": name}, nil)
		if want := map[bool]int{true: 200, false: 402}[i < 4]; code != want {
			t.Errorf("adding person %d: %d, want %d", i+2, code, want)
		}
	}
	res, _ := me.http.Get(ts.URL + "/api/v1/people/" + examples[0].ID + "/photo")
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/png" {
		t.Errorf("example colleague's picture: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	res.Body.Close()

	// The founder sees the story's documents, the checklist shared with them,
	// and is an admin of the example group, which does not count either.
	var docs []Doc
	me.do("GET", "/api/docs", nil, &docs)
	if len(docs) != 5 {
		t.Errorf("documents = %d", len(docs))
	}
	var groups struct{ Items []Group }
	me.do("GET", "/api/v1/groups", nil, &groups)
	if len(groups.Items) != 1 || groups.Items[0].Email != "sales@ritza.orgs.test" || groups.Items[0].Role != "admin" {
		t.Errorf("groups = %+v", groups.Items)
	}
	var mine int
	s.r.QueryRow(`SELECT count(*) FROM example_items WHERE org_id = ? AND owner = ? AND kind IN ('mail', 'event', 'contact')`, org, boot.User.ID).Scan(&mine)
	if mine < 5 {
		t.Errorf("only %d example items in the founder's mailbox were recorded", mine)
	}
	for _, m := range engine.methods {
		if strings.HasPrefix(m, "EmailSubmission") {
			t.Error("example data sent mail")
		}
	}

	// What the founder makes, inside an example folder or not, stays.
	var folder string
	s.r.QueryRow(`SELECT id FROM nodes WHERE org_id = ? AND kind = 'folder' AND name = 'Loom launch'`, org).Scan(&folder)
	var inFolder, loose Doc
	me.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "My plan", "folder": folder}, &inFolder)
	me.do("POST", "/api/docs", map[string]string{"kind": "sheet", "title": "My numbers"}, &loose)
	if inFolder.Folder != folder {
		t.Fatalf("could not file a document in the example folder: %+v", inFolder)
	}

	engine.reset()
	if code := me.do("DELETE", "/api/v1/admin/example-data", nil, nil); code != 200 {
		t.Fatalf("remove example data: %d", code)
	}
	docs = nil
	me.do("GET", "/api/docs", nil, &docs)
	if len(docs) != 2 || !slices.ContainsFunc(docs, func(d Doc) bool { return d.ID == inFolder.ID && d.Folder == "" }) {
		t.Errorf("documents after removal = %+v", docs)
	}
	var left struct{ People []Person }
	me.do("GET", "/api/admin/overview", nil, &left)
	if len(left.People) != 5 || slices.ContainsFunc(left.People, func(p Person) bool { return p.Example }) {
		t.Errorf("people after removal = %+v", left.People)
	}
	groups.Items = nil
	me.do("GET", "/api/v1/groups", nil, &groups)
	var n, nodes int
	s.r.QueryRow(`SELECT count(*) FROM example_items WHERE org_id = ?`, org).Scan(&n)
	s.r.QueryRow(`SELECT count(*) FROM nodes WHERE org_id = ?`, org).Scan(&nodes)
	if len(groups.Items) != 0 || n != 0 || nodes != 0 {
		t.Errorf("left behind: %d groups, %d records, %d files and folders", len(groups.Items), n, nodes)
	}
	if !slices.Contains(engine.methods, "Email/set") || !slices.Contains(engine.methods, "CalendarEvent/set") || !engine.users["ada@ritza.orgs.test"] {
		t.Errorf("the founder's example mail and events were not removed: %v %v", engine.methods, engine.users)
	}
	var after testBoot
	me.do("GET", "/api/boot", nil, &after)
	if after.Org.Example {
		t.Error("the organisation still says it has example data")
	}
	if code := me.do("DELETE", "/api/v1/admin/example-data", nil, nil); code != 404 {
		t.Errorf("removing it twice: %d", code)
	}
}

func TestPhotos(t *testing.T) {
	_, ts := newTestServer(t, nil)
	ann := newClient(t, ts)
	ann.signup("Acme", "ann")
	put := func(c *client, body []byte) int {
		req, _ := http.NewRequest("PUT", ts.URL+"/api/v1/me/photo", bytes.NewReader(body))
		res, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := put(ann, []byte("<svg onload=alert(1)>")); code != 400 {
		t.Errorf("a non-picture: %d", code)
	}
	if code := put(ann, demoAsset("ada.png")); code != 200 {
		t.Errorf("a picture: %d", code)
	}
	var people []Person
	var boot struct{ People []Person }
	ann.do("GET", "/api/boot", nil, &boot)
	people = boot.People
	if len(people) != 1 || people[0].Photo == 0 {
		t.Fatalf("people = %+v", people)
	}
	res, _ := ann.http.Get(ts.URL + "/api/v1/people/" + people[0].ID + "/photo")
	if res.StatusCode != 200 || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("get picture: %d", res.StatusCode)
	}
	res.Body.Close()
	// Another organisation cannot see it.
	bob := newClient(t, ts)
	bob.signup("Beta", "bob")
	if res, _ := bob.http.Get(ts.URL + "/api/v1/people/" + people[0].ID + "/photo"); res.StatusCode != 404 {
		t.Errorf("someone else's picture from another organisation: %d", res.StatusCode)
	}
	ann.do("DELETE", "/api/v1/me/photo", nil, nil)
	if res, _ := ann.http.Get(ts.URL + "/api/v1/people/" + people[0].ID + "/photo"); res.StatusCode != 404 {
		t.Errorf("a removed picture: %d", res.StatusCode)
	}
}
