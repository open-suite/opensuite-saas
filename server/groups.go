package main

// Groups: shared mailboxes with an address of their own, like sales@ or
// support@. Anyone may write to one, people outside the organisation
// included, unless an administrator narrows that down. Its members read it,
// and depending on their role answer from it:
//
//   viewer  reads the group's mail and marks it read
//   user    also writes, files, deletes and sends as the group
//   admin   also adds and removes viewers and users and renames the group
//
// The organisation's administrators create and delete groups, appoint group
// admins and can manage every group. Members can be people or agents.
//
// In the mail engine a group is an account of type Group with its own
// folders. The engine gives the group's members full use of that account
// with their own credentials, sending from its address included: that is how
// users and group admins reach it. Viewers are not members; the group's
// folders are shared with them read-only. So the engine enforces every role
// itself, and the mail proxy, which picks the account a request works in
// (mailAccount), also refuses what a role may not do before the engine sees
// it (groupCallOK), for the app and the API alike.
//
// Who may write to a group is a Sieve script on its account (groupPolicy).

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

const schemaGroups = `
CREATE TABLE IF NOT EXISTS mail_groups(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  posting TEXT NOT NULL DEFAULT 'anyone',
  mail_id TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_groups_org ON mail_groups(org_id);
CREATE TABLE IF NOT EXISTS mail_group_members(
  group_id TEXT NOT NULL REFERENCES mail_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY(group_id, user_id)
) WITHOUT ROWID;
`

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		_, err := w.Exec(schemaGroups)
		return err
	})
}

var (
	groupRoles   = []string{"viewer", "user", "admin"}
	postingRules = []string{"anyone", "organisation", "members"}
)

type Group struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Email       string        `json:"email"`
	Description string        `json:"description"`
	Posting     string        `json:"posting"`
	Created     int64         `json:"created"`
	Members     []GroupMember `json:"members"`
	// As the caller sees it: their role, and for members the mailbox's
	// account id, which names the group in the mail engine's change feed.
	Role      string `json:"role,omitempty"`
	AccountID string `json:"accountId,omitempty"`

	orgID, mailID string
}

type GroupMember struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}

func (g *Group) roleOf(userID string) string {
	for _, m := range g.Members {
		if m.ID == userID {
			return m.Role
		}
	}
	return ""
}

// The marks a member leaves on a group's messages, so the others can see who
// read and who answered. They are keywords in the engine; a viewer may set
// only their own read mark. Between members they are a courtesy, not proof.
func readMark(userID string) string  { return "os-read-" + userID }
func replyMark(userID string) string { return "os-replied-" + userID }

// orgGroups lists an organisation's groups with their members, as viewer sees
// them (nil for no particular viewer).
func (s *Server) orgGroups(orgID string, viewer *User) []Group {
	out := []Group{}
	rows, err := s.r.Query(`SELECT id, org_id, email, name, description, posting, mail_id, created FROM mail_groups WHERE org_id = ? ORDER BY name COLLATE NOCASE`, orgID)
	if err != nil {
		return out
	}
	byID := map[string]int{}
	for rows.Next() {
		var g Group
		rows.Scan(&g.ID, &g.orgID, &g.Email, &g.Name, &g.Description, &g.Posting, &g.mailID, &g.Created)
		g.Members = []GroupMember{}
		byID[g.ID] = len(out)
		out = append(out, g)
	}
	rows.Close()
	rows, err = s.r.Query(`SELECT m.group_id, m.user_id, m.role FROM mail_group_members m JOIN mail_groups g ON g.id = m.group_id
		JOIN users u ON u.id = m.user_id WHERE g.org_id = ? ORDER BY u.name COLLATE NOCASE`, orgID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var gid string
		var m GroupMember
		rows.Scan(&gid, &m.ID, &m.Role)
		if i, found := byID[gid]; found {
			out[i].Members = append(out[i].Members, m)
		}
	}
	if viewer != nil {
		for i := range out {
			if out[i].Role = out[i].roleOf(viewer.ID); out[i].Role != "" {
				out[i].AccountID = out[i].mailID
			}
		}
	}
	return out
}

