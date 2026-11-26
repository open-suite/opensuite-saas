package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func newTestServer(t *testing.T, tweak func(*Config)) (*Server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	cfg := Config{
		Domain: "office.test", MailDomain: "office.test", MailHost: "office.test", MatrixName: "office.test",
		DataDir: dir, WebDir: dir, CertDir: dir, Secret: []byte(strings.Repeat("s", 40)), Signup: "open",
		LiveKitKey: "key", LiveKitSecret: "secret",
	}
	if tweak != nil {
		tweak(&cfg)
	}
	w, r, err := openDB(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: cfg, w: w, r: r, lim: newLimiter(), http: &http.Client{Timeout: 5 * time.Second}}
	s.hub = newHub(s)
	s.tls = newCertManager(s)
	s.engine = newContentEngine(cfg)
	ts := httptest.NewServer(s.routes())
	t.Cleanup(func() { ts.Close(); w.Close(); r.Close() })
	return s, ts
}

type client struct {
	t    *testing.T
	base string
	http *http.Client
}

func newClient(t *testing.T, ts *httptest.Server) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t, ts.URL, &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any, out any) int {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if out != nil {
		json.Unmarshal(b, out)
	}
	return res.StatusCode
}

func (c *client) signup(org, username string) {
	c.t.Helper()
	if code := c.do("POST", "/api/signup", map[string]string{"org": org, "name": strings.ToUpper(username[:1]) + username[1:], "username": username, "password": "a-long-password"}, nil); code != 200 {
		c.t.Fatalf("signup %s: %d", username, code)
	}
}

func TestSmallHelpers(t *testing.T) {
	for _, v := range []uint64{0, 1, 127, 128, 300, 1 << 40} {
		got, n := readVarint(varint(nil, v))
		if got != v || n == 0 {
			t.Errorf("varint round trip %d -> %d", v, got)
		}
	}
	if !sameHost("https://office.test", "office.test") || sameHost("https://evil.test", "office.test") {
		t.Error("sameHost")
	}
	for name, ok := range map[string]bool{"jane": true, "j.doe-2": true, "ab": false, "admin": false, "Jane": false, ".jane": false, "jane@x": false} {
		if (validUsername(name) == "") != ok {
			t.Errorf("validUsername(%q) = %v, want %v", name, !ok, ok)
		}
	}
	h := hashPassword("correct horse")
	if !checkPassword(h, "correct horse") || !checkPassword(h, " correct horse\n") || checkPassword(h, "wrong") {
		t.Error("password hashing")
	}
}

func TestDkimFromZone(t *testing.T) {
	zone := "v1-ed._domainkey.example.com. IN TXT \"v=DKIM1; k=ed25519; p=AAA\"\n" +
		"v1-rsa._domainkey.example.com. IN TXT (\n    \"v=DKIM1; k=rsa; p=BBB\"\n    \"CCC\"\n)\n" +
		"example.com. IN TXT \"v=spf1 mx -all\"\n"
	want := "v1-ed._domainkey.example.com\tv=DKIM1; k=ed25519; p=AAA\nv1-rsa._domainkey.example.com\tv=DKIM1; k=rsa; p=BBBCCC"
	if got := dkimFromZone(zone); got != want {
		t.Errorf("got %q", got)
	}
}

