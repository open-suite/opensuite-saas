package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

type User struct {
	ID, OrgID, Email, Name, Role, Status string
	MxLocal, MxToken, MailSecret, MailID string
	MustChange, MailReady               bool
}

func (u *User) isAdmin() bool { return u.Role == "owner" || u.Role == "admin" }

type Plan struct {
	Label     string `json:"label"`
	MaxUsers  int    `json:"maxUsers"`
	StorageGB int    `json:"storageGB"`
	Domains   int    `json:"domains"`
}

var plans = map[string]Plan{
	"free": {"Free", 5, 5, 1},
	"team": {"Team", 250, 250, 10},
}

func planFor(name string) Plan {
	if p, found := plans[name]; found {
		return p
	}
	return plans["free"]
}

const sessionCookie = "os_s"
const sessionTTL = 30 * 86400

var usernameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`)

var reservedNames = []string{"admin", "administrator", "postmaster", "abuse", "root", "support", "noreply", "no-reply",
	"hostmaster", "webmaster", "mailer-daemon", "security", "opensuite", "billing", "help", "info", "system"}

const userCols = `u.id, u.org_id, u.email, u.name, u.role, u.status, u.mx_local, u.mx_token, u.mail_secret, u.must_change, u.mail_ready, u.mail_id`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.OrgID, &u.Email, &u.Name, &u.Role, &u.Status, &u.MxLocal, &u.MxToken, &u.MailSecret, &u.MustChange, &u.MailReady, &u.MailID)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func (s *Server) sessionUser(r *http.Request) *User {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	u, err := scanUser(s.r.QueryRow(`SELECT `+userCols+` FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = ? AND s.expires > ? AND u.status = 'active'`, hashToken(c.Value), now()))
	if err != nil {
		return nil
	}
	return u
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID string) {
	tok := newToken()
	s.w.Exec(`INSERT INTO sessions(id, user_id, created, expires) VALUES(?,?,?,?)`, hashToken(tok), userID, now(), now()+sessionTTL)
	s.w.Exec(`UPDATE users SET last_seen = ? WHERE id = ?`, now(), userID)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: tok, Path: "/", MaxAge: sessionTTL,
		HttpOnly: true, Secure: r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteLaxMode,
	})
}

type authed func(http.ResponseWriter, *http.Request, *User)

func (s *Server) auth(h authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := s.sessionUser(r)
		if u == nil {
			fail(w, 401, "signed out")
			return
		}
		h(w, r, u)
	}
}

func (s *Server) admin(h authed) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request, u *User) {
		if !u.isAdmin() {
			fail(w, 403, "administrators only")
			return
		}
		h(w, r, u)
	})
}

func (s *Server) isOperator(u *User) bool {
	return slices.Contains(s.cfg.Operators, strings.ToLower(u.Email))
}

func (s *Server) operator(h authed) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request, u *User) {
		if !s.isOperator(u) {
			fail(w, 403, "operators only")
			return
		}
		h(w, r, u)
	})
}

// normalizeLogin turns "jane" into "jane@<default mail domain>".
func (s *Server) normalizeLogin(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if v != "" && !strings.Contains(v, "@") {
		v += "@" + s.cfg.MailDomain
	}
	return v
}

func (s *Server) addressTaken(email string) bool {
	var n int
	s.r.QueryRow(`SELECT count(*) FROM users WHERE email = ?`, email).Scan(&n)
	return n > 0
}

func validUsername(name string) string {
	if !usernameRe.MatchString(name) {
		return "Use 3 to 32 letters, digits, dots or dashes."
	}
	if slices.Contains(reservedNames, name) {
		return "That address is reserved."
	}
	return ""
}

func (s *Server) handleSignupCheck(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.URL.Query().Get("username"))
	if msg := validUsername(name); msg != "" {
		ok(w, map[string]any{"available": false, "reason": msg})
		return
	}
	taken := s.addressTaken(name + "@" + s.cfg.MailDomain)
	ok(w, map[string]any{"available": !taken, "reason": map[bool]string{true: "That address is taken.", false: ""}[taken]})
}

func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) {
	var in struct{ Org, Name, Username, Password, Code string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	switch s.cfg.Signup {
	case "closed":
		fail(w, 403, "Sign-up is closed on this server.")
		return
	case "code":
		if in.Code == "" || in.Code != s.cfg.SignupCode {
			fail(w, 403, "That invitation code is not valid.")
			return
		}
	}
	if !s.lim.allow("signup:"+clientIP(r), 5, time.Hour) {
		fail(w, 429, "Too many sign-ups from this network. Try again later.")
		return
	}
	in.Org, in.Name, in.Username = strings.TrimSpace(in.Org), strings.TrimSpace(in.Name), strings.ToLower(strings.TrimSpace(in.Username))
	if in.Org == "" || in.Name == "" {
		fail(w, 400, "Enter your name and your organisation's name.")
		return
	}
	if msg := validUsername(in.Username); msg != "" {
		fail(w, 400, msg)
		return
	}
	if len(cleanPassword(in.Password)) < 10 {
		fail(w, 400, "Choose a password of at least 10 characters.")
		return
	}
	email := in.Username + "@" + s.cfg.MailDomain
	orgID, userID := newID(10), newID(12)
	tx, err := s.w.Begin()
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	defer tx.Rollback()
	tx.Exec(`INSERT INTO orgs(id, name, created) VALUES(?,?,?)`, orgID, in.Org, now())
	_, err = tx.Exec(`INSERT INTO users(id, org_id, email, name, role, pw_hash, mx_local, mail_secret, created) VALUES(?,?,?,?,?,?,?,?,?)`,
		userID, orgID, email, in.Name, "owner", hashPassword(in.Password), s.mxLocalFor(email), newToken(), now())
	if err != nil {
		fail(w, 409, "That address is taken.")
		return
	}
	if tx.Commit() != nil {
		fail(w, 500, "storage error")
		return
	}
	s.startSession(w, r, userID)
	u := s.userByID(userID)
	s.provision(u)
	ok(w, s.boot(s.userByID(userID)))
}

func (s *Server) userByID(id string) *User {
	u, _ := scanUser(s.r.QueryRow(`SELECT `+userCols+` FROM users u WHERE u.id = ?`, id))
	return u
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email, Password string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	email := s.normalizeLogin(in.Email)
	if !s.lim.allow("login:"+clientIP(r)+":"+email, 10, 5*time.Minute) {
		fail(w, 429, "Too many attempts. Wait a few minutes and try again.")
		return
	}
	var id, hash, status string
	err := s.r.QueryRow(`SELECT id, pw_hash, status FROM users WHERE email = ?`, email).Scan(&id, &hash, &status)
	if err == sql.ErrNoRows {
		hashPassword(in.Password) // keep timing uniform
	}
	if err != nil || !checkPassword(hash, in.Password) {
		// The operator's log says which half was wrong; the person signing in
		// is never told, so addresses cannot be probed.
		reason := "wrong password"
		if err != nil {
			reason = "no such address"
		}
		log.Printf("auth: sign-in refused for %q: %s", email, reason)
		fail(w, 401, "That address and password don't match.")
		return
	}
	if status != "active" {
		fail(w, 403, "This account is suspended. Ask your administrator.")
		return
	}
	s.startSession(w, r, id)
	u := s.userByID(id)
	s.provision(u)
	ok(w, s.boot(s.userByID(id)))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.w.Exec(`DELETE FROM sessions WHERE id = ?`, hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleSetPassword(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Current, Password string }
	if readJSON(r, &in) != nil || len(cleanPassword(in.Password)) < 10 {
		fail(w, 400, "Choose a password of at least 10 characters.")
		return
	}
	var hash string
	s.r.QueryRow(`SELECT pw_hash FROM users WHERE id = ?`, u.ID).Scan(&hash)
	if !u.MustChange && !checkPassword(hash, in.Current) {
		fail(w, 403, "Your current password is not correct.")
		return
	}
	s.w.Exec(`UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?`, hashPassword(in.Password), u.ID)
	// Sign out every other browser.
	keep := ""
	if c, err := r.Cookie(sessionCookie); err == nil {
		keep = hashToken(c.Value)
	}
	s.w.Exec(`DELETE FROM sessions WHERE user_id = ? AND id != ?`, u.ID, keep)
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleSetProfile(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Name string }
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
		fail(w, 400, "Enter a name.")
		return
	}
	name := strings.TrimSpace(in.Name)
	s.w.Exec(`UPDATE users SET name = ? WHERE id = ?`, name, u.ID)
	u.Name = name
	go s.chatSetName(u)
	ok(w, map[string]bool{"ok": true})
}

// boot is everything the app shell needs to paint, in one object. It is
// inlined into the first HTML response and cached by the client, so no view
// starts with a request.
func (s *Server) boot(u *User) map[string]any {
	base := map[string]any{
		"domain":     s.cfg.Domain,
		"mailDomain": s.cfg.MailDomain,
		"signup":     s.cfg.Signup,
	}
	if u == nil {
		base["user"] = nil
		return base
	}
	var orgName, plan string
	s.r.QueryRow(`SELECT name, plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&orgName, &plan)
	base["user"] = map[string]any{
		"id": u.ID, "name": u.Name, "email": u.Email, "role": u.Role,
		"mustChange": u.MustChange, "operator": s.isOperator(u),
	}
	base["org"] = map[string]any{"id": u.OrgID, "name": orgName, "plan": plan, "limits": planFor(plan)}
	base["people"] = s.people(u.OrgID)
	base["docs"] = s.docList(u)
	base["meetings"] = s.meetList(u)
	base["chat"] = map[string]any{
		"ready":  u.MxToken != "",
		"userId": s.mxid(u.MxLocal),
		"token":  u.MxToken,
		"server": s.cfg.MatrixName,
		"slack":  s.slackEnabled(),
	}
	base["mail"] = map[string]any{"ready": u.MailReady, "address": u.Email, "accountId": u.MailID}
	return base
}

type Person struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Role   string `json:"role"`
	Status string `json:"status"`
	Mx     string `json:"mx"`
	Seen   int64  `json:"seen"`
}

func (s *Server) people(orgID string) []Person {
	out := []Person{}
	rows, err := s.r.Query(`SELECT id, name, email, role, status, mx_local, last_seen FROM users WHERE org_id = ? ORDER BY name COLLATE NOCASE`, orgID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var p Person
		var mx string
		rows.Scan(&p.ID, &p.Name, &p.Email, &p.Role, &p.Status, &mx, &p.Seen)
		p.Mx = s.mxid(mx)
		out = append(out, p)
	}
	return out
}

func (s *Server) handleBoot(w http.ResponseWriter, r *http.Request) {
	u := s.sessionUser(r)
	if u != nil && (u.MxToken == "" || !u.MailReady) {
		s.provision(u)
		u = s.userByID(u.ID)
	}
	ok(w, s.boot(u))
}