// groupIn finds one of the organisation's groups by id or address.
func (s *Server) groupIn(orgID, key string, viewer *User) *Group {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, g := range s.orgGroups(orgID, viewer) {
		if g.ID == key || strings.ToLower(g.Email) == key {
			return &g
		}
	}
	return nil
}

// mayManage: organisation administrators manage every group, group admins
// their own.
func mayManage(u *User, g *Group) bool { return u.isAdmin() || g.Role == "admin" }

// --- which mailbox a mail request works in ------------------------------------

type mailAccount struct {
	ID, Email, Name string
	Group, Role     string // for a group's mailbox: its id and the caller's role in it
}

func ownMailbox(u *User) *mailAccount {
	return &mailAccount{ID: u.MailID, Email: u.Email, Name: u.Name}
}

func (a *mailAccount) maySend() bool { return a.Group == "" || a.Role != "viewer" }

const viewerRefused = "As a viewer of this group you can read its mail, but not send or change it."

// mailAccount is the mailbox a mail request works in: the caller's own, or
// with ?group= (an id or an address) a group's they belong to. Every mail
// endpoint, the app's and the API's, goes through here.
func (s *Server) mailAccount(r *http.Request, u *User) (*mailAccount, int, string) {
	key := r.URL.Query().Get("group")
	if key == "" {
		return ownMailbox(u), 0, ""
	}
	g := s.groupIn(u.OrgID, key, u)
	if g == nil || g.Role == "" {
		return nil, 404, "No such group, or you are not one of its members."
	}
	return &mailAccount{ID: g.mailID, Email: g.Email, Name: g.Name, Group: g.ID, Role: g.Role}, 0, ""
}

// In a group's mailbox a viewer reads and marks what they have read; users
// and group admins also write, file, delete and send. Nobody changes the
// group's folders, identity, filters or settings there, imports into it or
// uses its calendars: those are not part of a shared inbox.
var (
	groupReading = []string{"Mailbox/get", "Mailbox/changes", "Mailbox/query", "Mailbox/queryChanges", "Email/get", "Email/changes",
		"Email/query", "Email/queryChanges", "Thread/get", "Thread/changes", "SearchSnippet/get", "Core/echo"}
	groupWriting = []string{"Email/set", "Identity/get", "EmailSubmission/get", "EmailSubmission/changes", "EmailSubmission/query",
		"EmailSubmission/queryChanges", "EmailSubmission/set"}
)

func groupCallOK(role, userID, name string, args map[string]json.RawMessage) bool {
	if slices.Contains(groupReading, name) {
		return true
	}
	if role != "viewer" {
		return slices.Contains(groupWriting, name)
	}
	if name != "Email/set" || args["create"] != nil || args["destroy"] != nil {
		return false
	}
	var updates map[string]map[string]json.RawMessage
	if json.Unmarshal(args["update"], &updates) != nil {
		return false
	}
	for _, patch := range updates {
		for k := range patch {
			if k != "keywords/$seen" && k != "keywords/"+readMark(userID) {
				return false
			}
		}
	}
	return true
}

// groupCallsOK vets a whole request for a group's mailbox.
func groupCallsOK(acct *mailAccount, userID string, calls [][]json.RawMessage) bool {
	if acct.Group == "" {
		return true
	}
	for _, c := range calls {
		var name string
		var args map[string]json.RawMessage
		if json.Unmarshal(c[0], &name) != nil || json.Unmarshal(c[1], &args) != nil || !groupCallOK(acct.Role, userID, name, args) {
			return false
		}
	}
	return true
}

// --- the mail engine ------------------------------------------------------------

var jmapGroupAdmin = []string{"urn:ietf:params:jmap:core", "urn:stalwart:jmap", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:mail:share",
	"urn:ietf:params:jmap:blob", "urn:ietf:params:jmap:sieve"}

func (s *Server) groupEngine(ctx context.Context, calls ...jmapCall) ([]jmapResult, error) {
	return s.jmapAdminUsing(ctx, s.cfg.MailURL, jmapGroupAdmin, calls...)
}

