package main

import (
	"context"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

type Domain struct {
	Domain string `json:"domain"`
	// Included marks the organisation's own subdomain (orgdomain.go).
	Included bool         `json:"included,omitempty"`
	WebOK    bool         `json:"webOk"`
	MailOK  bool         `json:"mailOk"`
	Records []DNSRecord  `json:"records"`
	Created int64        `json:"created"`
	Checks  []DomainNote `json:"checks,omitempty"`
}

type DNSRecord struct {
	Purpose string `json:"purpose"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Value   string `json:"value"`
}

type DomainNote struct {
	OK   bool   `json:"ok"`
	Text string `json:"text"`
}

var domainRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$`)

func (s *Server) orgDomains(orgID string) []Domain {
	out := []Domain{}
	rows, err := s.r.Query(`SELECT domain, web_ok, mail_ok, dkim, created, kind FROM domains WHERE org_id = ? ORDER BY kind = 'org' DESC, created`, orgID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var d Domain
		var dkim, kind string
		rows.Scan(&d.Domain, &d.WebOK, &d.MailOK, &dkim, &d.Created, &kind)
		// The organisation's own subdomain needs nothing published.
		d.Included = kind == "org"
		d.Records = []DNSRecord{}
		if !d.Included {
			d.Records = s.domainRecords(orgID, d.Domain, dkim)
		}
		out = append(out, d)
	}
	return out
}

// domainRecords lists what a customer must publish. Web access needs only the
// first record; mail needs the rest.
func (s *Server) domainRecords(orgID, domain, dkim string) []DNSRecord {
	recs := []DNSRecord{
		{"Open the suite at this address", "CNAME", domain, s.cfg.Domain},
		{"Prove you own the domain (mail)", "TXT", domain, "opensuite-verify=" + orgID},
		{"Receive mail", "MX", domain, "10 " + s.cfg.MailHost},
		{"Authorise sending (SPF)", "TXT", domain, "v=spf1 mx include:" + s.cfg.MailDomain + " ~all"},
	}
	for _, line := range strings.Split(dkim, "\n") {
		if name, value, found := strings.Cut(line, "\t"); found {
			recs = append(recs, DNSRecord{"Sign outgoing mail (DKIM)", "TXT", name, value})
		}
	}
	recs = append(recs, DNSRecord{"Reject forgeries (DMARC)", "TXT", "_dmarc." + domain, "v=DMARC1; p=quarantine"})
	return recs
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request, u *User) {
	var plan string
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&plan)
	ok(w, map[string]any{
		"people":  s.people(u.OrgID),
		"domains": s.orgDomains(u.OrgID),
		"usage":   map[string]any{"storage": s.orgUsage(u.OrgID), "files": s.orgFileBytes(u.OrgID)},
		"limits":  planFor(plan),
		"plan":    plan,
	})
}

func (s *Server) handleOrgUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Name string }
	if readJSON(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
		fail(w, 400, "Enter a name.")
		return
	}
	s.w.Exec(`UPDATE orgs SET name = ? WHERE id = ?`, strings.TrimSpace(in.Name), u.OrgID)
	ok(w, map[string]bool{"ok": true})
}

func tempPassword() string { return newID(4) + "-" + newID(4) + "-" + newID(4) }

