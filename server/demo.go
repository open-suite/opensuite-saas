package main

// The story in demo/seed.json, and the two places it is told.
//
// The demo organisation. An installation may name one organisation as its
// public demo (OS_DEMO). Every morning, and whenever an operator asks (Admin,
// All organisations), it is put back to the story: its people with their
// passwords, names and roles and nobody else, and all of its content in every
// app replaced by the seed. Sessions stay.
//
//   OS_DEMO=<org id>,<login>:<password>,<login>:<password>
//
// Example data. A new organisation may start with the same story
// (example.go): the seed's people join it as example colleagues, and the
// person who signed up, "me" in the seed, finds mail, events, a shared inbox
// and a chat waiting for them. Entries that name "me" exist only there; the
// demo leaves them out (withoutMe).
//
// The reset runs inside the server rather than as a separate command because
// the running process holds live state about documents: the sync hub's rooms,
// their sequence numbers and the editors connected to them. A reset from
// outside would leave those editors writing into documents that no longer
// exist; from inside, it disconnects them (they reconnect, are refused and
// drop the document). It also schedules itself, so it survives redeploys with
// no timer to install.
//
// Documents get new ids every time, so a copy kept on someone's device can
// never merge into the fresh seed. Mail is only ever imported into the
// mailboxes, never sent.

import (
	"bytes"
	"context"
	"database/sql"
	"embed"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"math"
	"mime"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the reset's own clock and the seed's events need zone data on any host
)

//go:embed demo
var demoFiles embed.FS

const (
	demoZone = "Europe/Berlin" // the daily reset runs at demoHour here
	demoHour = 4
	seedMe   = "me" // the person who signed up, in example data
)

type demoConfig struct {
	org       string
	passwords map[string]string // login (the part before the @) -> password
}

// The story. Times are relative to the reset: hours before it, days before
// it at a local time (mail), or a weekday of this week or the next (events).
// Text may say {org} for the organisation's name and {me} for the first
// name of the person who signed up.
type demoSeed struct {
	Org     string
	Plan    string
	Zone    string
	People  []struct{ Key, Login, Name, Role, Photo string }
	Folders []struct {
		Key, Name, Parent, Owner, Access string
		Link                             bool
		HoursAgo                         int64
	}
	Files []struct {
		Name, Asset, Mime, Folder, Owner string
		HoursAgo                         int64
	}
	Blobs []struct{ ID, Name, Asset, Mime, Owner string }
	Docs  []struct {
		Kind, Title, Asset, Owner, Folder, Access string
		Shares                                    []Share
		HoursAgo                                  int64
	}
	Meetings []struct{ Key, Title, Owner string }
	Groups   []struct {
		Key, Login, Name, Description, Posting string
		Members                                [][2]string // person, role
	}
	Mail     []seedMail
	Events   []seedEvent
	Contacts []seedContact
	Chat     []struct {
		Name, Owner string
		Members     []string
		Messages    [][2]string // person, text
	}
}

// A message: From and To are people's or groups' keys, or "Name <address>".
// In a group's mailbox, ReadBy and RepliedBy are the members who left their
// marks on it (readMark, replyMark).
type seedMail struct {
	Key, ReplyTo, From, Subject, Body string
	To, ReadBy, RepliedBy             []string
	Day                               int    // days before the reset
	Time                              string // local "15:04"
	Unread                            bool
}

type seedEvent struct {
	Title, Owner, Place, Meeting, Description string
	Guests, Repeat                            []string
	Week                                      int    // 0 this week, 1 the next
	Day, Time                                 string // "mon".."sun", local "15:04"
	Minutes                                   int
	AllDay                                    bool
}

type seedContact struct{ Owner, Given, Surname, Company, Title, Email, Phone, Note string }

func loadDemoSeed() (*demoSeed, error) {
	raw, err := demoFiles.ReadFile("demo/seed.json")
	if err != nil {
		return nil, err
	}
	seed := &demoSeed{}
	if err := json.Unmarshal(raw, seed); err != nil {
		return nil, errf("demo/seed.json: %v", err)
	}
	return seed, nil
}

// withoutMe is the story as the demo tells it: nothing that names the person
// who signed up, who exists only in example data.
func (seed *demoSeed) withoutMe() *demoSeed {
	out := *seed
	not := func(list []string) []string {
		return slices.DeleteFunc(slices.Clone(list), func(k string) bool { return k == seedMe })
	}
	names := func(v string) bool { return strings.Contains(v, "{me}") }
	out.Docs = nil
	for _, d := range seed.Docs {
		if d.Owner != seedMe {
			d.Shares = slices.DeleteFunc(slices.Clone(d.Shares), func(sh Share) bool { return sh.User == seedMe })
			out.Docs = append(out.Docs, d)
		}
	}
	out.Groups = nil
	for _, g := range seed.Groups {
		g.Members = slices.DeleteFunc(slices.Clone(g.Members), func(m [2]string) bool { return m[0] == seedMe })
		out.Groups = append(out.Groups, g)
	}
	out.Mail = nil
	for _, m := range seed.Mail {
		if m.From != seedMe && !slices.Contains(m.To, seedMe) && !names(m.Subject+m.Body) {
			m.ReadBy, m.RepliedBy = not(m.ReadBy), not(m.RepliedBy)
			out.Mail = append(out.Mail, m)
		}
	}
	out.Events = nil
	for _, e := range seed.Events {
		if e.Owner != seedMe && !names(e.Title+e.Description) {
			e.Guests = not(e.Guests)
			out.Events = append(out.Events, e)
		}
	}
	out.Contacts = slices.DeleteFunc(slices.Clone(seed.Contacts), func(c seedContact) bool { return c.Owner == seedMe })
	out.Chat = nil
	for _, c := range seed.Chat {
		if c.Owner == seedMe {
			continue
		}
		c.Members = not(c.Members)
		c.Messages = slices.DeleteFunc(slices.Clone(c.Messages), func(m [2]string) bool { return m[0] == seedMe || names(m[1]) })
		out.Chat = append(out.Chat, c)
	}
	return &out
}

