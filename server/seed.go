package main

// Example data. Whoever signs up may start with the demo's story (demo.go)
// instead of an empty organisation: the seed's people join as example
// colleagues with their pictures, and the founder, "me" in the seed, finds
// the launch documents and files, a welcome in their inbox, events in their
// calendar, the Sales shared inbox and a chat waiting.
//
// Example colleagues are members without a password (they cannot sign in)
// and do not count against the plan's people limit, nor does the example
// group against its group limit: otherwise a Free organisation of five would
// start with two places taken by people who do not exist. They cost a
// mailbox each, which is what sign-up's rate limit already bounds.
//
// Everything the seed makes is recorded in example_items, so "Remove example
// data" (Admin, Organisation) deletes exactly that: the example colleagues,
// the example group with its mail, the documents, files and meeting rooms,
// and the mail, events, contacts and chats it put in the founder's accounts.
// What anyone made in the meantime stays, even inside an example folder (it
// moves to the top level of Files).

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const schemaExample = `
CREATE TABLE IF NOT EXISTS example_items(
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(org_id, kind, id)
) WITHOUT ROWID;
`

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		for _, c := range [][3]string{
			{"users", "example", "INTEGER NOT NULL DEFAULT 0"},
			{"orgs", "example", "INTEGER NOT NULL DEFAULT 0"},
			{"mail_groups", "example", "INTEGER NOT NULL DEFAULT 0"},
		} {
			if err := ensureColumn(w, c[0], c[1], c[2]); err != nil {
				return err
			}
		}
		_, err := w.Exec(schemaExample)
		return err
	})
}

// seedExample fills a new organisation with the story, around its founder.
func (s *Server) seedExample(ctx context.Context, founder *User) error {
	seed, err := loadDemoSeed()
	if err != nil {
		return err
	}
	_, domain, _ := strings.Cut(founder.Email, "@")
	run := &seedRun{seed: seed, org: founder.OrgID, domain: domain, me: strings.Fields(founder.Name + " x")[0], example: true, at: time.Now()}
	s.r.QueryRow(`SELECT name FROM orgs WHERE id = ?`, run.org).Scan(&run.orgName)
	if run.loc, err = time.LoadLocation(seed.Zone); err != nil {
		return err
	}
	run.made = func(kind, id, owner string) error {
		_, err := s.w.Exec(`INSERT OR IGNORE INTO example_items(org_id, kind, id, owner) VALUES(?,?,?,?)`, run.org, kind, id, owner)
		return err
	}
	if _, err := s.w.Exec(`UPDATE orgs SET example = 1 WHERE id = ?`, run.org); err != nil {
		return err
	}
	run.people = map[string]*User{seedMe: founder}
	for _, p := range seed.People {
		login, err := s.seedLogin(run, p.Login)
		if err != nil {
			return err
		}
		email, id := login+"@"+domain, newID(12)
		if _, err := s.w.Exec(`INSERT INTO users(id, org_id, email, name, role, pw_hash, example, mx_local, mail_secret, created) VALUES(?,?,?,?,'member','',1,?,?,?)`,
			id, run.org, email, p.Name, s.mxLocalFor(email), newToken(), now()); err != nil {
			return err
		}
		if err := run.made("user", id, ""); err != nil {
			return err
		}
		if err := s.seedPhoto(id, p.Photo); err != nil {
			return err
		}
		u := s.userByID(id)
		s.provision(u)
		if s.cfg.MailURL != "" && !u.MailReady {
			return errf("the mailbox of %s could not be set up", email)
		}
		run.people[p.Key] = u
	}
	if err := s.tell(ctx, run); err != nil {
		return err
	}
	s.refreshPolicies(run.org)
	return nil
}

func (s *Server) exampleOps() []*apiOp {
	return []*apiOp{
		{Method: "DELETE", Path: "/api/v1/admin/example-data", ID: "admin_remove_example_data", Tag: "Administration", Summary: "Remove the example data", Admin: true, Write: true,
			Desc: "For an organisation that started with example data: deletes the example colleagues, the example group and its mail, the example documents, files and meeting rooms, " +
				"and the example mail, events, contacts and chats in the founder's accounts. Nothing anyone made is touched.",
			Result: okResult, H: s.handleExampleRemove},
	}
}