// One organisation must never reach another's documents, people or admin.
func TestTenantIsolation(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a, b := newClient(t, ts), newClient(t, ts)
	a.signup("Alpha", "alice")
	b.signup("Beta", "bob")

	var doc Doc
	if code := a.do("POST", "/api/docs", map[string]string{"kind": "doc", "title": "Secret plan"}, &doc); code != 200 {
		t.Fatalf("create doc: %d", code)
	}
	a.do("PATCH", "/api/docs/"+doc.ID, map[string]string{"access": "org"}, nil)

	var listed []Doc
	b.do("GET", "/api/docs", nil, &listed)
	if len(listed) != 0 {
		t.Errorf("other organisation can list %d documents", len(listed))
	}
	for _, probe := range [][2]string{{"GET", "/api/docs/" + doc.ID + "/state"}, {"GET", "/api/docs/" + doc.ID + "/sync"}, {"PATCH", "/api/docs/" + doc.ID}, {"DELETE", "/api/docs/" + doc.ID}} {
		if code := b.do(probe[0], probe[1], map[string]string{"title": "x"}, nil); code != 403 {
			t.Errorf("%s %s from another organisation: %d, want 403", probe[0], probe[1], code)
		}
	}
	var boot struct {
		People []Person `json:"people"`
	}
	b.do("GET", "/api/boot", nil, &boot)
	if len(boot.People) != 1 || boot.People[0].Email != "bob@office.test" {
		t.Errorf("people leaked across organisations: %+v", boot.People)
	}

	// A member cannot use the admin API; an admin cannot touch another org's user.
	var made struct{ ID, Password string }
	if code := a.do("POST", "/api/admin/users", map[string]string{"name": "Carol", "username": "carol"}, &made); code != 200 {
		t.Fatalf("add user: %d", code)
	}
	carol := newClient(t, ts)
	if code := carol.do("POST", "/api/login", map[string]string{"email": "carol", "password": made.Password}, nil); code != 200 {
		t.Fatalf("login with temporary password: %d", code)
	}
	if code := carol.do("GET", "/api/admin/overview", nil, nil); code != 403 {
		t.Errorf("member reached admin API: %d", code)
	}
	if code := b.do("DELETE", "/api/admin/users/"+made.ID, nil, nil); code != 404 {
		t.Errorf("admin of another organisation deleting a user: %d, want 404", code)
	}
	// The only owner cannot be demoted or removed.
	var me struct {
		User struct{ ID string } `json:"user"`
	}
	a.do("GET", "/api/boot", nil, &me)
	if code := a.do("PATCH", "/api/admin/users/"+me.User.ID, map[string]string{"role": "member"}, nil); code != 409 {
		t.Errorf("demoting the last owner: %d, want 409", code)
	}
	// Cross-site writes are refused outright.
	req, _ := http.NewRequest("POST", ts.URL+"/api/logout", nil)
	req.Header.Set("Origin", "https://evil.example")
	res, _ := a.http.Do(req)
	if res.StatusCode != 403 {
		t.Errorf("cross-site POST: %d, want 403", res.StatusCode)
	}
}

func TestFreePlanLimit(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	for i, name := range []string{"bob", "carol", "dave", "erin", "frank"} {
		code := a.do("POST", "/api/admin/users", map[string]string{"name": name, "username": name}, nil)
		if want := map[bool]int{true: 200, false: 402}[i < 4]; code != want {
			t.Errorf("adding person %d: %d, want %d", i+2, code, want)
		}
	}
}

func dial(t *testing.T, c *client, path string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(c.base, "http", "ws", 1)+path, &websocket.DialOptions{HTTPClient: c.http})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

// next reads until a message of the wanted type arrives.
func next(t *testing.T, conn *websocket.Conn, typ byte) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for message type %d: %v", typ, err)
		}
		if msg[0] == typ {
			return msg[1:]
		}
	}
}

func send(t *testing.T, conn *websocket.Conn, msg []byte) {
	t.Helper()
	if err := conn.Write(context.Background(), websocket.MessageBinary, msg); err != nil {
		t.Fatal(err)
	}
}