func demoAsset(name string) []byte {
	b, err := demoFiles.ReadFile("demo/" + name)
	if err != nil {
		panic(err) // the seed is embedded; TestDemoSeed checks every asset exists
	}
	return b
}

// parseDemo reads OS_DEMO and checks it against the seed: every person in
// the story needs a password.
func parseDemo(v string) (*demoConfig, error) {
	parts := strings.Split(v, ",")
	c := &demoConfig{org: strings.TrimSpace(parts[0]), passwords: map[string]string{}}
	for _, p := range parts[1:] {
		login, pw, found := strings.Cut(strings.TrimSpace(p), ":")
		if !found || len(cleanPassword(pw)) < 10 {
			return nil, errf("OS_DEMO: %q is not <login>:<password of 10 or more characters>", login)
		}
		c.passwords[strings.ToLower(login)] = pw
	}
	seed, err := loadDemoSeed()
	if err != nil {
		return nil, err
	}
	for _, p := range seed.People {
		if c.passwords[p.Login] == "" {
			return nil, errf("OS_DEMO has no password for %s", p.Login)
		}
	}
	if c.org == "" {
		return nil, errf("OS_DEMO must start with the organisation's id")
	}
	return c, nil
}

// demoSchedule resets the demo every morning. The time of the last reset is
// kept, so a morning missed while the server was down is made up at start.
func (s *Server) demoSchedule(ctx context.Context) {
	loc, _ := time.LoadLocation(demoZone)
	for {
		var last int64
		s.r.QueryRow(`SELECT v FROM kv WHERE k = 'demo-reset'`).Scan(&last)
		from := time.Now()
		if last > 0 {
			from = time.Unix(last, 0)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Until(nextMorning(from, loc))):
		}
		rctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		err := s.resetDemo(rctx)
		cancel()
		if err != nil {
			// The engines may be restarting; try again shortly.
			log.Printf("demo: reset failed: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(15 * time.Minute):
			}
		}
	}
}

// nextMorning is the first reset time after t.
func nextMorning(t time.Time, loc *time.Location) time.Time {
	l := t.In(loc)
	next := time.Date(l.Year(), l.Month(), l.Day(), demoHour, 0, 0, 0, loc)
	if !next.After(t) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

func (s *Server) handleDemoReset(w http.ResponseWriter, r *http.Request, u *User) {
	if s.demo == nil {
		fail(w, 404, "This installation has no demo organisation.")
		return
	}
	// Not tied to the request: a reset is finished even if the page is closed.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := s.resetDemo(ctx); err != nil {
		log.Printf("demo: reset failed: %v", err)
		fail(w, 500, "The reset did not finish: "+err.Error())
		return
	}
	ok(w, map[string]bool{"ok": true})
}

var demoMu sync.Mutex

// seedRun is one telling of the story, into one organisation.
type seedRun struct {
	seed    *demoSeed
	org     string
	domain  string // where the story's addresses are
	orgName string // {org}
	me      string // {me}
	example bool   // a new organisation's example data, recorded for removal
	at      time.Time
	loc     *time.Location
	people  map[string]*User   // by key in the story
	groups  map[string]*Group  // by key
	rooms   map[string]string  // meeting room codes by key
	blobs   map[string]string  // the seed's picture ids -> the ones made
	made    func(kind, id, owner string) error
}

func (run *seedRun) text(v string) string {
	return strings.NewReplacer("{org}", run.orgName, "{me}", run.me).Replace(v)
}

// resetDemo puts the demo organisation back to the seed. It touches nothing
// outside that organisation: rows are chosen by its id, and the engines are
// reached through its own people's accounts.
func (s *Server) resetDemo(ctx context.Context) error {
	demoMu.Lock()
	defer demoMu.Unlock()
	seed, err := loadDemoSeed()
	if err != nil {
		return err
	}
	var n int
	if s.r.QueryRow(`SELECT count(*) FROM orgs WHERE id = ?`, s.demo.org).Scan(&n); n == 0 {
		return errf("the demo organisation %s does not exist", s.demo.org)
	}
	run := &seedRun{seed: seed.withoutMe(), org: s.demo.org, domain: s.cfg.MailDomain, orgName: seed.Org, at: time.Now(),
		made: func(string, string, string) error { return nil }}
	if run.loc, err = time.LoadLocation(seed.Zone); err != nil {
		return err
	}
	if run.people, err = s.demoPeople(run.seed); err != nil {
		return err
	}
	if err := s.demoClear(ctx, run.org); err != nil {
		return err
	}
	if _, err := s.w.Exec(`UPDATE orgs SET name = ?, plan = ? WHERE id = ?`, seed.Org, seed.Plan, run.org); err != nil {
		return err
	}
	if err := s.tell(ctx, run); err != nil {
		return err
	}
	s.w.Exec(`INSERT OR REPLACE INTO kv(k, v) VALUES('demo-reset', ?)`, run.at.Unix())
	log.Printf("demo: organisation %s reset", s.demo.org)
	return nil
}