// groupCreateMail makes the group's account and gives it the standard
// folders, so no member ever needs to create one there.
func (s *Server) groupCreateMail(ctx context.Context, local, domain, name string) (string, error) {
	domID, err := s.mailDomainID(ctx, s.cfg.MailURL, domain, false)
	if err != nil {
		return "", err
	}
	res, err := s.groupEngine(ctx, jmapCall{"x:Account/set", map[string]any{"create": map[string]any{"g": map[string]any{
		"@type": "Group", "name": local, "domainId": domID, "description": name}}}})
	if err != nil {
		return "", err
	}
	var sr setResult
	json.Unmarshal(res[0].Args, &sr)
	id := sr.Created["g"].ID
	if id == "" {
		return "", errf("mail engine refused the group %s@%s: %s", local, domain, res[0].Args)
	}
	res, err = s.groupEngine(ctx, jmapCall{"Mailbox/get", map[string]any{"accountId": id, "properties": []string{"role"}}})
	if err != nil {
		return id, err
	}
	var g struct {
		List []struct{ Role string } `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	create := map[string]any{}
	for role, label := range roleNames {
		if !slices.ContainsFunc(g.List, func(b struct{ Role string }) bool { return b.Role == role }) {
			create[role] = map[string]string{"name": label, "role": role}
		}
	}
	if len(create) > 0 {
		res, err = s.groupEngine(ctx, jmapCall{"Mailbox/set", map[string]any{"accountId": id, "create": create}})
		if err != nil {
			return id, err
		}
		if json.Unmarshal(res[0].Args, &sr); len(sr.NotCreated) > 0 {
			return id, errf("mail engine refused the group's folders: %s", res[0].Args)
		}
	}
	return id, nil
}

// groupAccess gives a member the access their role needs and takes away
// what it does not: users and admins are members of the engine's group,
// viewers see its folders read-only.
func (s *Server) groupAccess(ctx context.Context, g *Group, u *User, role string) error {
	var member any // null removes the membership
	if role == "user" || role == "admin" {
		member = true
	}
	res, err := s.groupEngine(ctx,
		jmapCall{"x:Account/set", map[string]any{"update": map[string]any{u.MailID: map[string]any{"memberGroupIds/" + g.mailID: member}}}},
		jmapCall{"Mailbox/get", map[string]any{"accountId": g.mailID, "properties": []string{"id"}}},
	)
	if err != nil {
		return err
	}
	var sr setResult
	if json.Unmarshal(res[0].Args, &sr); len(sr.NotUpdated) > 0 {
		return errf("mail engine refused the membership: %s", res[0].Args)
	}
	var boxes struct {
		List []struct{ ID string } `json:"list"`
	}
	json.Unmarshal(res[1].Args, &boxes)
	var share any
	if role == "viewer" {
		share = map[string]bool{"mayReadItems": true, "maySetSeen": true}
	}
	update := map[string]any{}
	for _, b := range boxes.List {
		update[b.ID] = map[string]any{"shareWith/" + u.MailID: share}
	}
	res, err = s.groupEngine(ctx, jmapCall{"Mailbox/set", map[string]any{"accountId": g.mailID, "update": update}})
	if err != nil {
		return err
	}
	if json.Unmarshal(res[0].Args, &sr); len(sr.NotUpdated) > 0 {
		return errf("mail engine refused to share the group's folders: %s", res[0].Args)
	}
	return nil
}

// groupPolicy writes who may send to the group as a Sieve script on its
// account. Mail from other providers carries the Authentication-Results
// header the engine adds at the border; mail from this installation does
// not, and its envelope sender is the authenticated account's own address.
// Restricted groups drop mail from outside without a bounce, so spam with
// forged senders makes no backscatter; a colleague who may not write gets a
// bounce that says why.
func (s *Server) groupPolicy(ctx context.Context, g *Group) error {
	policyMu.Lock()
	defer policyMu.Unlock()
	return s.writePolicy(ctx, g)
}

// policyMu lets one writer at a time at the scripts: the engine refuses an
// edit that overlaps another, and a later write must see the latest members.
var policyMu sync.Mutex

func (s *Server) writePolicy(ctx context.Context, g *Group) error {
	res, err := s.groupEngine(ctx, jmapCall{"SieveScript/get", map[string]any{"accountId": g.mailID, "properties": []string{"name", "isActive"}}})
	if err != nil {
		return err
	}
	var scripts struct {
		List []struct {
			ID, Name string
			IsActive bool
		} `json:"list"`
	}
	json.Unmarshal(res[0].Args, &scripts)
	id, active := "", false
	for _, sc := range scripts.List {
		if sc.Name == "opensuite" {
			id, active = sc.ID, sc.IsActive
		}
	}
	if g.Posting == "anyone" {
		if active {
			_, err = s.groupEngine(ctx, jmapCall{"SieveScript/set", map[string]any{"accountId": g.mailID, "onSuccessDeactivateScript": true}})
		}
		return err
	}
	set := map[string]any{"accountId": g.mailID, "create": map[string]any{"s": map[string]string{"name": "opensuite", "blobId": "#b"}}, "onSuccessActivateScript": "#s"}
	if id != "" {
		set = map[string]any{"accountId": g.mailID, "update": map[string]any{id: map[string]string{"blobId": "#b"}}, "onSuccessActivateScript": id}
	}
	res, err = s.groupEngine(ctx,
		jmapCall{"Blob/upload", map[string]any{"accountId": g.mailID, "create": map[string]any{"b": map[string]any{
			"data": []map[string]string{{"data:asText": s.groupScript(g)}}, "type": "application/sieve"}}}},
		jmapCall{"SieveScript/set", set},
	)
	if err != nil {
		return err
	}
	var sr setResult
	if json.Unmarshal(res[1].Args, &sr); len(sr.NotCreated) > 0 || len(sr.NotUpdated) > 0 {
		return errf("mail engine refused the group's filter: %s", res[1].Args)
	}
	return nil
}

func (s *Server) groupScript(g *Group) string {
	allowed := []string{g.Email}
	why := "Only members of " + g.Email + " may write to it."
	if g.Posting == "members" {
		for _, m := range g.Members {
			if u := s.userByID(m.ID); u != nil {
				allowed = append(allowed, u.Email)
			}
		}
	} else {
		var org string
		s.r.QueryRow(`SELECT name FROM orgs WHERE id = ?`, g.orgID).Scan(&org)
		why = "Only people in " + strings.NewReplacer(`"`, "", `\`, "").Replace(org) + " may write to " + g.Email + "."
		for _, p := range s.people(g.orgID) {
			allowed = append(allowed, p.Email)
		}
		for _, other := range s.orgGroups(g.orgID, nil) {
			allowed = append(allowed, other.Email)
		}
	}
	// Addresses are made only of letters, digits, dots, dashes and @.
	return "require [\"envelope\", \"reject\"];\n" +
		"# Written by Open Suite: who may write to " + g.Email + " (" + g.Posting + ").\n" +
		"if exists \"Authentication-Results\" { discard; stop; }\n" +
		"if envelope :is \"from\" \"\" { stop; }\n" +
		"if not envelope :comparator \"i;unicode-casemap\" :is \"from\" [\"" + strings.Join(allowed, "\", \"") + "\"] {\n" +
		"  reject \"" + why + "\";\n}\n"
}

