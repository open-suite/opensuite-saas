package main

// API tokens. A token acts as the member who owns it, with that member's
// permissions, optionally limited to reading. People create their own in
// Your account; administrators create them for agents, which have no
// password and sign in no other way. Connected apps (OAuth, oauth.go) are
// tokens too, so one list shows everything that can act for someone, and
// revoking a connection is revoking its row.
//
// Only a SHA-256 hash of a secret is stored. Secrets are 32 random bytes, so
// a fast hash is the right one: there is nothing to brute-force.

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

const schemaTokens = `
CREATE TABLE IF NOT EXISTS api_tokens(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  read_only INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0,
  -- until: the secret in hash works until then (0: no limit). For a connected
  -- app that is its short-lived access token; expires is when the row itself
  -- goes (a token's expiry, or a connection's refresh token running out).
  until INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL DEFAULT 0,
  client_id TEXT NOT NULL DEFAULT '',
  refresh_hash TEXT NOT NULL DEFAULT '',
  resource TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS api_tokens_refresh ON api_tokens(refresh_hash) WHERE refresh_hash != '';
`

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		if err := ensureColumn(w, "users", "kind", "TEXT NOT NULL DEFAULT 'person'"); err != nil {
			return err
		}
		_, err := w.Exec(schemaTokens)
		return err
	})
}

const (
	tokenPrefix    = "os_"
	maxTokens      = 100 // per member
	tokenNameLimit = 80
)

// Grant is how a request was authorised when it did not come with the
// session cookie: which token, and whether it may change anything.
type Grant struct {
	ID       string
	ReadOnly bool
	Client   string // the connected app's client id, "" for a plain token
}

type Token struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Prefix   string `json:"prefix"`
	ReadOnly bool   `json:"readOnly"`
	Kind     string `json:"kind"` // token | connection
	Created  int64  `json:"created"`
	LastUsed int64  `json:"lastUsed"`
	Expires  int64  `json:"expires"`
	Secret   string `json:"secret,omitempty"` // only in the answer that created it
}

func newSecret() string { return tokenPrefix + newToken() }

// bearerUser resolves an Authorization header. It returns nil when the token
// is unknown, expired, revoked or its member is suspended.
func (s *Server) bearerUser(r *http.Request) (*User, *Grant) {
	secret, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found || !strings.HasPrefix(secret, tokenPrefix) {
		return nil, nil
	}
	g := &Grant{}
	var until, used int64
	u, err := scanUser(s.r.QueryRow(`SELECT `+userCols+`, t.id, t.read_only, t.client_id, t.until, t.last_used FROM api_tokens t
		JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND u.status = 'active'`, hashToken(strings.TrimSpace(secret))),
		&g.ID, &g.ReadOnly, &g.Client, &until, &used)
	if err != nil || (until != 0 && until < now()) {
		return nil, nil
	}
	if t := now(); t-used > 60 {
		s.w.Exec(`UPDATE api_tokens SET last_used = ? WHERE id = ?`, t, g.ID)
	}
	return u, g
}

func (s *Server) listTokens(userID string) []Token {
	out := []Token{}
	rows, err := s.r.Query(`SELECT t.id, t.name, t.prefix, t.read_only, t.client_id, t.created, t.last_used, t.expires
		FROM api_tokens t WHERE t.user_id = ? AND (t.expires = 0 OR t.expires > ?) ORDER BY t.created DESC`, userID, now())
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var t Token
		var client string
		rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.ReadOnly, &client, &t.Created, &t.LastUsed, &t.Expires)
		t.Kind = map[bool]string{true: "connection", false: "token"}[client != ""]
		out = append(out, t)
	}
	return out
}

