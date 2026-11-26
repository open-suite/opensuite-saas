package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// A free organisation can mail anyone hosted here but nobody outside, and
// cannot get round the check by sending a message stored earlier or by
// changing recipients in the same request. A team organisation can.
func TestFreePlanMailStaysInside(t *testing.T) {
	var forwarded atomic.Int32
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	send := func(to string, extra ...[]any) []any {
		calls := []any{
			[]any{"Email/set", map[string]any{"create": map[string]any{"m": map[string]any{"to": []map[string]string{{"email": to}}}}}, "0"},
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"identityId": "i", "emailId": "#m"}}}, "1"},
		}
		for _, e := range extra {
			calls = append(calls, e)
		}
		return calls
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
			[]any{"Email/set", map[string]any{"create": map[string]any{"m": map[string]any{"to": []map[string]string{{"email": "bob@office.test"}}}}}, "0"},
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"emailId": "#m", "envelope": map[string]any{"rcptTo": []map[string]string{{"email": "x@gmail.com"}}}}}}, "1"},
		}, 403},
		{"stored message", []any{
			[]any{"EmailSubmission/set", map[string]any{"create": map[string]any{"s": map[string]any{"emailId": "M123"}}}, "0"},
		}, 403},
		{"recipients changed", send("bob@office.test", []any{"Email/set", map[string]any{"update": map[string]any{"#m": map[string]any{"to": []map[string]string{{"email": "x@gmail.com"}}}}}, "2"}), 403},
		{"no sending", []any{[]any{"Mailbox/get", map[string]any{}, "0"}}, 200},
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
