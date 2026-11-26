package main

// The demo organisation. An installation may name one organisation as its
// public demo (OS_DEMO). Every morning, and whenever an operator asks (Admin,
// All organisations), it is put back to the story in demo/seed.json: its
// people with their passwords, names and roles and nobody else, and all of
// its content in every app replaced by the seed. Sessions stay.
//
//   OS_DEMO=<org id>,<login>:<password>,<login>:<password>
//
// The reset runs inside the server rather than as a separate command because
// the running process holds live state about documents: the sync hub's rooms,
// their sequence numbers and the editors connected to them. A reset from
// outside would leave those editors writing into documents that no longer
// exist; from inside, it disconnects them (they reconnect, are refused and
// drop the document). It also schedules itself, so it survives redeploys with
// no timer to install.
//
// Documents get new ids at every reset, so a copy kept on someone's device
// can never merge into the fresh seed. Mail is only ever imported into the
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
)

type demoConfig struct {
	org       string
	passwords map[string]string // login (the part before the @) -> password
}

// The story. Times are relative to the reset: hours before it, days before
// it at a local time (mail), or a weekday of this week or the next (events).
type demoSeed struct {
	Org     string
	Plan    string
	Zone    string
	People  []struct{ Key, Login, Name, Role string }
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
	Mail     []seedMail
	Events   []seedEvent
	Contacts []seedContact
	Chat     []struct {
		Name, Owner string
		Members     []string
		Messages    [][2]string // person, text
	}
}

// A message: From and To are people's keys or "Name <address>".
type seedMail struct {
	Key, ReplyTo, From, Subject, Body string
	To                                []string
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
	at := time.Now()
	people, err := s.demoPeople(seed)
	if err != nil {
		return err
	}
	rooms, err := s.demoContent(seed, people, at)
	if err != nil {
		return err
	}
	if s.cfg.MailURL != "" {
		for _, p := range seed.People {
			if err := s.demoGroupware(ctx, seed, people, p.Key, rooms, at); err != nil {
				return err
			}
		}
	}
	if s.cfg.MatrixURL != "" {
		if err := s.demoChat(ctx, seed, people); err != nil {
			return err
		}
	}
	s.w.Exec(`INSERT OR REPLACE INTO kv(k, v) VALUES('demo-reset', ?)`, at.Unix())
	log.Printf("demo: organisation %s reset", s.demo.org)
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
		s.chatDeactivate(u)
		s.mailDeleteAccount(u)
	}
	return people, nil
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