// tell writes the story into the organisation: content, then each person's
// mail, calendar and contacts, the groups' mail, and chat.
func (s *Server) tell(ctx context.Context, run *seedRun) error {
	if err := s.seedContent(run); err != nil {
		return err
	}
	if s.cfg.MailURL != "" {
		if err := s.seedGroups(ctx, run); err != nil {
			return err
		}
		keys := []string{}
		for _, p := range run.seed.People {
			keys = append(keys, p.Key)
		}
		if run.people[seedMe] != nil {
			keys = append(keys, seedMe)
		}
		for _, key := range keys {
			if err := s.seedGroupware(ctx, run, key); err != nil {
				return err
			}
		}
		for _, g := range run.seed.Groups {
			if err := s.seedGroupMail(ctx, run, g.Key); err != nil {
				return err
			}
		}
	}
	if s.cfg.MatrixURL != "" {
		return s.seedChat(ctx, run)
	}
	return nil
}

// demoPeople makes the organisation's people exactly the seed's, and returns
// them by their key in the story.
func (s *Server) demoPeople(seed *demoSeed) (map[string]*User, error) {
	org := s.demo.org
	people := map[string]*User{}
	keep := map[string]bool{}
	for _, p := range seed.People {
		email := p.Login + "@" + s.cfg.MailDomain
		hash := hashPassword(s.demo.passwords[p.Login])
		var id, orgID string
		err := s.r.QueryRow(`SELECT id, org_id FROM users WHERE email = ?`, email).Scan(&id, &orgID)
		switch {
		case err == sql.ErrNoRows:
			id = newID(12)
			_, err = s.w.Exec(`INSERT INTO users(id, org_id, email, name, role, pw_hash, mx_local, mail_secret, created) VALUES(?,?,?,?,?,?,?,?,?)`,
				id, org, email, p.Name, p.Role, hash, s.mxLocalFor(email), newToken(), now())
		case err != nil:
		case orgID != org:
			err = errf("%s belongs to another organisation", email)
		default:
			_, err = s.w.Exec(`UPDATE users SET name = ?, role = ?, status = 'active', must_change = 0, pw_hash = ? WHERE id = ?`, p.Name, p.Role, hash, id)
		}
		if err != nil {
			return nil, err
		}
		if err := s.seedPhoto(id, p.Photo); err != nil {
			return nil, err
		}
		u := s.userByID(id)
		s.provision(u)
		if s.cfg.MailURL != "" && !u.MailReady {
			return nil, errf("the mailbox of %s could not be set up", email)
		}
		// Visitors share these accounts, so nothing they connected outlives
		// the morning: tokens, connected apps and pending approvals go.
		// Agents they added are removed below with everyone else.
		if _, err := s.w.Exec(`DELETE FROM api_tokens WHERE user_id = ?`, id); err != nil {
			return nil, err
		}
		s.w.Exec(`DELETE FROM oauth_codes WHERE user_id = ?`, id)
		people[p.Key] = u
		keep[id] = true
	}
	rows, err := s.r.Query(`SELECT id FROM users WHERE org_id = ?`, org)
	if err != nil {
		return nil, err
	}
	var others []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		if !keep[id] {
			others = append(others, id)
		}
	}
	rows.Close()
	for _, id := range others {
		u := s.userByID(id)
		if _, err := s.w.Exec(`DELETE FROM users WHERE id = ? AND org_id = ?`, id, org); err != nil {
			return nil, err
		}
		s.dropPhoto(id)
		s.chatDeactivate(u)
		s.mailDeleteAccount(u)
	}
	return people, nil
}

// seedPhoto gives a person of the story their picture.
func (s *Server) seedPhoto(userID, asset string) error {
	if asset == "" {
		return s.setPhoto(userID, nil)
	}
	return s.setPhoto(userID, demoAsset(asset))
}

func (s *Server) orgIDs(query, org string) []string {
	var out []string
	rows, err := s.r.Query(query, org)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		rows.Scan(&id)
		out = append(out, id)
	}
	return out
}

