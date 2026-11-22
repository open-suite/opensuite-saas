package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// The browser reaches calendars and contacts through the mail endpoint; the
// same pinning applies, sharing across accounts is refused, and the engine is
// never asked to send its own invitations.
func TestCalendarProxyRules(t *testing.T) {
	var seen struct {
		Using       []string
		MethodCalls [][]json.RawMessage
	}
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"methodResponses":[]}`))
	}))
	defer engine.Close()
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	s.cfg.MailURL = engine.URL
	s.w.Exec(`UPDATE users SET mail_ready = 1, mail_id = 'mine'`)
	call := func(method string, args map[string]any) int {
		return a.do("POST", "/api/mail/jmap", map[string]any{"methodCalls": [][]any{{method, args, "0"}}}, nil)
	}

	if code := call("CalendarEvent/set", map[string]any{"accountId": "other", "sendSchedulingMessages": true, "create": map[string]any{"e": map[string]any{"title": "Lunch"}}}); code != 200 {
		t.Fatalf("event create: %d", code)
	}
	var args map[string]any
	json.Unmarshal(seen.MethodCalls[0][1], &args)
	if args["accountId"] != "mine" {
		t.Errorf("accountId forwarded as %v", args["accountId"])
	}
	if _, has := args["sendSchedulingMessages"]; has {
		t.Error("the engine was asked to send its own invitation")
	}
	hasCal := false
	for _, u := range seen.Using {
		hasCal = hasCal || u == "urn:ietf:params:jmap:calendars"
	}
	if !hasCal {
		t.Error("calendar capability not requested")
	}

	for _, m := range []string{"Calendar/get", "CalendarEvent/query", "CalendarEvent/parse", "AddressBook/get", "ContactCard/set", "ContactCard/get"} {
		if code := call(m, map[string]any{}); code != 200 {
			t.Errorf("%s: %d, want 200", m, code)
		}
	}
	// A note that merely mentions the word is fine; the property is not.
	if code := call("ContactCard/set", map[string]any{"create": map[string]any{"c": map[string]any{"notes": map[string]any{"n": map[string]any{"note": "shareWith"}}}}}); code != 200 {
		t.Errorf("contact with an innocent note: %d", code)
	}
	refused := []struct {
		method string
		args   map[string]any
	}{
		{"Calendar/set", map[string]any{"update": map[string]any{"b": map[string]any{"shareWith": map[string]any{"zz": map[string]any{"mayReadItems": true}}}}}},
		{"Calendar/set", map[string]any{"update": map[string]any{"b": map[string]any{"shareWith/zz": map[string]any{"mayReadItems": true}}}}},
		{"AddressBook/set", map[string]any{"create": map[string]any{"n": map[string]any{"name": "x", "shareWith": map[string]any{"zz": map[string]any{"mayRead": true}}}}}},
		{"Principal/get", map[string]any{}},
		{"Principal/query", map[string]any{}},
		{"Principal/getAvailability", map[string]any{"id": "zz"}},
		{"ParticipantIdentity/set", map[string]any{}},
		{"ShareNotification/get", map[string]any{}},
		{"FileNode/get", map[string]any{}},
	}
	for _, c := range refused {
		if code := call(c.method, c.args); code != 403 {
			t.Errorf("%s %v: %d, want 403", c.method, c.args, code)
		}
	}
}

// Free/busy only ever covers the caller's own organisation, asks the engine
// as the colleague concerned, and returns times without any event details.
func TestFreeBusyStaysInsideOrganisation(t *testing.T) {
	var mu sync.Mutex
	asked := map[string]int{}
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, _, _ := r.BasicAuth()
		mu.Lock()
		asked[who]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"methodResponses":[["Principal/getAvailability",{"list":[
			{"utcStart":"2026-11-23T08:00:00Z","utcEnd":"2026-11-23T08:30:00Z","busyStatus":"confirmed","event":{"title":"Secret"}},
			{"utcStart":"2026-11-24T08:00:00Z","utcEnd":"2026-11-24T09:00:00Z","busyStatus":"tentative","event":null},
			{"utcStart":"2026-11-25T08:00:00Z","utcEnd":"2026-11-25T09:00:00Z","busyStatus":"free","event":null}]},"0"]]}`))
	}))
	defer engine.Close()
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var made struct{ ID string }
	if code := a.do("POST", "/api/admin/users", map[string]string{"name": "Bob Builder", "username": "bob", "role": "member"}, &made); code != 200 {
		t.Fatalf("add colleague: %d", code)
	}
	z := newClient(t, ts)
	z.signup("Zeta", "zoe")
	s.cfg.MailURL = engine.URL
	s.w.Exec(`UPDATE users SET mail_ready = 1, mail_id = id`)
	var zoe string
	s.r.QueryRow(`SELECT id FROM users WHERE email = 'zoe@office.test'`).Scan(&zoe)

	var out struct {
		Busy map[string][]map[string]any
	}
	body := map[string]any{"people": []string{made.ID, zoe, "nobody"}, "from": "2026-11-22T00:00:00Z", "to": "2026-11-29T00:00:00Z"}
	if code := a.do("POST", "/api/calendar/freebusy", body, &out); code != 200 {
		t.Fatalf("freebusy: %d", code)
	}
	if len(out.Busy) != 1 || len(out.Busy[made.ID]) != 2 {
		t.Fatalf("busy = %v, want two periods for the colleague only", out.Busy)
	}
	for _, p := range out.Busy[made.ID] {
		for k := range p {
			if k != "s" && k != "e" && k != "t" {
				t.Errorf("free/busy leaked %q", k)
			}
		}
	}
	first, _ := time.Parse(time.RFC3339, "2026-11-23T08:00:00Z")
	if out.Busy[made.ID][0]["s"].(float64) != float64(first.UnixMilli()) || out.Busy[made.ID][1]["t"] != true {
		t.Errorf("periods = %v", out.Busy[made.ID])
	}
	if asked["zoe@office.test"] != 0 || asked["bob@office.test"] != 1 {
		t.Errorf("engine asked as %v, want only the colleague", asked)
	}
	// Someone in another organisation gets nothing about Alpha's people.
	out.Busy = nil
	body["people"] = []string{made.ID}
	if code := z.do("POST", "/api/calendar/freebusy", body, &out); code != 200 || len(out.Busy) != 0 {
		t.Errorf("cross-organisation free/busy: %d %v", code, out.Busy)
	}
	// Unbounded ranges and anonymous callers are refused.
	body["to"] = "2028-01-01T00:00:00Z"
	if code := a.do("POST", "/api/calendar/freebusy", body, nil); code != 400 {
		t.Errorf("year-long range: %d, want 400", code)
	}
	if code := newClient(t, ts).do("POST", "/api/calendar/freebusy", body, nil); code != 401 {
		t.Errorf("anonymous: %d, want 401", code)
	}
}