func (s *Server) handleExampleRemove(w http.ResponseWriter, r *http.Request, u *User) {
	var example bool
	s.r.QueryRow(`SELECT example FROM orgs WHERE id = ?`, u.OrgID).Scan(&example)
	if !example {
		fail(w, 404, "This organisation has no example data.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := s.removeExample(ctx, u); err != nil {
		log.Printf("example: removing from %s: %v", u.OrgID, err)
		fail(w, 502, "Some of the example data could not be removed. Try again in a minute.")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// removeExample deletes what seedExample made in the organisation of by,
// who becomes the owner of anything an example colleague held that was not
// part of the example. A step that fails leaves its records, so trying
// again finishes the job.
func (s *Server) removeExample(ctx context.Context, by *User) error {
	org := by.OrgID
	items := map[string][][2]string{} // kind -> (id, owner)
	rows, err := s.r.Query(`SELECT kind, id, owner FROM example_items WHERE org_id = ?`, org)
	if err != nil {
		return err
	}
	for rows.Next() {
		var kind, id, owner string
		rows.Scan(&kind, &id, &owner)
		items[kind] = append(items[kind], [2]string{id, owner})
	}
	rows.Close()
	ids := func(kind string) []string {
		var out []string
		for _, it := range items[kind] {
			out = append(out, it[0])
		}
		return out
	}
	done := func(kind, id string) {
		s.w.Exec(`DELETE FROM example_items WHERE org_id = ? AND kind = ? AND id = ?`, org, kind, id)
	}

	// What the seed put in people's own mailboxes and chats: theirs to keep
	// otherwise, so only the recorded items go.
	byOwner := func(kind string) map[string][]string {
		out := map[string][]string{}
		for _, it := range items[kind] {
			out[it[1]] = append(out[it[1]], it[0])
		}
		return out
	}
	for kind, method := range map[string]string{"mail": "Email/set", "event": "CalendarEvent/set", "contact": "ContactCard/set"} {
		for owner, list := range byOwner(kind) {
			u := s.userByID(owner)
			if u != nil && u.MailReady && s.cfg.MailURL != "" {
				args := map[string]any{"accountId": u.MailID, "destroy": list}
				if kind == "event" {
					args["sendSchedulingMessages"] = false
				}
				if _, err := s.jmapAs(ctx, u, jmapUsing, jmapCall{method, args}); err != nil {
					return err
				}
			}
			for _, id := range list {
				done(kind, id)
			}
		}
	}
	for owner, list := range byOwner("room") {
		u := s.userByID(owner)
		if u != nil && s.cfg.MatrixURL != "" {
			if u.MxToken == "" {
				s.chatEnsure(ctx, u)
			}
			for _, id := range list {
				room := "/_matrix/client/v3/rooms/" + url.PathEscape(id)
				s.matrix(ctx, "POST", room+"/leave", u.MxToken, map[string]any{}, nil)
				s.matrix(ctx, "POST", room+"/forget", u.MxToken, map[string]any{}, nil)
			}
		}
		for _, id := range list {
			done("room", id)
		}
	}

	for _, id := range ids("group") {
		if g := s.groupIn(org, id, nil); g != nil && s.cfg.MailURL != "" {
			if err := s.groupDeleteMail(ctx, g); err != nil {
				return err
			}
		}
		s.w.Exec(`DELETE FROM mail_groups WHERE id = ? AND org_id = ?`, id, org)
		done("group", id)
	}

	// Documents, files, pictures and rooms, in one transaction. Things
	// people filed in an example folder move to the top level first.
	docs, nodes, blobs := ids("doc"), ids("node"), ids("blob")
	tx, err := s.w.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	exec := func(q string, args ...any) {
		if err == nil {
			_, err = tx.Exec(q, args...)
		}
	}
	isItem := `SELECT id FROM example_items WHERE org_id = ?1 AND kind = ?2`
	exec(`UPDATE nodes SET parent_id = '' WHERE org_id = ?1 AND parent_id IN (`+isItem+`) AND id NOT IN (`+isItem+`)`, org, "node")
	exec(`UPDATE docs SET folder_id = '' WHERE org_id = ?1 AND folder_id IN (`+strings.ReplaceAll(isItem, "?2", "'node'")+`) AND id NOT IN (`+strings.ReplaceAll(isItem, "?2", "'doc'")+`)`, org)
	for _, q := range []string{
		`DELETE FROM doc_updates WHERE doc_id IN (` + isItem + `)`,
		`DELETE FROM doc_versions WHERE doc_id IN (` + isItem + `)`,
		`DELETE FROM doc_editors WHERE doc_id IN (` + isItem + `)`,
		`DELETE FROM docs WHERE org_id = ?1 AND id IN (` + isItem + `)`,
	} {
		exec(q, org, "doc")
	}
	exec(`DELETE FROM nodes WHERE org_id = ?1 AND id IN (`+isItem+`)`, org, "node")
	exec(`DELETE FROM blobs WHERE org_id = ?1 AND id IN (`+isItem+`)`, org, "blob")
	exec(`DELETE FROM meetings WHERE org_id = ?1 AND code IN (`+isItem+`)`, org, "meeting")
	exec(`DELETE FROM example_items WHERE org_id = ? AND kind IN ('doc', 'node', 'blob', 'meeting')`, org)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.hub.evict(docs)
	for _, id := range nodes {
		os.Remove(s.filePath(id))
	}
	for _, id := range blobs {
		os.Remove(filepath.Join(s.cfg.DataDir, "blobs", id))
	}

	// Last, the example colleagues. Anything else they own passes to by.
	for _, id := range ids("user") {
		if u := s.userByID(id); u != nil && u.OrgID == org {
			s.w.Exec(`UPDATE docs SET owner_id = ? WHERE owner_id = ?`, by.ID, id)
			s.w.Exec(`UPDATE meetings SET owner_id = ? WHERE owner_id = ?`, by.ID, id)
			s.w.Exec(`UPDATE nodes SET owner_id = ? WHERE owner_id = ?`, by.ID, id)
			if _, err := s.w.Exec(`DELETE FROM users WHERE id = ? AND example = 1`, id); err != nil {
				return err
			}
			s.dropPhoto(id)
			s.chatDeactivate(u)
			s.mailDeleteAccount(u)
		}
		done("user", id)
	}
	s.w.Exec(`UPDATE orgs SET example = 0 WHERE id = ?`, org)
	s.refreshPolicies(org)
	return nil
}
