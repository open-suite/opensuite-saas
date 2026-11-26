package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// A free organisation can mail anyone hosted here but nobody outside, and
// cannot get round the check by sending a message stored earlier or by
// changing recipients in the same request. A team organisation can. On any
// plan a message is from the address of the mailbox that sends it.
func TestFreePlanMailStaysInside(t *testing.T) {
	var forwarded atomic.Int32
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// An uploaded message, read back to check who it is from.
		if blob, found := strings.CutPrefix(r.URL.Path, "/jmap/download/"); found {
			from := map[bool]string{true: "Alice <alice@office.test>", false: "Bob <bob@office.test>"}[strings.Contains(blob, "/B/")]
			w.Write([]byte("From: " + from + "\r\nSubject: Invitation\r\n\r\nHello\r\n"))
			return
		}
		forwarded.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"methodResponses":[]}`))
	}))
	defer engine.Close()
	s, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	s.cfg.MailURL = engine.URL
	s.w.Exec(`UPDATE users SET mail_ready = 1, mail_id = id`)
	s.w.Exec(`INSERT INTO domains (domain, org_id, mail_ok, created) SELECT 'alpha.example', org_id, 1, 0 FROM users`)

	message := func(from, to string) []any {
		return []any{"Email/set", map[string]any{"create": map[string]any{"m": map[string]any{
			"from": []map[string]string{{"email": from}}, "to": []map[string]string{{"email": to}}}}}, "0"}
	}
	send := func(to string, extra ...[]any) []any {
		calls := []any{
			message("alice@office.test", to),
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"identityId": "i", "emailId": "#m"}}}, "1"},
		}
		for _, e := range extra {
			calls = append(calls, e)
		}
		return calls
	}
	invite := func(to string, envelope bool, blob string) []any {
		sub := map[string]any{"identityId": "i", "emailId": "#m"}
		if envelope {
			sub["envelope"] = map[string]any{"mailFrom": map[string]string{"email": "alice@office.test"}, "rcptTo": []map[string]string{{"email": to}}}
		}
		return []any{
			[]any{"Email/import", map[string]any{"emails": map[string]any{"m": map[string]any{"blobId": blob}}}, "0"},
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": sub}}, "1"},
		}
	}
	cases := []struct {
		name  string
		calls []any
		want  int
	}{
		{"colleague", send("bob@office.test"), 200},
		{"custom domain hosted here", send("eve@Alpha.Example"), 200},
		{"outside", send("someone@gmail.com"), 403},
		{"outside in the envelope", []any{
			message("alice@office.test", "bob@office.test"),
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"emailId": "#m", "envelope": map[string]any{"rcptTo": []map[string]string{{"email": "x@gmail.com"}}}}}}, "1"},
		}, 403},
		{"stored message", []any{
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"emailId": "M123"}}}, "0"},
		}, 403},
		{"recipients changed", send("bob@office.test", []any{"Email/set", map[string]any{"update": map[string]any{"#m": map[string]any{"to": []map[string]string{{"email": "x@gmail.com"}}}}}, "2"}), 403},
		{"invitation to a colleague", invite("bob@office.test", true, "B"), 200},
		{"invitation outside", invite("x@gmail.com", true, "B"), 403},
		{"invitation without an envelope", invite("bob@office.test", false, "B"), 403},
		{"same id set and imported", append(send("bob@office.test"), []any{"Email/import", map[string]any{"emails": map[string]any{"m": map[string]any{"blobId": "B"}}}, "2"}), 403},
		{"no sending", []any{[]any{"Mailbox/get", map[string]any{}, "0"}}, 200},
		// Whatever the plan, a message goes out under the sender's own address.
		{"from a colleague's address", []any{message("bob@office.test", "bob@office.test"), send("")[1]}, 403},
		{"invitation from a colleague's address", invite("bob@office.test", true, "C"), 403},
	}
	for _, c := range cases {
		before := forwarded.Load()
		code := a.do("POST", "/api/mail/jmap", map[string]any{"methodCalls": c.calls}, nil)
		if code != c.want {
			t.Errorf("%s: %d, want %d", c.name, code, c.want)
		}
		if c.want == 403 && forwarded.Load() != before {
			t.Errorf("%s: reached the mail engine", c.name)
		}
	}

	s.w.Exec(`UPDATE orgs SET plan = 'team'`)
	if code := a.do("POST", "/api/mail/jmap", map[string]any{"methodCalls": send("someone@gmail.com")}, nil); code != 200 {
		t.Errorf("team plan outside: %d, want 200", code)
	}
}