// handleUserCreate adds a person, or with "agent" an agent member. An agent
// counts towards the plan's people limit like anyone else: it has a mailbox,
// storage and a chat account, which is what the limit is about.
func (s *Server) handleUserCreate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Name, Username, Domain, Role string
		Agent                        bool
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	in.Name, in.Username, in.Domain = strings.TrimSpace(in.Name), strings.ToLower(strings.TrimSpace(in.Username)), strings.ToLower(in.Domain)
	if in.Name == "" {
		fail(w, 400, "Enter the person's name.")
		return
	}
	domains := s.mailDomainsFor(u.OrgID)
	if in.Domain == "" {
		in.Domain = domains[0]
	}
	if !slices.Contains(domains, in.Domain) {
		fail(w, 400, "That domain isn't verified for mail yet.")
		return
	}
	if msg := validLocalPart(in.Username, in.Domain == s.cfg.MailDomain); msg != "" {
		fail(w, 400, msg)
		return
	}
	if in.Role != "admin" {
		in.Role = "member"
	}
	var plan string
	var count int
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&plan)
	s.r.QueryRow(`SELECT count(*) FROM users WHERE org_id = ?`, u.OrgID).Scan(&count)
	if lim := planFor(plan); count >= lim.MaxUsers {
		fail(w, 402, "Your plan includes "+itoa(lim.MaxUsers)+" people. Upgrade to add more.")
		return
	}
	email := in.Username + "@" + in.Domain
	if s.addressTaken(email) {
		fail(w, 409, "That address is taken.")
		return
	}
	id := newID(12)
	if in.Agent {
		// No password at all: an empty hash never matches one.
		_, err := s.w.Exec(`INSERT INTO users(id, org_id, email, name, role, kind, pw_hash, mx_local, mail_secret, created) VALUES(?,?,?,?,?,'agent','',?,?,?)`,
			id, u.OrgID, email, in.Name, in.Role, s.mxLocalFor(email), newToken(), now())
		if err != nil {
			fail(w, 409, "That address is taken.")
			return
		}
		go s.joined(s.userByID(id))
		ok(w, map[string]any{"id": id, "email": email, "agent": true})
		return
	}
	pw := tempPassword()
	_, err := s.w.Exec(`INSERT INTO users(id, org_id, email, name, role, pw_hash, must_change, mx_local, mail_secret, created) VALUES(?,?,?,?,?,?,1,?,?,?)`,
		id, u.OrgID, email, in.Name, in.Role, hashPassword(pw), s.mxLocalFor(email), newToken(), now())
	if err != nil {
		fail(w, 409, "That address is taken.")
		return
	}
	go s.joined(s.userByID(id))
	ok(w, map[string]any{"id": id, "email": email, "password": pw})
}

// joined sets up a new member's mailbox and chat account, then lets the
// organisation's groups that only take mail from inside hear from them.
func (s *Server) joined(u *User) {
	s.provision(u)
	s.refreshPolicies(u.OrgID)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func (s *Server) ownerCount(orgID string) int {
	var n int
	s.r.QueryRow(`SELECT count(*) FROM users WHERE org_id = ? AND role = 'owner' AND status = 'active'`, orgID).Scan(&n)
	return n
}

func (s *Server) handleUserUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	t := s.userByID(r.PathValue("id"))
	if t == nil || t.OrgID != u.OrgID {
		fail(w, 404, "No such person.")
		return
	}
	if t.Role == "owner" && u.Role != "owner" {
		fail(w, 403, "Only an owner can change an owner.")
		return
	}
	var in struct {
		Name          *string
		Role          *string
		Status        *string
		ResetPassword bool
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if in.ResetPassword && t.isAgent() {
		fail(w, 409, "Agents have no password. They sign in with API tokens.")
		return
	}
	lastOwner := t.Role == "owner" && s.ownerCount(u.OrgID) <= 1
	if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
		t.Name = strings.TrimSpace(*in.Name)
		s.w.Exec(`UPDATE users SET name = ? WHERE id = ?`, t.Name, t.ID)
		go s.chatSetName(t)
	}
	if in.Role != nil && *in.Role != t.Role {
		role := *in.Role
		if role != "owner" && role != "admin" && role != "member" {
			fail(w, 400, "Unknown role.")
			return
		}
		if role == "owner" && u.Role != "owner" {
			fail(w, 403, "Only an owner can appoint an owner.")
			return
		}
		if role == "owner" && t.isAgent() {
			fail(w, 409, "An agent can be an administrator, not an owner.")
			return
		}
		if lastOwner {
			fail(w, 409, "An organisation needs at least one owner.")
			return
		}
		s.w.Exec(`UPDATE users SET role = ? WHERE id = ?`, role, t.ID)
	}
	if in.Status != nil && *in.Status != t.Status {
		if *in.Status != "active" && *in.Status != "suspended" {
			fail(w, 400, "Unknown status.")
			return
		}
		if *in.Status == "suspended" && (lastOwner || t.ID == u.ID) {
			fail(w, 409, "You can't suspend this account.")
			return
		}
		s.w.Exec(`UPDATE users SET status = ? WHERE id = ?`, *in.Status, t.ID)
		if *in.Status == "suspended" {
			s.w.Exec(`DELETE FROM sessions WHERE user_id = ?`, t.ID)
			go s.chatSignOut(t)
		}
	}
	out := map[string]any{"ok": true}
	if in.ResetPassword {
		pw := tempPassword()
		s.w.Exec(`UPDATE users SET pw_hash = ?, must_change = 1 WHERE id = ?`, hashPassword(pw), t.ID)
		s.w.Exec(`DELETE FROM sessions WHERE user_id = ?`, t.ID)
		out["password"] = pw
	}
	ok(w, out)
}