// The sync protocol: ordered sequence numbers, fan-out, acknowledgement,
// idempotent resend, resume from a sequence, and snapshot compaction.
func TestDocSync(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var doc Doc
	a.do("POST", "/api/docs", map[string]string{"kind": "sheet"}, &doc)
	path := "/api/docs/" + doc.ID + "/sync"

	c1, c2 := dial(t, a, path), dial(t, a, path)
	next(t, c1, msgSynced)
	next(t, c2, msgSynced)

	op := []byte("opid-001hello")
	send(t, c1, append([]byte{msgUpdate}, op...))
	if ack := next(t, c1, msgAck); ack[0] != 1 || string(ack[1:]) != "opid-001" {
		t.Errorf("ack = %v", ack)
	}
	if got := next(t, c2, msgUpdate); got[0] != 1 || string(got[1:]) != string(op) {
		t.Errorf("fan-out = %q", got)
	}
	// Resending the same operation is acknowledged, not stored twice.
	send(t, c1, append([]byte{msgUpdate}, op...))
	if ack := next(t, c1, msgAck); ack[0] != 1 {
		t.Errorf("duplicate got sequence %d, want 1", ack[0])
	}
	send(t, c2, append([]byte{msgUpdate}, []byte("opid-002world")...))
	next(t, c2, msgAck)

	// A client that already has sequence 1 receives only what follows.
	c3 := dial(t, a, path+"?since=1")
	if got := next(t, c3, msgUpdate); got[0] != 2 || string(got[1:]) != "opid-002world" {
		t.Errorf("resume = %q", got)
	}
	if synced := next(t, c3, msgSynced); synced[0] != 2 {
		t.Errorf("synced at %d, want 2", synced[0])
	}

	// A snapshot covering sequence 2 replaces the log for new arrivals.
	send(t, c1, append([]byte{msgSnapshot, 2}, []byte("STATE")...))
	time.Sleep(100 * time.Millisecond)
	c4 := dial(t, a, path)
	if base := next(t, c4, msgBase); base[0] != 2 || string(base[1:]) != "STATE" {
		t.Errorf("base = %q", base)
	}
	if synced := next(t, c4, msgSynced); synced[0] != 2 {
		t.Errorf("synced at %d after snapshot, want 2", synced[0])
	}

	// The one-request form returns the same thing.
	res, _ := a.http.Get(a.base + "/api/docs/" + doc.ID + "/state")
	body, _ := io.ReadAll(res.Body)
	if !bytes.Contains(body, []byte("STATE")) || bytes.Contains(body, []byte("hello")) {
		t.Errorf("state = %q", body)
	}
}

// The mail endpoint must pin every call to the caller's own mailbox and keep
// the engine's management methods out of reach.
func TestMailProxyPinsAccount(t *testing.T) {
	var seen struct {
		Using       []string
		MethodCalls [][]json.RawMessage
	}
	var auth string
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, _, _ = r.BasicAuth()
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
		return a.do("POST", "/api/mail/jmap", map[string]any{"using": []string{"urn:stalwart:jmap"}, "methodCalls": [][]any{{method, args, "0"}}}, nil)
	}
	if code := call("Email/get", map[string]any{"accountId": "someone-else", "ids": []string{"x"}}); code != 200 {
		t.Fatalf("mail call: %d", code)
	}
	var args map[string]any
	json.Unmarshal(seen.MethodCalls[0][1], &args)
	if args["accountId"] != "mine" {
		t.Errorf("accountId forwarded as %v, want the caller's own", args["accountId"])
	}
	if auth != "alice@office.test" {
		t.Errorf("engine authenticated as %q", auth)
	}
	for _, u := range seen.Using {
		if strings.Contains(u, "stalwart") {
			t.Errorf("management capability forwarded: %s", u)
		}
	}
	for _, method := range []string{"x:Account/set", "x:Domain/get", "Principal/get", "SieveScript/set"} {
		if code := call(method, map[string]any{}); code != 403 {
			t.Errorf("%s: %d, want 403", method, code)
		}
	}
}

func TestMeetingTokens(t *testing.T) {
	_, ts := newTestServer(t, nil)
	a := newClient(t, ts)
	a.signup("Alpha", "alice")
	var m Meeting
	a.do("POST", "/api/meet", map[string]string{"title": "Sync"}, &m)
	if !meetCodeRe.MatchString(m.Code) {
		t.Fatalf("code %q", m.Code)
	}
	guest := newClient(t, ts)
	var joined struct {
		Token, Identity string
		Host            bool
	}
	if code := guest.do("POST", "/api/meet/"+m.Code+"/join", map[string]string{"name": ""}, nil); code != 400 {
		t.Errorf("guest without a name: %d, want 400", code)
	}
	if code := guest.do("POST", "/api/meet/"+m.Code+"/join", map[string]string{"name": "Guest"}, &joined); code != 200 {
		t.Fatalf("guest join: %d", code)
	}
	if joined.Host || !strings.HasPrefix(joined.Identity, "guest-") || strings.Count(joined.Token, ".") != 2 {
		t.Errorf("guest join = %+v", joined)
	}
	a.do("POST", "/api/meet/"+m.Code+"/join", map[string]string{}, &joined)
	if !joined.Host {
		t.Error("the room's owner should be host")
	}
	if code := guest.do("POST", "/api/meet/zzz-zzzz-zzz/join", map[string]string{"name": "Guest"}, nil); code != 404 {
		t.Errorf("unknown room: %d, want 404", code)
	}
}
