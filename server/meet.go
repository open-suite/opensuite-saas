package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type Meeting struct {
	Code    string `json:"code"`
	Title   string `json:"title"`
	Owner   string `json:"owner"`
	Created int64  `json:"created"`
	Used    int64  `json:"used"`
}

var meetCodeRe = regexp.MustCompile(`^[a-z]{3}-[a-z]{4}-[a-z]{3}$`)

func newMeetCode() string {
	const letters = "abcdefghijkmnopqrstuvwxyz"
	b := make([]byte, 10)
	rand.Read(b)
	for i := range b {
		b[i] = letters[int(b[i])%len(letters)]
	}
	return string(b[:3]) + "-" + string(b[3:7]) + "-" + string(b[7:])
}

func (s *Server) meetList(u *User) []Meeting {
	out := []Meeting{}
	rows, err := s.r.Query(`SELECT code, title, owner_id, created, last_used FROM meetings WHERE org_id = ? AND owner_id = ?
		ORDER BY max(created, last_used) DESC LIMIT 50`, u.OrgID, u.ID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var m Meeting
		rows.Scan(&m.Code, &m.Title, &m.Owner, &m.Created, &m.Used)
		out = append(out, m)
	}
	return out
}

func (s *Server) handleMeetList(w http.ResponseWriter, r *http.Request, u *User) { ok(w, s.meetList(u)) }

func (s *Server) handleMeetCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Code, Title string }
	readJSON(r, &in)
	// The client may mint the code so the room opens without waiting.
	code := in.Code
	if !meetCodeRe.MatchString(code) {
		code = newMeetCode()
	}
	title := strings.TrimSpace(in.Title)
	if len(title) > 120 {
		title = title[:120]
	}
	if _, err := s.w.Exec(`INSERT INTO meetings(code, org_id, owner_id, title, created) VALUES(?,?,?,?,?)`, code, u.OrgID, u.ID, title, now()); err != nil {
		fail(w, 409, "That meeting code is in use.")
		return
	}
	ok(w, Meeting{Code: code, Title: title, Owner: u.ID, Created: now()})
}

func (s *Server) handleMeetDelete(w http.ResponseWriter, r *http.Request, u *User) {
	s.w.Exec(`DELETE FROM meetings WHERE code = ? AND owner_id = ?`, r.PathValue("code"), u.ID)
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleMeetInfo(w http.ResponseWriter, r *http.Request) {
	var title, org string
	err := s.r.QueryRow(`SELECT m.title, o.name FROM meetings m JOIN orgs o ON o.id = m.org_id WHERE m.code = ?`, r.PathValue("code")).Scan(&title, &org)
	if err != nil {
		fail(w, 404, "This meeting doesn't exist.")
		return
	}
	ok(w, map[string]string{"code": r.PathValue("code"), "title": title, "org": org})
}

// handleMeetJoin hands out a media-server token. Members join as themselves;
// anyone else holding the link joins as a named guest.
func (s *Server) handleMeetJoin(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	var in struct{ Name string }
	readJSON(r, &in)
	var orgID, owner string
	if s.r.QueryRow(`SELECT org_id, owner_id FROM meetings WHERE code = ?`, code).Scan(&orgID, &owner) != nil {
		fail(w, 404, "This meeting doesn't exist.")
		return
	}
	identity, name, host := "", "", false
	if u := s.sessionUser(r); u != nil {
		identity, name, host = u.ID, u.Name, u.ID == owner
	} else {
		if !s.lim.allow("meet:"+clientIP(r), 30, 10*time.Minute) {
			fail(w, 429, "Too many attempts. Try again shortly.")
			return
		}
		name = strings.TrimSpace(in.Name)
		if name == "" || len(name) > 60 {
			fail(w, 400, "Enter your name to join.")
			return
		}
		identity = "guest-" + newID(10)
	}
	s.w.Exec(`UPDATE meetings SET last_used = ? WHERE code = ?`, now(), code)
	tok := s.liveKitToken(code, identity, name, host)
	ok(w, map[string]any{"token": tok, "identity": identity, "name": name, "host": host})
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func signHS256(secret []byte, claims any) string {
	head := b64([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	msg := head + "." + b64(body)
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(msg))
	return msg + "." + b64(m.Sum(nil))
}

func (s *Server) liveKitToken(roomName, identity, name string, host bool) string {
	t := now()
	return signHS256([]byte(s.cfg.LiveKitSecret), map[string]any{
		"iss": s.cfg.LiveKitKey, "sub": identity, "name": name,
		"nbf": t - 10, "exp": t + 6*3600,
		"video": map[string]any{
			"room": roomName, "roomJoin": true, "canPublish": true, "canSubscribe": true,
			"canPublishData": true, "roomAdmin": host,
		},
	})
}