// demoContent replaces everything the organisation holds in our own
// database and on disk, and returns the new meeting rooms' codes by key.
func (s *Server) demoContent(seed *demoSeed, people map[string]*User, at time.Time) (map[string]string, error) {
	org := s.demo.org
	docs := s.orgIDs(`SELECT id FROM docs WHERE org_id = ?`, org)
	files := s.orgIDs(`SELECT id FROM nodes WHERE org_id = ? AND kind = 'file'`, org)
	blobs := s.orgIDs(`SELECT id FROM blobs WHERE org_id = ?`, org)
	domains := s.orgIDs(`SELECT domain FROM domains WHERE org_id = ? AND mail_ok = 1`, org)
	ago := func(hours int64) int64 { return at.Unix() - hours*3600 }

	tx, err := s.w.Begin()
	if err != nil {
		return nil, err
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
		`DELETE FROM domains WHERE org_id = ?1`,
	} {
		if _, err := tx.Exec(q, org); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE orgs SET name = ?, plan = ? WHERE id = ?`, seed.Org, seed.Plan, org); err != nil {
		return nil, err
	}

	folders := map[string]string{}
	for _, f := range seed.Folders {
		id, link := newID(14), ""
		if f.Link {
			link = newToken()
		}
		folders[f.Key] = id
		if _, err := tx.Exec(`INSERT INTO nodes(id, org_id, owner_id, parent_id, kind, name, access, link, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, org, people[f.Owner].ID, folders[f.Parent], "folder", f.Name, access(f.Access), link, ago(f.HoursAgo), ago(f.HoursAgo)); err != nil {
			return nil, err
		}
	}
	written := map[string][]byte{} // path -> content, written once the rows are in
	for _, f := range seed.Files {
		id, body := newID(14), demoAsset(f.Asset)
		if _, err := tx.Exec(`INSERT INTO nodes(id, org_id, owner_id, parent_id, kind, name, mime, size, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, org, people[f.Owner].ID, folders[f.Folder], "file", f.Name, f.Mime, len(body), ago(f.HoursAgo), ago(f.HoursAgo)); err != nil {
			return nil, err
		}
		written[s.filePath(id)] = body
	}
	for _, b := range seed.Blobs {
		body := demoAsset(b.Asset)
		if _, err := tx.Exec(`INSERT INTO blobs(id, org_id, owner_id, name, mime, size, created) VALUES(?,?,?,?,?,?,?)`,
			b.ID, org, people[b.Owner].ID, b.Name, b.Mime, len(body), at.Unix()); err != nil {
			return nil, err
		}
		written[filepath.Join(s.cfg.DataDir, "blobs", b.ID)] = body
	}
	for _, d := range seed.Docs {
		id, state := newID(14), demoAsset(d.Asset)
		if d.Kind != "sheet" {
			if state, err = demoPersonalise(state, people, at); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(`INSERT INTO docs(id, org_id, owner_id, kind, title, folder_id, access, created, updated, snap, snap_seq, seq) VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`,
			id, org, people[d.Owner].ID, d.Kind, d.Title, folders[d.Folder], access(d.Access), ago(d.HoursAgo), ago(d.HoursAgo), state); err != nil {
			return nil, err
		}
		for _, sh := range d.Shares {
			if _, err := tx.Exec(`INSERT INTO doc_shares(doc_id, user_id, role) VALUES(?,?,?)`, id, people[sh.User].ID, sh.Role); err != nil {
				return nil, err
			}
		}
	}
	rooms := map[string]string{}
	for _, m := range seed.Meetings {
		rooms[m.Key] = newMeetCode()
		if _, err := tx.Exec(`INSERT INTO meetings(code, org_id, owner_id, title, created) VALUES(?,?,?,?,?)`, rooms[m.Key], org, people[m.Owner].ID, m.Title, at.Unix()); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
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
	for path, body := range written {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, body, 0o640); err != nil {
			return nil, err
		}
	}
	return rooms, nil
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

func demoPersonalise(state []byte, people map[string]*User, at time.Time) ([]byte, error) {
	out := bytes.Clone(state)
	for key, u := range people {
		if len(u.ID) != 12 {
			return nil, errf("demo: %s has an id of unexpected length", u.Email)
		}
		out = bytes.ReplaceAll(out, []byte(demoPerson(key)), []byte(u.ID))
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

// demoGroupware empties one person's mailbox, calendars and address books in
// the mail engine and fills them from the seed. It works through that
// person's own account only.
func (s *Server) demoGroupware(ctx context.Context, seed *demoSeed, people map[string]*User, key string, rooms map[string]string, at time.Time) error {
	u := people[key]
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
	if _, err := call(
		jmapCall{"Mailbox/set", map[string]any{"accountId": u.MailID, "destroy": folders, "onDestroyRemoveEmails": true}},
		jmapCall{"CalendarEvent/set", map[string]any{"accountId": u.MailID, "destroy": events.IDs, "sendSchedulingMessages": false}},
		jmapCall{"Calendar/set", map[string]any{"accountId": u.MailID, "destroy": extraCals, "onDestroyRemoveEvents": true,
			"update": map[string]any{calendar: map[string]any{"name": u.Name}}}},
		jmapCall{"ContactCard/set", map[string]any{"accountId": u.MailID, "destroy": cards.IDs}},
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
			break
		}
		if round == 100 {
			return errf("demo: the mailbox of %s does not empty", u.Email)
		}
		if _, err := call(jmapCall{"Email/set", map[string]any{"accountId": u.MailID, "destroy": q.IDs}}); err != nil {
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

	loc, err := time.LoadLocation(seed.Zone)
	if err != nil {
		return err
	}
	if err := s.demoMail(ctx, seed, people, key, role, loc, at); err != nil {
		return err
	}
	create := map[string]any{}
	for i, e := range seed.Events {
		if e.Owner == key || slices.Contains(e.Guests, key) {
			create[itoa(i+1)] = s.eventJSON(e, people, rooms, calendar, loc, at)
		}
	}
	cardsNew := map[string]any{}
	for i, c := range seed.Contacts {
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
	for i, r := range res {
		var sr setResult
		json.Unmarshal(r.Args, &sr)
		if len(sr.NotCreated) > 0 {
			return errf("demo: %s for %s refused: %s", []string{"events", "contacts"}[i], u.Email, r.Args)
		}
	}
	return nil
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
func (s *Server) eventJSON(e seedEvent, people map[string]*User, rooms map[string]string, calendar string, loc *time.Location, at time.Time) map[string]any {
	day := seedWeekday(at, loc, e.Week, e.Day)
	ev := map[string]any{
		"@type": "Event", "uid": newID(20) + "@" + s.cfg.MailDomain, "calendarIds": map[string]bool{calendar: true}, "title": e.Title,
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
		ev["locations"] = map[string]any{"l1": map[string]string{"@type": "Location", "name": e.Place}}
	}
	if e.Meeting != "" {
		ev["virtualLocations"] = map[string]any{"v1": map[string]string{"@type": "VirtualLocation", "name": "Open Suite meeting", "uri": "https://" + s.cfg.Domain + "/meet/" + rooms[e.Meeting]}}
	}
	if e.Description != "" {
		ev["description"] = e.Description
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

// demoMail imports the seed's messages into one person's mailbox: what they
// sent into Sent, what they received into the Inbox. Imported, never sent.
func (s *Server) demoMail(ctx context.Context, seed *demoSeed, people map[string]*User, key string, role map[string]string, loc *time.Location, at time.Time) error {
	u := people[key]
	addr := func(v string) (*mail.Address, error) {
		if p := people[v]; p != nil {
			return &mail.Address{Name: p.Name, Address: p.Email}, nil
		}
		return mail.ParseAddress(v)
	}
	// Message ids are made new at each reset and shared by both copies, so
	// replies thread the same way in every mailbox.
	ids, refs := map[string]string{}, map[string]string{}
	for _, m := range seed.Mail {
		ids[m.Key] = "<" + m.Key + "." + at.Format("20060102") + "@" + s.cfg.MailDomain + ">"
		if m.ReplyTo != "" {
			refs[m.Key] = strings.TrimSpace(refs[m.ReplyTo] + " " + ids[m.ReplyTo])
		}
	}
	imports := map[string]any{}
	for i, m := range seed.Mail {
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
			return err
		}
		var to []string
		for _, t := range m.To {
			a, err := addr(t)
			if err != nil {
				return err
			}
			to = append(to, a.String())
		}
		sent := seedClock(seedToday(at, loc).AddDate(0, 0, m.Day), m.Time)
		var raw bytes.Buffer
		head := func(k, v string) { raw.WriteString(k + ": " + v + "\r\n") }
		head("From", from.String())
		head("To", strings.Join(to, ", "))
		head("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
		head("Date", sent.Format(time.RFC1123Z))
		head("Message-ID", ids[m.Key])
		if m.ReplyTo != "" {
			head("In-Reply-To", ids[m.ReplyTo])
			head("References", refs[m.Key])
		}
		head("MIME-Version", "1.0")
		head("Content-Type", "text/plain; charset=utf-8")
		head("Content-Transfer-Encoding", "8bit")
		raw.WriteString("\r\n" + strings.ReplaceAll(m.Body, "\n", "\r\n") + "\r\n")
		blob, err := s.mailUpload(ctx, u, raw.Bytes())
		if err != nil {
			return err
		}
		keywords := map[string]bool{}
		if seen {
			keywords["$seen"] = true
		}
		imports[itoa(i+1)] = map[string]any{"blobId": blob, "mailboxIds": map[string]bool{box: true}, "keywords": keywords, "receivedAt": sent.UTC().Format(time.RFC3339)}
	}
	if len(imports) == 0 {
		return nil
	}
	res, err := s.jmapAs(ctx, u, jmapUsing, jmapCall{"Email/import", map[string]any{"accountId": u.MailID, "emails": imports}})
	if err != nil {
		return err
	}
	var r struct {
		NotCreated map[string]json.RawMessage `json:"notCreated"`
	}
	json.Unmarshal(res[0].Args, &r)
	if len(r.NotCreated) > 0 {
		return errf("demo: mail for %s refused: %s", u.Email, res[0].Args)
	}
	return nil
}

// mailUpload stores a raw message in a person's account for Email/import.
func (s *Server) mailUpload(ctx context.Context, u *User, body []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", s.cfg.MailURL+"/jmap/upload/"+url.PathEscape(u.MailID)+"/", bytes.NewReader(body))
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

// demoChat takes the seed's people out of every conversation they are in and
// starts the seed's conversations afresh. Each person gets a new chat session
// for this; their browsers pick it up through /api/chat/token.
func (s *Server) demoChat(ctx context.Context, seed *demoSeed, people map[string]*User) error {
	const quiet = `{"room":{"timeline":{"limit":0},"state":{"types":[]},"ephemeral":{"types":[]},"account_data":{"types":[]}},"presence":{"types":[]},"account_data":{"types":[]}}`
	for _, p := range seed.People {
		u := people[p.Key]
		u.MxToken = ""
		s.chatEnsure(ctx, u)
		if u.MxToken == "" {
			return errf("demo: no chat session for %s", u.Email)
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
	for _, c := range seed.Chat {
		var invite []string
		for _, m := range c.Members {
			invite = append(invite, s.mxid(people[m].MxLocal))
		}
		var made struct {
			RoomID string `json:"room_id"`
		}
		if _, err := s.matrix(ctx, "POST", "/_matrix/client/v3/createRoom", people[c.Owner].MxToken,
			map[string]any{"preset": "private_chat", "name": c.Name, "invite": invite}, &made); err != nil {
			return err
		}
		room := "/_matrix/client/v3/rooms/" + url.PathEscape(made.RoomID)
		for _, m := range c.Members {
			if _, err := s.matrix(ctx, "POST", "/_matrix/client/v3/join/"+url.PathEscape(made.RoomID), people[m].MxToken, map[string]any{}, nil); err != nil {
				return err
			}
		}
		for i, msg := range c.Messages {
			path := room + "/send/m.room.message/demo" + itoa(i+1) + "-" + newID(8)
			if _, err := s.matrix(ctx, "PUT", path, people[msg[0]].MxToken, map[string]string{"msgtype": "m.text", "body": msg[1]}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