// createToken makes a token for a member and returns it with its secret.
func (s *Server) createToken(userID, name string, readOnly bool, days int) (*Token, int, string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, 400, "Give the token a name, so you know later what uses it."
	}
	if len(name) > tokenNameLimit {
		name = name[:tokenNameLimit]
	}
	if days < 0 || days > 3650 {
		return nil, 400, "A token can last at most ten years."
	}
	var count int
	s.r.QueryRow(`SELECT count(*) FROM api_tokens WHERE user_id = ?`, userID).Scan(&count)
	if count >= maxTokens {
		return nil, 409, "That's the most tokens one member can have. Revoke one you no longer use."
	}
	secret := newSecret()
	t := &Token{ID: newID(12), Name: name, Prefix: secret[:len(tokenPrefix)+5], ReadOnly: readOnly, Kind: "token", Created: now(), Secret: secret}
	if days > 0 {
		t.Expires = t.Created + int64(days)*86400
	}
	if _, err := s.w.Exec(`INSERT INTO api_tokens(id, user_id, name, prefix, hash, read_only, created, until, expires) VALUES(?,?,?,?,?,?,?,?,?)`,
		t.ID, userID, t.Name, t.Prefix, hashToken(secret), readOnly, t.Created, t.Expires, t.Expires); err != nil {
		return nil, 500, "storage error"
	}
	return t, 0, ""
}

func (s *Server) revokeToken(w http.ResponseWriter, userID, id string) {
	res, err := s.w.Exec(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 404, "No such token.")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

type tokenRequest struct {
	Name          string
	ReadOnly      bool
	ExpiresInDays int
}

func (s *Server) issueToken(w http.ResponseWriter, r *http.Request, userID string) {
	var in tokenRequest
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	t, code, msg := s.createToken(userID, in.Name, in.ReadOnly, in.ExpiresInDays)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	ok(w, t)
}

func (s *Server) handleTokenList(w http.ResponseWriter, r *http.Request, u *User) {
	ok(w, map[string]any{"items": s.listTokens(u.ID)})
}

func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request, u *User) {
	s.issueToken(w, r, u.ID)
}

func (s *Server) handleTokenRevoke(w http.ResponseWriter, r *http.Request, u *User) {
	s.revokeToken(w, u.ID, r.PathValue("id"))
}

// agentOf finds an agent in the administrator's organisation. People manage
// their own tokens; nobody else, administrators included, ever holds one.
func (s *Server) agentOf(w http.ResponseWriter, r *http.Request, u *User) *User {
	t := s.userByID(r.PathValue("id"))
	if t == nil || t.OrgID != u.OrgID {
		fail(w, 404, "No such person.")
		return nil
	}
	if !t.isAgent() {
		fail(w, 409, "Only agents' tokens are managed here. People create their own in Your account.")
		return nil
	}
	return t
}

func (s *Server) handleAgentTokenList(w http.ResponseWriter, r *http.Request, u *User) {
	if t := s.agentOf(w, r, u); t != nil {
		ok(w, map[string]any{"items": s.listTokens(t.ID)})
	}
}

func (s *Server) handleAgentTokenCreate(w http.ResponseWriter, r *http.Request, u *User) {
	if t := s.agentOf(w, r, u); t != nil {
		s.issueToken(w, r, t.ID)
	}
}

func (s *Server) handleAgentTokenRevoke(w http.ResponseWriter, r *http.Request, u *User) {
	if t := s.agentOf(w, r, u); t != nil {
		s.revokeToken(w, t.ID, r.PathValue("token"))
	}
}

// tokensJanitor drops tokens and connections whose time is up.
func (s *Server) tokensJanitor() {
	s.w.Exec(`DELETE FROM api_tokens WHERE expires > 0 AND expires < ?`, now())
	s.w.Exec(`DELETE FROM oauth_codes WHERE expires < ?`, now())
}

// Abuse protection only. A token, or a signed-in member using the API, may
// make this many calls a minute; a normal agent never comes near it.
var apiCallsPerMinute = 1200

func (s *Server) apiAllowed(w http.ResponseWriter, key string) bool {
	if s.lim.allow("api:"+key, apiCallsPerMinute, time.Minute) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	fail(w, 429, "Too many requests. Wait a minute and try again.")
	return false
}