// refreshPolicies rewrites the scripts of an organisation's restricted
// groups after its people or a group's members change.
func (s *Server) refreshPolicies(orgID string) {
	if s.cfg.MailURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	policyMu.Lock()
	defer policyMu.Unlock()
	for _, g := range s.orgGroups(orgID, nil) {
		if g.Posting != "anyone" {
			if err := s.writePolicy(ctx, &g); err != nil {
				log.Printf("groups: %s: %v", g.Email, err)
			}
		}
	}
}

// groupDeleteMail closes the group's account and its mail. The engine keeps
// a group that still has members, so their memberships go first, in the
// same call (updates are applied before deletions).
func (s *Server) groupDeleteMail(ctx context.Context, g *Group) error {
	leave := map[string]any{}
	for _, m := range g.Members {
		if u := s.userByID(m.ID); u != nil && m.Role != "viewer" {
			leave[u.MailID] = map[string]any{"memberGroupIds/" + g.mailID: nil}
		}
	}
	res, err := s.groupEngine(ctx, jmapCall{"x:Account/set", map[string]any{"update": leave, "destroy": []string{g.mailID}}})
	if err != nil {
		return err
	}
	var sr setResult
	if json.Unmarshal(res[0].Args, &sr); len(sr.NotDestroyed) > 0 {
		return errf("mail engine refused to delete the group: %s", res[0].Args)
	}
	return nil
}