func (s *Server) handleUserDelete(w http.ResponseWriter, r *http.Request, u *User) {
	t := s.userByID(r.PathValue("id"))
	if t == nil || t.OrgID != u.OrgID {
		fail(w, 404, "No such person.")
		return
	}
	if t.ID == u.ID {
		fail(w, 409, "You can't delete your own account.")
		return
	}
	if t.Role == "owner" && (u.Role != "owner" || s.ownerCount(u.OrgID) <= 1) {
		fail(w, 403, "This owner can't be removed.")
		return
	}
	// Their documents stay with the organisation, owned by whoever removed them.
	s.w.Exec(`UPDATE docs SET owner_id = ? WHERE owner_id = ?`, u.ID, t.ID)
	s.w.Exec(`UPDATE meetings SET owner_id = ? WHERE owner_id = ?`, u.ID, t.ID)
	s.w.Exec(`DELETE FROM users WHERE id = ?`, t.ID)
	s.dropPhoto(t.ID)
	go s.chatDeactivate(t)
	go s.mailDeleteAccount(t)
	go s.refreshPolicies(u.OrgID)
	ok(w, map[string]bool{"ok": true})
}

// --- custom domains ---

func (s *Server) handleDomainAdd(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Domain string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	d := strings.ToLower(strings.TrimSpace(in.Domain))
	if !domainRe.MatchString(d) || d == s.cfg.Domain || d == s.cfg.MailDomain || strings.HasSuffix(d, "."+s.cfg.Domain) || s.underSuffix(d) {
		fail(w, 400, "Enter a domain you own, like example.com.")
		return
	}
	var plan string
	var count int
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&plan)
	s.r.QueryRow(`SELECT count(*) FROM domains WHERE org_id = ? AND kind = 'own'`, u.OrgID).Scan(&count)
	if lim := planFor(plan); count >= lim.Domains {
		fail(w, 402, "Your plan includes "+itoa(lim.Domains)+" custom domain(s).")
		return
	}
	// A claim nobody verified can be taken over; a verified one cannot.
	s.w.Exec(`DELETE FROM domains WHERE domain = ? AND web_ok = 0 AND mail_ok = 0 AND org_id != ?`, d, u.OrgID)
	if _, err := s.w.Exec(`INSERT INTO domains(domain, org_id, created) VALUES(?,?,?)`, d, u.OrgID, now()); err != nil {
		fail(w, 409, "That domain is already connected to an organisation.")
		return
	}
	ok(w, map[string]any{"domains": s.orgDomains(u.OrgID)})
}

func (s *Server) handleDomainDelete(w http.ResponseWriter, r *http.Request, u *User) {
	d := strings.ToLower(r.PathValue("domain"))
	if d == s.orgDomain(u.OrgID) {
		fail(w, 409, "This is your organisation's own address on Open Suite. It cannot be removed.")
		return
	}
	var n int
	s.r.QueryRow(`SELECT (SELECT count(*) FROM users WHERE org_id = ?1 AND email LIKE ?2) + (SELECT count(*) FROM mail_groups WHERE org_id = ?1 AND email LIKE ?2)`, u.OrgID, "%@"+d).Scan(&n)
	if n > 0 {
		fail(w, 409, "People or groups still have addresses on this domain. Remove them first.")
		return
	}
	res, _ := s.w.Exec(`DELETE FROM domains WHERE domain = ? AND org_id = ?`, d, u.OrgID)
	if c, _ := res.RowsAffected(); c > 0 {
		go s.mailDeleteDomain(d)
	}
	ok(w, map[string]any{"domains": s.orgDomains(u.OrgID)})
}