// demoClear deletes everything the demo organisation holds: in our own
// database and on disk, its custom domains, and its groups with their mail.
// Its people's own mailboxes are emptied later, through their accounts
// (seedGroupware).
func (s *Server) demoClear(ctx context.Context, org string) error {
	if s.cfg.MailURL != "" {
		for _, g := range s.orgGroups(org, nil) {
			if err := s.groupDeleteMail(ctx, &g); err != nil {
				return err
			}
			if _, err := s.w.Exec(`DELETE FROM mail_groups WHERE id = ? AND org_id = ?`, g.ID, org); err != nil {
				return err
			}
		}
	}
	docs := s.orgIDs(`SELECT id FROM docs WHERE org_id = ?`, org)
	files := s.orgIDs(`SELECT id FROM nodes WHERE org_id = ? AND kind = 'file'`, org)
	blobs := s.orgIDs(`SELECT id FROM blobs WHERE org_id = ?`, org)
	domains := s.orgIDs(`SELECT domain FROM domains WHERE org_id = ? AND mail_ok = 1 AND kind = 'own'`, org)
	tx, err := s.w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM doc_updates WHERE doc_id IN (SELECT id FROM docs WHERE org_id = ?1)`,
		`DELETE FROM doc_versions WHERE doc_id IN (SELECT id FROM docs WHERE org_id = ?1)`,
		`DELETE FROM doc_editors WHERE doc_id IN (SELECT id FROM docs WHERE org_id = ?1)`,
		`DELETE FROM docs WHERE org_id = ?1`,
		`DELETE FROM nodes WHERE org_id = ?1`,
		`DELETE FROM blobs WHERE org_id = ?1`,
		`DELETE FROM meetings WHERE org_id = ?1`,
		`DELETE FROM domains WHERE org_id = ?1 AND kind = 'own'`,
	} {
		if _, err := tx.Exec(q, org); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.hub.evict(docs)
	for _, id := range files {
		os.Remove(s.filePath(id))
	}
	for _, id := range blobs {
		os.Remove(filepath.Join(s.cfg.DataDir, "blobs", id))
	}
	for _, d := range domains {
		s.mailDeleteDomain(d)
	}
	return nil
}

// seedContent writes the story's folders, files, pictures, documents and
// meeting rooms.
func (s *Server) seedContent(run *seedRun) error {
	seed, people, org := run.seed, run.people, run.org
	ago := func(hours int64) int64 { return run.at.Unix() - hours*3600 }
	tx, err := s.w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// What was made is recorded once the transaction is in: the database
	// has one writer, which the transaction holds until then.
	var made [][2]string
	keep := func(kind, id string) { made = append(made, [2]string{kind, id}) }

	folders := map[string]string{}
	for _, f := range seed.Folders {
		id, link := newID(14), ""
		if f.Link {
			link = newToken()
		}
		folders[f.Key] = id
		if _, err := tx.Exec(`INSERT INTO nodes(id, org_id, owner_id, parent_id, kind, name, access, link, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, org, people[f.Owner].ID, folders[f.Parent], "folder", f.Name, access(f.Access), link, ago(f.HoursAgo), ago(f.HoursAgo)); err != nil {
			return err
		}
		keep("node", id)
	}
	written := map[string][]byte{} // path -> content, written once the rows are in
	for _, f := range seed.Files {
		id, body := newID(14), demoAsset(f.Asset)
		if _, err := tx.Exec(`INSERT INTO nodes(id, org_id, owner_id, parent_id, kind, name, mime, size, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, org, people[f.Owner].ID, folders[f.Folder], "file", f.Name, f.Mime, len(body), ago(f.HoursAgo), ago(f.HoursAgo)); err != nil {
			return err
		}
		keep("node", id)
		written[s.filePath(id)] = body
	}
	// Pictures in documents are referred to by id inside the documents. The
	// demo keeps the seed's ids; anywhere else they get new ids of the same
	// length, swapped into the documents like the people's (personalise).
	run.blobs = map[string]string{}
	for _, b := range seed.Blobs {
		id := b.ID
		if run.example {
			id = newID(len(b.ID))
		}
		run.blobs[b.ID] = id
		body := demoAsset(b.Asset)
		if _, err := tx.Exec(`INSERT INTO blobs(id, org_id, owner_id, name, mime, size, created) VALUES(?,?,?,?,?,?,?)`,
			id, org, people[b.Owner].ID, b.Name, b.Mime, len(body), run.at.Unix()); err != nil {
			return err
		}
		keep("blob", id)
		written[filepath.Join(s.cfg.DataDir, "blobs", id)] = body
	}
	for _, d := range seed.Docs {
		id, state := newID(14), demoAsset(d.Asset)
		if d.Kind != "sheet" {
			if state, err = personalise(state, people, run.blobs, run.at); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`INSERT INTO docs(id, org_id, owner_id, kind, title, folder_id, access, created, updated, snap, snap_seq, seq) VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`,
			id, org, people[d.Owner].ID, d.Kind, d.Title, folders[d.Folder], access(d.Access), ago(d.HoursAgo), ago(d.HoursAgo), state); err != nil {
			return err
		}
		keep("doc", id)
		for _, sh := range d.Shares {
			if _, err := tx.Exec(`INSERT INTO doc_shares(doc_id, user_id, role) VALUES(?,?,?)`, id, people[sh.User].ID, sh.Role); err != nil {
				return err
			}
		}
	}
	run.rooms = map[string]string{}
	for _, m := range seed.Meetings {
		run.rooms[m.Key] = newMeetCode()
		if _, err := tx.Exec(`INSERT INTO meetings(code, org_id, owner_id, title, created) VALUES(?,?,?,?,?)`, run.rooms[m.Key], org, people[m.Owner].ID, m.Title, run.at.Unix()); err != nil {
			return err
		}
		keep("meeting", run.rooms[m.Key])
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, m := range made {
		if err := run.made(m[0], m[1], ""); err != nil {
			return err
		}
	}
	for path, body := range written {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return err
		}
		if err := os.WriteFile(path, body, 0o640); err != nil {
			return err
		}
	}
	return nil
}

func access(v string) string {
	if v == "org" {
		return "org"
	}
	return "private"
}

// The stand-ins web/scripts/demo-seed.mjs writes into documents for what it
// cannot know: a person's id ("@<key>" padded with "@" to the length of an
// id), and a time (demoTimeBase plus the minutes before the reset, which Yjs
// stores as a big-endian float64 after the tag byte 123).
const demoTimeBase = 8e15

func demoPerson(key string) string { return (("@" + key) + strings.Repeat("@", 12))[:12] }

// personalise swaps the stand-ins in a document's state for the real
// people, pictures and times. Every swap keeps the length, so the encoding
// stays valid.
func personalise(state []byte, people map[string]*User, blobs map[string]string, at time.Time) ([]byte, error) {
	out := bytes.Clone(state)
	for key, u := range people {
		if len(u.ID) != 12 {
			return nil, errf("demo: %s has an id of unexpected length", u.Email)
		}
		out = bytes.ReplaceAll(out, []byte(demoPerson(key)), []byte(u.ID))
	}
	for from, to := range blobs {
		if len(from) != len(to) {
			return nil, errf("demo: picture %s was given an id of another length", from)
		}
		out = bytes.ReplaceAll(out, []byte(from), []byte(to))
	}
	for i := 0; i+9 <= len(out); i++ {
		if out[i] != 123 {
			continue
		}
		v := math.Float64frombits(binary.BigEndian.Uint64(out[i+1:]))
		if v >= demoTimeBase && v < demoTimeBase+1e6 {
			ms := float64(at.UnixMilli()) - (v-demoTimeBase)*60000
			binary.BigEndian.PutUint64(out[i+1:], math.Float64bits(ms))
			i += 8
		}
	}
	return out, nil
}

// --- mail, calendar and contacts -------------------------------------------

// seedGroups makes the seed's groups, with the seed's members.
func (s *Server) seedGroups(ctx context.Context, run *seedRun) error {
	run.groups = map[string]*Group{}
	for _, sg := range run.seed.Groups {
		login, err := s.seedLogin(run, sg.Login)
		if err != nil {
			return err
		}
		email := login + "@" + run.domain
		mailID, err := s.groupCreateMail(ctx, login, run.domain, sg.Name)
		if err != nil {
			return err
		}
		g := &Group{ID: newID(12), orgID: run.org, Email: email, Name: sg.Name, Description: run.text(sg.Description), Posting: sg.Posting, mailID: mailID}
		if _, err := s.w.Exec(`INSERT INTO mail_groups(id, org_id, email, name, description, posting, mail_id, created, example) VALUES(?,?,?,?,?,?,?,?,?)`,
			g.ID, run.org, g.Email, g.Name, g.Description, g.Posting, g.mailID, now(), run.example); err != nil {
			return err
		}
		if err := run.made("group", g.ID, ""); err != nil {
			return err
		}
		for _, m := range sg.Members {
			u := run.people[m[0]]
			if err := s.groupAccess(ctx, g, u, m[1]); err != nil {
				return err
			}
			if _, err := s.w.Exec(`INSERT INTO mail_group_members(group_id, user_id, role) VALUES(?,?,?)`, g.ID, u.ID, m[1]); err != nil {
				return err
			}
			g.Members = append(g.Members, GroupMember{u.ID, m[1]})
		}
		if g.Posting != "anyone" {
			if err := s.groupPolicy(ctx, g); err != nil {
				return err
			}
		}
		run.groups[sg.Key] = g
	}
	return nil
}

// seedLogin is the part before the @ for one of the story's addresses. In
// the demo it is the seed's, which must be free; in a new organisation an
// address already taken (the founder may have chosen "ada") gets a suffix.
func (s *Server) seedLogin(run *seedRun, login string) (string, error) {
	if !run.example {
		if s.addressTaken(login + "@" + run.domain) {
			return "", errf("%s@%s belongs to another organisation", login, run.domain)
		}
		return login, nil
	}
	for i := 0; i < 20; i++ {
		try := login
		if i > 0 {
			try = login + "-" + itoa(i+1)
		}
		if !s.addressTaken(try + "@" + run.domain) {
			return try, nil
		}
	}
	return "", errf("no free address for %s on %s", login, run.domain)
}

// seedGroupMail fills a group's mailbox from the seed, through the account of
// a member who may write in it.
func (s *Server) seedGroupMail(ctx context.Context, run *seedRun, key string) error {
	g := run.groups[key]
	var u *User
	for _, m := range g.Members {
		if u == nil && (m.Role == "user" || m.Role == "admin") {
			u = s.userByID(m.ID)
		}
	}
	if u == nil {
		return errf("demo: the group %s has nobody who may write in it", g.Email)
	}
	res, err := s.jmapAs(ctx, u, jmapUsing, jmapCall{"Mailbox/get", map[string]any{"accountId": g.mailID, "properties": []string{"role"}}})
	if err != nil {
		return err
	}
	var boxes struct {
		List []struct{ ID, Role string } `json:"list"`
	}
	json.Unmarshal(res[0].Args, &boxes)
	role := map[string]string{}
	for _, b := range boxes.List {
		role[b.Role] = b.ID
	}
	_, err = s.seedMail(ctx, run, key, u, g.mailID, role)
	return err
}

// seedGroupware fills one person's mailbox, calendar and address book from
// the seed, through that person's own account only. In the demo it first
// empties them; a new organisation's are empty already, and what is made in
// the account of the person who signed up is recorded, so it can be removed
// again without touching anything of theirs.
func (s *Server) seedGroupware(ctx context.Context, run *seedRun, key string) error {
	u := run.people[key]
	call := func(calls ...jmapCall) ([]jmapResult, error) { return s.jmapAs(ctx, u, jmapUsing, calls...) }
	type list struct {
		List []struct {
			ID, Role, Name string
			IsDefault      bool
		}
	}
	res, err := call(
		jmapCall{"Mailbox/get", map[string]any{"accountId": u.MailID, "properties": []string{"role", "name"}}},
		jmapCall{"Calendar/get", map[string]any{"accountId": u.MailID, "properties": []string{"isDefault", "name"}}},
		jmapCall{"AddressBook/get", map[string]any{"accountId": u.MailID, "properties": []string{"isDefault", "name"}}},
		jmapCall{"CalendarEvent/query", map[string]any{"accountId": u.MailID}},
		jmapCall{"ContactCard/query", map[string]any{"accountId": u.MailID}},
	)
	if err != nil {
		return err
	}
	var boxes, cals, books list
	var events, cards queryResult
	json.Unmarshal(res[0].Args, &boxes)
	json.Unmarshal(res[1].Args, &cals)
	json.Unmarshal(res[2].Args, &books)
	json.Unmarshal(res[3].Args, &events)
	json.Unmarshal(res[4].Args, &cards)
	role := map[string]string{}
	var folders, extraCals, extraBooks []string
	calendar, book := "", ""
	for _, b := range boxes.List {
		if b.Role == "" {
			folders = append(folders, b.ID)
		} else {
			role[b.Role] = b.ID
		}
	}
	for _, c := range cals.List {
		if c.IsDefault {
			calendar = c.ID
		} else {
			extraCals = append(extraCals, c.ID)
		}
	}
	for _, b := range books.List {
		if b.IsDefault {
			book = b.ID
		} else {
			extraBooks = append(extraBooks, b.ID)
		}
	}
	if role["inbox"] == "" || calendar == "" || book == "" {
		return errf("demo: the mailbox of %s is missing its inbox, calendar or address book", u.Email)
	}
	if !run.example {
		if err := s.emptyGroupware(ctx, u, folders, events.IDs, extraCals, calendar, cards.IDs, extraBooks, book); err != nil {
			return err
		}
	}
	if role["sent"] == "" {
		res, err := call(jmapCall{"Mailbox/set", map[string]any{"accountId": u.MailID, "create": map[string]any{"s": map[string]string{"name": "Sent", "role": "sent"}}}})
		if err != nil {
			return err
		}
		var sr setResult
		json.Unmarshal(res[0].Args, &sr)
		if role["sent"] = sr.Created["s"].ID; role["sent"] == "" {
			return errf("demo: could not make a Sent folder for %s: %s", u.Email, res[0].Args)
		}
	}

	mails, err := s.seedMail(ctx, run, key, u, u.MailID, role)
	if err != nil {
		return err
	}
	create := map[string]any{}
	for i, e := range run.seed.Events {
		if e.Owner == key || slices.Contains(e.Guests, key) {
			create[itoa(i+1)] = s.eventJSON(run, e, calendar)
		}
	}
	cardsNew := map[string]any{}
	for i, c := range run.seed.Contacts {
		if c.Owner == key {
			cardsNew[itoa(i+1)] = cardJSON(c, book)
		}
	}
	res, err = call(
		jmapCall{"CalendarEvent/set", map[string]any{"accountId": u.MailID, "create": create, "sendSchedulingMessages": false}},
		jmapCall{"ContactCard/set", map[string]any{"accountId": u.MailID, "create": cardsNew}},
	)
	if err != nil {
		return err
	}
	made := map[string][]string{"mail": mails}
	for i, r := range res {
		var sr setResult
		json.Unmarshal(r.Args, &sr)
		kind := []string{"event", "contact"}[i]
		if len(sr.NotCreated) > 0 {
			return errf("demo: %ss for %s refused: %s", kind, u.Email, r.Args)
		}
		for _, c := range sr.Created {
			made[kind] = append(made[kind], c.ID)
		}
	}
	if key == seedMe {
		for kind, ids := range made {
			for _, id := range ids {
				if err := run.made(kind, id, u.ID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// emptyGroupware empties a demo person's mailbox, calendars and address books.
func (s *Server) emptyGroupware(ctx context.Context, u *User, folders, events, extraCals []string, calendar string, cards, extraBooks []string, book string) error {
	call := func(calls ...jmapCall) ([]jmapResult, error) { return s.jmapAs(ctx, u, jmapUsing, calls...) }
	if _, err := call(
		jmapCall{"Mailbox/set", map[string]any{"accountId": u.MailID, "destroy": folders, "onDestroyRemoveEmails": true}},
		jmapCall{"CalendarEvent/set", map[string]any{"accountId": u.MailID, "destroy": events, "sendSchedulingMessages": false}},
		jmapCall{"Calendar/set", map[string]any{"accountId": u.MailID, "destroy": extraCals, "onDestroyRemoveEvents": true,
			"update": map[string]any{calendar: map[string]any{"name": u.Name}}}},
		jmapCall{"ContactCard/set", map[string]any{"accountId": u.MailID, "destroy": cards}},
		jmapCall{"AddressBook/set", map[string]any{"accountId": u.MailID, "destroy": extraBooks, "onDestroyRemoveContents": true,
			"update": map[string]any{book: map[string]any{"name": "My contacts"}}}},
		jmapCall{"VacationResponse/set", map[string]any{"accountId": u.MailID, "update": map[string]any{"singleton": map[string]any{"isEnabled": false}}}},
	); err != nil {
		return err
	}
	// Mail goes in rounds: a query answers with a limited number of ids.
	for round := 0; ; round++ {
		res, err := call(jmapCall{"Email/query", map[string]any{"accountId": u.MailID, "limit": 500}})
		if err != nil {
			return err
		}
		var q queryResult
		json.Unmarshal(res[0].Args, &q)
		if len(q.IDs) == 0 {
			return nil
		}
		if round == 100 {
			return errf("demo: the mailbox of %s does not empty", u.Email)
		}
		if _, err := call(jmapCall{"Email/set", map[string]any{"accountId": u.MailID, "destroy": q.IDs}}); err != nil {
			return err
		}
	}
}

// seedToday is the start of the reset's day where the story takes place.
func seedToday(at time.Time, loc *time.Location) time.Time {
	l := at.In(loc)
	return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc)
}

// seedWeekday is a day of the reset's week (week 0, from Monday) or the next.
func seedWeekday(at time.Time, loc *time.Location, week int, day string) time.Time {
	today := seedToday(at, loc)
	monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	return monday.AddDate(0, 0, week*7+strings.Index("montuewedthufrisatsun", day)/3)
}

// seedClock puts a local "15:04" on a day.
func seedClock(day time.Time, clock string) time.Time {
	t, _ := time.Parse("15:04", clock)
	return time.Date(day.Year(), day.Month(), day.Day(), t.Hour(), t.Minute(), 0, 0, day.Location())
}

// eventJSON is one seed event as JSCalendar, the way the app writes events
// (lib/calendar.js, apps/calendar-event.jsx). Guests have already accepted,
// and each keeps their own copy, so nothing needs to be sent to anyone.
func (s *Server) eventJSON(run *seedRun, e seedEvent, calendar string) map[string]any {
	people, loc := run.people, run.loc
	day := seedWeekday(run.at, loc, e.Week, e.Day)
	ev := map[string]any{
		"@type": "Event", "uid": newID(20) + "@" + run.domain, "calendarIds": map[string]bool{calendar: true}, "title": run.text(e.Title),
	}
	if e.AllDay {
		ev["start"], ev["duration"], ev["showWithoutTime"] = day.Format("2006-01-02T15:04:05"), "P1D", true
	} else {
		ev["start"], ev["timeZone"] = seedClock(day, e.Time).Format("2006-01-02T15:04:05"), loc.String()
		dur := "PT"
		if e.Minutes >= 60 {
			dur += itoa(e.Minutes/60) + "H"
		}
		if e.Minutes%60 > 0 {
			dur += itoa(e.Minutes%60) + "M"
		}
		ev["duration"] = dur
	}
	if len(e.Repeat) > 0 {
		var days []map[string]string
		for _, d := range e.Repeat {
			days = append(days, map[string]string{"@type": "NDay", "day": d})
		}
		ev["recurrenceRule"] = map[string]any{"@type": "RecurrenceRule", "frequency": "weekly", "byDay": days}
	}
	if e.Place != "" {
		ev["locations"] = map[string]any{"l1": map[string]string{"@type": "Location", "name": run.text(e.Place)}}
	}
	if e.Meeting != "" {
		ev["virtualLocations"] = map[string]any{"v1": map[string]string{"@type": "VirtualLocation", "name": "Open Suite meeting", "uri": "https://" + s.cfg.Domain + "/meet/" + run.rooms[e.Meeting]}}
	}
	if e.Description != "" {
		ev["description"] = run.text(e.Description)
	}
	if len(e.Guests) > 0 {
		owner := people[e.Owner]
		ev["organizerCalendarAddress"] = "mailto:" + owner.Email
		parts := map[string]any{"me": map[string]any{"@type": "Participant", "name": owner.Name, "calendarAddress": "mailto:" + owner.Email,
			"roles": map[string]bool{"owner": true, "attendee": true}, "participationStatus": "accepted"}}
		for i, g := range e.Guests {
			parts["g"+itoa(i+1)] = map[string]any{"@type": "Participant", "name": people[g].Name, "calendarAddress": "mailto:" + people[g].Email,
				"roles": map[string]bool{"attendee": true}, "participationStatus": "accepted"}
		}
		ev["participants"] = parts
	}
	return ev
}

// cardJSON is one seed contact as JSContact, the way lib/contacts.js writes one.
func cardJSON(c seedContact, book string) map[string]any {
	card := map[string]any{
		"@type": "Card", "version": "1.0", "addressBookIds": map[string]bool{book: true},
		"name": map[string]any{"full": c.Given + " " + c.Surname, "isOrdered": true, "components": []map[string]string{
			{"kind": "given", "value": c.Given}, {"kind": "surname", "value": c.Surname}}},
		"emails":        map[string]any{"e1": map[string]any{"address": c.Email, "contexts": map[string]bool{"work": true}}},
		"phones":        map[string]any{"p1": map[string]any{"number": c.Phone, "contexts": map[string]bool{"work": true}}},
		"organizations": map[string]any{"o1": map[string]string{"name": c.Company}},
		"titles":        map[string]any{"t1": map[string]string{"name": c.Title, "kind": "title"}},
	}
	if c.Note != "" {
		card["notes"] = map[string]any{"n1": map[string]string{"note": c.Note}}
	}
	return card
}

// seedMail imports the seed's messages into one mailbox, the person's or the
// group's named by key, through the account of u: what it sent into Sent,
// what it received into the Inbox. Imported, never sent. It returns the
// messages' ids.
func (s *Server) seedMail(ctx context.Context, run *seedRun, key string, u *User, account string, role map[string]string) ([]string, error) {
	people, groups := run.people, run.groups
	addr := func(v string) (*mail.Address, error) {
		if p := people[v]; p != nil {
			return &mail.Address{Name: p.Name, Address: p.Email}, nil
		}
		if g := groups[v]; g != nil {
			return &mail.Address{Name: g.Name, Address: g.Email}, nil
		}
		return mail.ParseAddress(v)
	}
	// Message ids are made new at each reset and shared by both copies, so
	// replies thread the same way in every mailbox.
	ids, refs := map[string]string{}, map[string]string{}
	for _, m := range run.seed.Mail {
		ids[m.Key] = "<" + m.Key + "." + run.at.Format("20060102") + "." + run.org + "@" + run.domain + ">"
		if m.ReplyTo != "" {
			refs[m.Key] = strings.TrimSpace(refs[m.ReplyTo] + " " + ids[m.ReplyTo])
		}
	}
	imports := map[string]any{}
	for i, m := range run.seed.Mail {
		var box string
		seen := true
		switch {
		case m.From == key:
			box = role["sent"]
		case slices.Contains(m.To, key):
			box, seen = role["inbox"], !m.Unread
		default:
			continue
		}
		from, err := addr(m.From)
		if err != nil {
			return nil, err
		}
		var to []string
		for _, t := range m.To {
			a, err := addr(t)
			if err != nil {
				return nil, err
			}
			to = append(to, a.String())
		}
		sent := seedClock(seedToday(run.at, run.loc).AddDate(0, 0, m.Day), m.Time)
		var raw bytes.Buffer
		head := func(k, v string) { raw.WriteString(k + ": " + v + "\r\n") }
		head("From", from.String())
		head("To", strings.Join(to, ", "))
		head("Subject", mime.QEncoding.Encode("utf-8", run.text(m.Subject)))
		head("Date", sent.Format(time.RFC1123Z))
		head("Message-ID", ids[m.Key])
		if m.ReplyTo != "" {
			head("In-Reply-To", ids[m.ReplyTo])
			head("References", refs[m.Key])
		}
		head("MIME-Version", "1.0")
		head("Content-Type", "text/plain; charset=utf-8")
		head("Content-Transfer-Encoding", "8bit")
		raw.WriteString("\r\n" + strings.ReplaceAll(run.text(m.Body), "\n", "\r\n") + "\r\n")
		blob, err := s.mailUpload(ctx, u, account, raw.Bytes())
		if err != nil {
			return nil, err
		}
		keywords := map[string]bool{}
		if seen {
			keywords["$seen"] = true
		}
		for _, p := range m.ReadBy {
			keywords[readMark(people[p].ID)] = true
		}
		for _, p := range m.RepliedBy {
			keywords["$answered"], keywords[replyMark(people[p].ID)] = true, true
		}
		imports[itoa(i+1)] = map[string]any{"blobId": blob, "mailboxIds": map[string]bool{box: true}, "keywords": keywords, "receivedAt": sent.UTC().Format(time.RFC3339)}
	}
	if len(imports) == 0 {
		return nil, nil
	}
	res, err := s.jmapAs(ctx, u, jmapUsing, jmapCall{"Email/import", map[string]any{"accountId": account, "emails": imports}})
	if err != nil {
		return nil, err
	}
	var sr setResult
	json.Unmarshal(res[0].Args, &sr)
	if len(sr.NotCreated) > 0 {
		return nil, errf("demo: mail for %s refused: %s", key, res[0].Args)
	}
	var made []string
	for _, c := range sr.Created {
		made = append(made, c.ID)
	}
	return made, nil
}

// mailUpload stores a raw message in a mailbox u may write in, for
// Email/import.
func (s *Server) mailUpload(ctx context.Context, u *User, account string, body []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", s.cfg.MailURL+"/jmap/upload/"+url.PathEscape(account)+"/", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(u.Email, u.MailSecret)
	req.Header.Set("Content-Type", "message/rfc822")
	res, err := s.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var up struct {
		BlobID string `json:"blobId"`
	}
	if res.StatusCode >= 300 || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&up) != nil || up.BlobID == "" {
		return "", errf("demo: the mail engine refused a message for %s (%d)", u.Email, res.StatusCode)
	}
	return up.BlobID, nil
}

// --- chat -------------------------------------------------------------------

// seedChat starts the seed's conversations. In the demo it first takes the
// seed's people out of every conversation they are in, each with a new chat
// session (their browsers pick it up through /api/chat/token).
func (s *Server) seedChat(ctx context.Context, run *seedRun) error {
	const quiet = `{"room":{"timeline":{"limit":0},"state":{"types":[]},"ephemeral":{"types":[]},"account_data":{"types":[]}},"presence":{"types":[]},"account_data":{"types":[]}}`
	for key, u := range run.people {
		if run.example {
			if u.MxToken == "" {
				s.chatEnsure(ctx, u)
			}
			if u.MxToken == "" {
				return errf("demo: no chat session for %s", u.Email)
			}
			continue
		}
		u.MxToken = ""
		s.chatEnsure(ctx, u)
		if u.MxToken == "" {
			return errf("demo: no chat session for %s (%s)", u.Email, key)
		}
		var sync struct {
			Rooms struct{ Join, Invite map[string]json.RawMessage }
		}
		if _, err := s.matrix(ctx, "GET", "/_matrix/client/v3/sync?timeout=0&filter="+url.QueryEscape(quiet), u.MxToken, nil, &sync); err != nil {
			return err
		}
		for _, joined := range []map[string]json.RawMessage{sync.Rooms.Join, sync.Rooms.Invite} {
			for id := range joined {
				room := "/_matrix/client/v3/rooms/" + url.PathEscape(id)
				if _, err := s.matrix(ctx, "POST", room+"/leave", u.MxToken, map[string]any{}, nil); err != nil {
					return err
				}
				s.matrix(ctx, "POST", room+"/forget", u.MxToken, map[string]any{}, nil)
			}
		}
	}
	for _, c := range run.seed.Chat {
		var invite []string
		for _, m := range c.Members {
			invite = append(invite, s.mxid(run.people[m].MxLocal))
		}
		var made struct {
			RoomID string `json:"room_id"`
		}
		if _, err := s.matrix(ctx, "POST", "/_matrix/client/v3/createRoom", run.people[c.Owner].MxToken,
			map[string]any{"preset": "private_chat", "name": run.text(c.Name), "invite": invite}, &made); err != nil {
			return err
		}
		if slices.Contains(c.Members, seedMe) {
			if err := run.made("room", made.RoomID, run.people[seedMe].ID); err != nil {
				return err
			}
		}
		room := "/_matrix/client/v3/rooms/" + url.PathEscape(made.RoomID)
		for _, m := range c.Members {
			if _, err := s.matrix(ctx, "POST", "/_matrix/client/v3/join/"+url.PathEscape(made.RoomID), run.people[m].MxToken, map[string]any{}, nil); err != nil {
				return err
			}
		}
		for i, msg := range c.Messages {
			path := room + "/send/m.room.message/demo" + itoa(i+1) + "-" + newID(8)
			if _, err := s.matrix(ctx, "PUT", path, run.people[msg[0]].MxToken, map[string]string{"msgtype": "m.text", "body": run.text(msg[1])}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