// --- the operations -------------------------------------------------------------

func (s *Server) groupOps() []*apiOp {
	id := pathParam("id", "Group id, or its address.")
	member := pathParam("member", "Member id, or their address.")
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/groups", ID: "list_groups", Tag: "Groups", Summary: "List the organisation's groups",
			Desc: "Every group (shared mailbox such as sales@) with its members and their roles, and your own role in each. " +
				"To read or answer a group's mail, pass its id as `group` to the mail operations.",
			Params: append([]apiParam{query("q", str("Only groups whose name or address contains this."))}, pageParams...), Result: list(ref("Group")), H: s.handleGroups},
		{Method: "GET", Path: "/api/v1/groups/{id}", ID: "get_group", Tag: "Groups", Summary: "Get a group",
			Params: []apiParam{id}, Result: ref("Group"), H: s.handleGroup},
		{Method: "POST", Path: "/api/v1/groups", ID: "create_group", Tag: "Groups", Summary: "Create a group", Admin: true, Write: true,
			Desc: "A shared mailbox with an address on one of the organisation's mail domains. Add members with set_group_member.",
			Body: object(js{
				"name":        str("Display name, e.g. \"Sales\". Mail from the group is sent under this name."),
				"username":    str("The part of the address before @: 3 to 32 lowercase letters, digits, dots or dashes."),
				"domain":      str("A mail domain of the organisation; default is the installation's."),
				"description": str("What the group is for."),
				"posting":     enum(postingHelp, postingRules...),
			}, "name", "username"),
			Result: ref("Group"), H: s.handleGroupCreate},
		{Method: "PATCH", Path: "/api/v1/groups/{id}", ID: "update_group", Tag: "Groups", Summary: "Rename a group, or change its description or who may write to it", Write: true,
			Desc:   "Organisation administrators and the group's admins.",
			Params: []apiParam{id},
			Body:   object(js{"name": str(""), "description": str(""), "posting": enum(postingHelp, postingRules...)}),
			Result: ref("Group"), H: s.handleGroupUpdate},
		{Method: "DELETE", Path: "/api/v1/groups/{id}", ID: "delete_group", Tag: "Groups", Summary: "Delete a group and its mail", Admin: true, Write: true,
			Params: []apiParam{id}, Result: okResult, H: s.handleGroupDelete},
		{Method: "PUT", Path: "/api/v1/groups/{id}/members/{member}", ID: "set_group_member", Tag: "Groups", Summary: "Add a member to a group or change their role", Write: true,
			Desc: "viewer reads the group's mail; user also sends and replies as the group; admin also manages viewers and users. " +
				"Group admins add, remove and change viewers and users; only organisation administrators appoint or change group admins.",
			Params: []apiParam{id, member},
			Body:   object(js{"role": enum("", groupRoles...)}, "role"),
			Result: ref("Group"), H: s.handleGroupMemberSet},
		{Method: "DELETE", Path: "/api/v1/groups/{id}/members/{member}", ID: "remove_group_member", Tag: "Groups", Summary: "Remove a member from a group", Write: true,
			Desc:   "Same rules as set_group_member.",
			Params: []apiParam{id, member}, Result: ref("Group"), H: s.handleGroupMemberRemove},
	}
}

const postingHelp = "Who may send mail to the group: anyone (default, people outside the organisation included), " +
	"organisation (its people and groups only) or members (the group's members only)."

func (s *Server) handleGroups(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query().Get("q")
	out := []Group{}
	for _, g := range s.orgGroups(u.OrgID, u) {
		if matches(q, g.Name, g.Email) {
			out = append(out, g)
		}
	}
	ok(w, page(r, out))
}