// handleDomainVerify looks at public DNS and switches on whatever the
// customer has finished setting up.
func (s *Server) handleDomainVerify(w http.ResponseWriter, r *http.Request, u *User) {
	d := strings.ToLower(r.PathValue("domain"))
	var n int
	s.r.QueryRow(`SELECT count(*) FROM domains WHERE domain = ? AND org_id = ? AND kind = 'own'`, d, u.OrgID).Scan(&n)
	if n == 0 {
		fail(w, 404, "No such domain.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	res := &net.Resolver{}
	var notes []DomainNote

	webOK := false
	if addrs, err := res.LookupHost(ctx, d); err == nil {
		for _, a := range addrs {
			if slices.Contains(s.cfg.PublicIPs, a) {
				webOK = true
			}
		}
	}
	notes = append(notes, DomainNote{webOK, map[bool]string{true: "Points at Open Suite. A certificate is issued within a minute.", false: "Doesn't point at Open Suite yet."}[webOK]})

	owned := false
	if txts, err := res.LookupTXT(ctx, d); err == nil {
		owned = slices.Contains(txts, "opensuite-verify="+u.OrgID)
	}
	mx := false
	if mxs, err := res.LookupMX(ctx, d); err == nil {
		for _, m := range mxs {
			if strings.EqualFold(strings.TrimSuffix(m.Host, "."), s.cfg.MailHost) {
				mx = true
			}
		}
	}
	notes = append(notes, DomainNote{owned, map[bool]string{true: "Ownership record found.", false: "Ownership TXT record not found."}[owned]})
	notes = append(notes, DomainNote{mx, map[bool]string{true: "Mail is routed to Open Suite.", false: "MX record doesn't point at Open Suite yet."}[mx]})

	mailOK := owned && mx
	dkim := ""
	if mailOK {
		var err error
		if dkim, err = s.mailEnsureDomain(d); err != nil {
			mailOK = false
			notes = append(notes, DomainNote{false, "The mail service couldn't add the domain. Try again shortly."})
		}
	}
	if dkim != "" {
		s.w.Exec(`UPDATE domains SET web_ok = ?, mail_ok = ?, dkim = ? WHERE domain = ?`, webOK, mailOK, dkim, d)
	} else {
		s.w.Exec(`UPDATE domains SET web_ok = ?, mail_ok = ? WHERE domain = ?`, webOK, mailOK, d)
	}
	if webOK {
		s.tls.poke()
	}
	ok(w, map[string]any{"domains": s.orgDomains(u.OrgID), "checks": notes})
}

// --- platform operator ---

func (s *Server) handleOperatorOrgs(w http.ResponseWriter, r *http.Request, u *User) {
	type row struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Plan    string `json:"plan"`
		Created int64  `json:"created"`
		Users   int    `json:"users"`
		Docs    int    `json:"docs"`
		Demo    bool   `json:"demo"` // reset every morning (demo.go)
		Domain  string `json:"domain"`
	}
	out := []row{}
	rows, err := s.r.Query(`SELECT o.id, o.name, o.plan, o.created,
		(SELECT count(*) FROM users WHERE org_id = o.id), (SELECT count(*) FROM docs WHERE org_id = o.id),
		coalesce((SELECT domain FROM domains WHERE org_id = o.id AND kind = 'org'), '')
		FROM orgs o ORDER BY o.created DESC LIMIT 1000`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var x row
			rows.Scan(&x.ID, &x.Name, &x.Plan, &x.Created, &x.Users, &x.Docs, &x.Domain)
			x.Demo = s.demo != nil && x.ID == s.demo.org
			out = append(out, x)
		}
	}
	ok(w, out)
}

func (s *Server) handleOperatorOrgUpdate(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Plan string }
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	if _, found := plans[in.Plan]; !found {
		fail(w, 400, "Unknown plan.")
		return
	}
	s.w.Exec(`UPDATE orgs SET plan = ? WHERE id = ?`, in.Plan, r.PathValue("id"))
	ok(w, map[string]bool{"ok": true})
}
