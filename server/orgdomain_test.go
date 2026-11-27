package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

type testBoot struct {
	User struct{ ID, Email string } `json:"user"`
	Org  struct {
		ID          string
		MailDomains []string
	} `json:"org"`
	People []Person `json:"people"`
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

// Without the suffix, sign-up is as before.
func TestNoOrgDomain(t *testing.T) {
	_, ts := newTestServer(t, nil)
	var boot testBoot
	if code := newClient(t, ts).do("POST", "/api/signup", map[string]string{"org": "Acme", "name": "Ann", "username": "ann", "password": "a-long-password"}, &boot); code != 200 || boot.User.Email != "ann@office.test" {
		t.Errorf("signup: %d %s", code, boot.User.Email)
	}
	if code := newClient(t, ts).do("GET", "/api/signup/check?slug=beta", nil, nil); code != 404 {
		t.Errorf("slug check without own domains: %d", code)
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