func (s *Server) handleGroup(w http.ResponseWriter, r *http.Request, u *User) {
	if g := s.groupIn(u.OrgID, r.PathValue("id"), u); g != nil {
		ok(w, g)
		return
	}
	fail(w, 404, "No such group.")
}

func (s *Server) handleGroupCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Name, Username, Domain, Description, Posting string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	in.Name, in.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Description)
	in.Username, in.Domain = strings.ToLower(strings.TrimSpace(in.Username)), strings.ToLower(strings.TrimSpace(in.Domain))
	if in.Name == "" {
		fail(w, 400, "Enter the group's name.")
		return
	}
	if msg := validUsername(in.Username); msg != "" {
		fail(w, 400, msg)
		return
	}
	if in.Domain == "" {
		in.Domain = s.cfg.MailDomain
	}
	if !slices.Contains(s.mailDomainsFor(u.OrgID), in.Domain) {
		fail(w, 400, "That domain isn't verified for mail yet.")
		return
	}
	if in.Posting == "" {
		in.Posting = "anyone"
	}
	if !slices.Contains(postingRules, in.Posting) {
		fail(w, 400, "posting is anyone, organisation or members.")
		return
	}
	var plan string
	var count int
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&plan)
	s.r.QueryRow(`SELECT count(*) FROM mail_groups WHERE org_id = ?`, u.OrgID).Scan(&count)
	if lim := planFor(plan); count >= lim.MaxGroups {
		fail(w, 402, "Your plan includes "+itoa(lim.MaxGroups)+" groups. Upgrade to add more.")
		return
	}
	email := in.Username + "@" + in.Domain
	if s.addressTaken(email) {
		fail(w, 409, "That address is taken.")
		return
	}
	if s.cfg.MailURL == "" {
		fail(w, 503, "Mail is not set up on this server.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	mailID, err := s.groupCreateMail(ctx, in.Username, in.Domain, in.Name)
	if err != nil {
		log.Printf("groups: creating %s: %v", email, err)
		if mailID != "" {
			s.groupDeleteMail(ctx, &Group{mailID: mailID})
		}
		fail(w, 502, "The mail service could not create the group. Try again in a minute.")
		return
	}
	g := &Group{ID: newID(12), orgID: u.OrgID, Email: email, Name: in.Name, Description: in.Description, Posting: in.Posting, mailID: mailID}
	if _, err := s.w.Exec(`INSERT INTO mail_groups(id, org_id, email, name, description, posting, mail_id, created) VALUES(?,?,?,?,?,?,?,?)`,
		g.ID, g.orgID, g.Email, g.Name, g.Description, g.Posting, g.mailID, now()); err != nil {
		s.groupDeleteMail(ctx, g)
		fail(w, 409, "That address is taken.")
		return
	}
	if g.Posting != "anyone" {
		if err := s.groupPolicy(ctx, g); err != nil {
			log.Printf("groups: %s: %v", g.Email, err)
		}
	}
	go s.refreshPolicies(u.OrgID) // the organisation's groups may write to one another
	ok(w, s.groupIn(u.OrgID, g.ID, u))
}

// managedGroup finds the group a management request names and checks the
// caller may manage it. Someone who cannot even see the group gets a 404.
func (s *Server) managedGroup(w http.ResponseWriter, r *http.Request, u *User) *Group {
	g := s.groupIn(u.OrgID, r.PathValue("id"), u)
	if g == nil {
		fail(w, 404, "No such group.")
		return nil
	}
	if !mayManage(u, g) {
		fail(w, 403, "Only the group's admins and the organisation's administrators can manage it.")
		return nil
	}
	return g
}

func (s *Server) handleGroupUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	g := s.managedGroup(w, r, u)
	if g == nil {
		return
	}
	var in struct{ Name, Description, Posting *string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.Posting != nil && !slices.Contains(postingRules, *in.Posting) {
		fail(w, 400, "posting is anyone, organisation or members.")
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		fail(w, 400, "Enter the group's name.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if in.Name != nil {
		g.Name = strings.TrimSpace(*in.Name)
		if _, err := s.groupEngine(ctx, jmapCall{"x:Account/set", map[string]any{"update": map[string]any{g.mailID: map[string]any{"description": g.Name}}}}); err != nil {
			log.Printf("groups: renaming %s: %v", g.Email, err)
		}
	}
	if in.Description != nil {
		g.Description = strings.TrimSpace(*in.Description)
	}
	if in.Posting != nil && *in.Posting != g.Posting {
		g.Posting = *in.Posting
		if err := s.groupPolicy(ctx, g); err != nil {
			log.Printf("groups: %s: %v", g.Email, err)
			fail(w, 502, "The mail service could not change who may write to the group. Try again in a minute.")
			return
		}
	}
	s.w.Exec(`UPDATE mail_groups SET name = ?, description = ?, posting = ? WHERE id = ?`, g.Name, g.Description, g.Posting, g.ID)
	ok(w, s.groupIn(u.OrgID, g.ID, u))
}

func (s *Server) handleGroupDelete(w http.ResponseWriter, r *http.Request, u *User) {
	g := s.groupIn(u.OrgID, r.PathValue("id"), u)
	if g == nil {
		fail(w, 404, "No such group.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.groupDeleteMail(ctx, g); err != nil {
		log.Printf("groups: deleting %s: %v", g.Email, err)
		fail(w, 502, "The mail service could not delete the group. Try again in a minute.")
		return
	}
	s.w.Exec(`DELETE FROM mail_groups WHERE id = ?`, g.ID)
	go s.refreshPolicies(u.OrgID)
	ok(w, map[string]bool{"ok": true})
}

// memberChange checks a change to a group's membership. Group admins look
// after viewers and users; group admins are the organisation's to appoint.
func (s *Server) memberChange(w http.ResponseWriter, r *http.Request, u *User, role string) (*Group, *User) {
	g := s.managedGroup(w, r, u)
	if g == nil {
		return nil, nil
	}
	p := s.personIn(u.OrgID, r.PathValue("member"))
	if p == nil {
		fail(w, 404, "No such person in your organisation.")
		return nil, nil
	}
	if !u.isAdmin() && (role == "admin" || g.roleOf(p.ID) == "admin") {
		fail(w, 403, "Only the organisation's administrators appoint or change a group's admins.")
		return nil, nil
	}
	t := s.userByID(p.ID)
	if !t.MailReady {
		fail(w, 409, t.Name+"'s mailbox is still being set up. Try again in a minute.")
		return nil, nil
	}
	return g, t
}

func (s *Server) handleGroupMemberSet(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Role string }
	if readJSON(r, &in) != nil || !slices.Contains(groupRoles, in.Role) {
		fail(w, 400, "role is viewer, user or admin.")
		return
	}
	g, t := s.memberChange(w, r, u, in.Role)
	if g == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.groupAccess(ctx, g, t, in.Role); err != nil {
		log.Printf("groups: %s in %s: %v", t.Email, g.Email, err)
		fail(w, 502, "The mail service could not change the membership. Try again in a minute.")
		return
	}
	s.w.Exec(`INSERT INTO mail_group_members(group_id, user_id, role) VALUES(?,?,?) ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role`, g.ID, t.ID, in.Role)
	s.memberChanged(g)
	ok(w, s.groupIn(u.OrgID, g.ID, u))
}

func (s *Server) handleGroupMemberRemove(w http.ResponseWriter, r *http.Request, u *User) {
	g, t := s.memberChange(w, r, u, "")
	if g == nil {
		return
	}
	if g.roleOf(t.ID) == "" {
		fail(w, 404, t.Name+" is not a member of this group.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.groupAccess(ctx, g, t, ""); err != nil {
		log.Printf("groups: removing %s from %s: %v", t.Email, g.Email, err)
		fail(w, 502, "The mail service could not change the membership. Try again in a minute.")
		return
	}
	s.w.Exec(`DELETE FROM mail_group_members WHERE group_id = ? AND user_id = ?`, g.ID, t.ID)
	s.memberChanged(g)
	ok(w, s.groupIn(u.OrgID, g.ID, u))
}

func (s *Server) memberChanged(g *Group) {
	if g.Posting == "members" {
		go s.refreshPolicies(g.orgID)
	}
}
