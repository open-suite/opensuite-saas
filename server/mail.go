package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// The mail engine (Stalwart) is headless: it owns SMTP, storage, spam and
// DKIM, and is configured and queried entirely over JMAP on loopback. People
// never authenticate to it; each mailbox has a machine credential that only
// this process holds, and the browser's mail traffic passes through
// /api/mail/* on our own origin and session.

var jmapCore = []string{"urn:ietf:params:jmap:core", "urn:stalwart:jmap"}

type jmapCall struct {
	name string
	args any
}

type jmapResult struct {
	Name string
	Args json.RawMessage
}

// jmapAdmin runs management calls as the engine administrator.
func (s *Server) jmapAdmin(ctx context.Context, base string, calls ...jmapCall) ([]jmapResult, error) {
	return s.jmapAdminUsing(ctx, base, jmapCore, calls...)
}

func (s *Server) jmapAdminUsing(ctx context.Context, base string, using []string, calls ...jmapCall) ([]jmapResult, error) {
	mc := make([][]any, len(calls))
	for i, c := range calls {
		mc[i] = []any{c.name, c.args, itoa(i)}
	}
	body, _ := json.Marshal(map[string]any{"using": using, "methodCalls": mc})
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/jmap/", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	user, pass, _ := strings.Cut(s.cfg.MailAdmin, ":")
	req.SetBasicAuth(user, pass)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode != 200 {
		return nil, errf("mail engine: %d %s", res.StatusCode, raw)
	}
	var out struct {
		MethodResponses [][]json.RawMessage `json:"methodResponses"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	results := make([]jmapResult, len(out.MethodResponses))
	for i, r := range out.MethodResponses {
		if len(r) < 2 {
			return nil, errf("mail engine: malformed response")
		}
		json.Unmarshal(r[0], &results[i].Name)
		results[i].Args = r[1]
		if results[i].Name == "error" {
			return results, errf("mail engine: %s", r[1])
		}
	}
	return results, nil
}

type setResult struct {
	Created map[string]struct {
		ID string `json:"id"`
	} `json:"created"`
	NotCreated map[string]struct {
		Type     string `json:"type"`
		ObjectID struct {
			ID string `json:"id"`
		} `json:"objectId"`
	} `json:"notCreated"`
	Updated      map[string]json.RawMessage `json:"updated"`
	NotUpdated   map[string]json.RawMessage `json:"notUpdated"`
	NotDestroyed map[string]json.RawMessage `json:"notDestroyed"`
}

type queryResult struct {
	IDs []string `json:"ids"`
}

var mailDomains struct {
	mu sync.Mutex
	m  map[string]string
}

// mailDomainID returns the engine's id for a domain, creating it if asked.
func (s *Server) mailDomainID(ctx context.Context, base, domain string, create bool) (string, error) {
	mailDomains.mu.Lock()
	defer mailDomains.mu.Unlock()
	if id := mailDomains.m[domain]; id != "" {
		return id, nil
	}
	res, err := s.jmapAdmin(ctx, base, jmapCall{"x:Domain/query", map[string]any{"filter": map[string]string{"name": domain}}})
	if err != nil {
		return "", err
	}
	var q queryResult
	json.Unmarshal(res[0].Args, &q)
	id := ""
	if len(q.IDs) > 0 {
		id = q.IDs[0]
	} else if create {
		res, err = s.jmapAdmin(ctx, base, jmapCall{"x:Domain/set", map[string]any{"create": map[string]any{"d": map[string]string{"name": domain}}}})
		if err != nil {
			return "", err
		}
		var sr setResult
		json.Unmarshal(res[0].Args, &sr)
		if id = sr.Created["d"].ID; id == "" {
			return "", errf("mail engine refused domain %s: %s", domain, res[0].Args)
		}
	} else {
		return "", errf("mail domain %s is not set up", domain)
	}
	if mailDomains.m == nil {
		mailDomains.m = map[string]string{}
	}
	mailDomains.m[domain] = id
	return id, nil
}

// mailSetup configures a fresh engine: default domain, host name, listeners
// and memory limits. Run once by the installer against the engine's setup
// port; every step is safe to repeat.
func (s *Server) mailSetup(ctx context.Context, base string) error {
	domID, err := s.mailDomainID(ctx, base, s.cfg.MailDomain, true)
	if err != nil {
		return err
	}
	res, err := s.jmapAdmin(ctx, base,
		jmapCall{"x:SystemSettings/set", map[string]any{"update": map[string]any{"singleton": map[string]any{
			"defaultHostname": s.cfg.MailHost, "defaultDomainId": domID}}}},
		// These are ceilings on caches we don't need at this scale.
		jmapCall{"x:Cache/set", map[string]any{"update": map[string]any{"singleton": map[string]any{
			"messagesLarge": 0, "groupwareLarge": 0, "messages": 64 << 20, "events": 8 << 20, "contacts": 8 << 20, "files": 8 << 20}}}},
		// The HTTP listener is loopback-only and its sole client is this
		// process, so per-address rate limits would only throttle ourselves.
		jmapCall{"x:Http/set", map[string]any{"update": map[string]any{"singleton": map[string]any{
			"rateLimitAuthenticated": map[string]int{"count": 1000000, "period": 60000},
			"rateLimitAnonymous":     map[string]int{"count": 1000000, "period": 60000}}}}},
		jmapCall{"x:NetworkListener/query", map[string]any{}},
	)
	if err != nil {
		return err
	}
	var q queryResult
	json.Unmarshal(res[3].Args, &q)
	if len(q.IDs) == 0 {
		lis := func(proto, bind string, implicit bool) map[string]any {
			return map[string]any{"name": proto + bind, "protocol": proto, "bind": map[string]bool{bind: true}, "implicitTls": implicit}
		}
		mailURL, _ := url.Parse(s.cfg.MailURL)
		_, err = s.jmapAdmin(ctx, base, jmapCall{"x:NetworkListener/set", map[string]any{"create": map[string]any{
			"smtp":        lis("smtp", "[::]:25", false),
			"submission":  lis("smtp", "[::]:587", false),
			"submissions": lis("smtp", "[::]:465", true),
			"imaps":       lis("imap", "[::]:993", true),
			"http":        lis("http", mailURL.Host, false),
		}}})
		if err != nil {
			return err
		}
	}
	return s.mailRelay(ctx, base)
}

// mailRelay routes outbound mail through a smarthost when OS_MAIL_RELAY is
// set (host:port:user:password); otherwise the engine delivers directly.
func (s *Server) mailRelay(ctx context.Context, base string) error {
	relay := env("OS_MAIL_RELAY", "")
	if relay == "" {
		return nil
	}
	p := strings.SplitN(relay, ":", 4)
	if len(p) != 4 {
		return errf("OS_MAIL_RELAY must be host:port:user:password")
	}
	// The engine has built-in routes ("mx", "local"); ours is the one named
	// "smarthost", created once and updated when the setting changes.
	res, err := s.jmapAdmin(ctx, base, jmapCall{"x:MtaRoute/get", map[string]any{"properties": []string{"name"}}})
	if err != nil {
		return err
	}
	var g struct {
		List []struct{ ID, Name string } `json:"list"`
	}
	json.Unmarshal(res[0].Args, &g)
	port := 587
	json.Unmarshal([]byte(p[1]), &port)
	route := map[string]any{
		"host": p[0], "port": port, "protocol": "smtp", "implicitTls": port == 465,
		"authUsername": p[2], "authSecret": map[string]string{"@type": "Value", "secret": p[3]}}
	set := map[string]any{"update": map[string]any{}}
	for _, r := range g.List {
		if r.Name == "smarthost" {
			set["update"] = map[string]any{r.ID: route}
		}
	}
	if len(set["update"].(map[string]any)) == 0 {
		route["@type"], route["name"] = "Relay", "smarthost"
		set = map[string]any{"create": map[string]any{"r": route}}
	}
	res, err = s.jmapAdmin(ctx, base,
		jmapCall{"x:MtaRoute/set", set},
		jmapCall{"x:MtaOutboundStrategy/set", map[string]any{"update": map[string]any{"singleton": map[string]any{"route": map[string]any{
			"match": map[string]any{"0": map[string]string{"if": "is_local_domain(rcpt_domain)", "then": "'local'"}}, "else": "'smarthost'"}}}}},
	)
	if err != nil {
		return err
	}
	var sr setResult
	json.Unmarshal(res[0].Args, &sr)
	if len(sr.NotCreated) > 0 || len(sr.NotUpdated) > 0 {
		return errf("mail engine refused the relay: %s", res[0].Args)
	}
	// Outbound routing is read at startup; without a reload the engine keeps
	// delivering directly.
	_, err = s.jmapAdmin(ctx, base, jmapCall{"x:Action/set", map[string]any{"create": map[string]any{"a": map[string]string{"@type": "ReloadSettings"}}}})
	return err
}

// mailSyncCert points the engine at the certificate the app obtained for the
// mail host and makes it pick up renewals.
func (s *Server) mailSyncCert(ctx context.Context) {
	if s.cfg.MailURL == "" {
		return
	}
	crt := filepath.Join(s.cfg.CertDir, s.cfg.MailHost+".crt")
	if _, err := os.Stat(crt); err != nil {
		return
	}
	res, err := s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Certificate/query", map[string]any{}})
	if err != nil {
		log.Printf("mail: certificate query: %v", err)
		return
	}
	var q queryResult
	json.Unmarshal(res[0].Args, &q)
	if len(q.IDs) == 0 {
		_, err = s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Certificate/set", map[string]any{"create": map[string]any{"c": map[string]any{
			"certificate": map[string]string{"@type": "File", "filePath": crt},
			"privateKey":  map[string]string{"@type": "File", "filePath": filepath.Join(s.cfg.CertDir, s.cfg.MailHost+".key")}}}}})
		if err != nil {
			log.Printf("mail: certificate create: %v", err)
			return
		}
	}
	s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Action/set", map[string]any{"create": map[string]any{"a": map[string]string{"@type": "ReloadTlsCertificates"}}}})
}

// mailEnsureAccount creates the person's mailbox, or re-keys it if it exists.
func (s *Server) mailEnsureAccount(ctx context.Context, u *User) {
	if s.cfg.MailURL == "" {
		return
	}
	local, domain, _ := strings.Cut(u.Email, "@")
	// An organisation's own subdomain is ours to add whenever it is missing
	// (orgdomain.go); a custom domain is added only once verified.
	var own int
	s.r.QueryRow(`SELECT count(*) FROM domains WHERE domain = ? AND kind = 'org'`, domain).Scan(&own)
	domID, err := s.mailDomainID(ctx, s.cfg.MailURL, domain, own > 0)
	if err != nil {
		log.Printf("mail: %s: %v", u.Email, err)
		return
	}
	res, err := s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Account/set", map[string]any{"create": map[string]any{"u": map[string]any{
		"@type": "User", "name": local, "domainId": domID, "description": u.Name,
		"credentials": map[string]any{"0": map[string]string{"@type": "Password", "secret": u.MailSecret}}}}}})
	if err != nil {
		log.Printf("mail: creating %s: %v", u.Email, err)
		return
	}
	var sr setResult
	json.Unmarshal(res[0].Args, &sr)
	id := sr.Created["u"].ID
	if id == "" {
		if nc := sr.NotCreated["u"]; nc.Type == "primaryKeyViolation" && nc.ObjectID.ID != "" {
			id = nc.ObjectID.ID
			s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Account/set", map[string]any{"update": map[string]any{id: map[string]any{
				"credentials/0/secret": u.MailSecret, "description": u.Name}}}})
		} else {
			log.Printf("mail: creating %s: %s", u.Email, res[0].Args)
			return
		}
	}
	u.MailReady, u.MailID = true, id
	s.w.Exec(`UPDATE users SET mail_ready = 1, mail_id = ? WHERE id = ?`, id, u.ID)
}

// moveAddress changes a person's address. The mailbox moves with them (the
// engine keeps its contents and re-derives the sending identity); everything
// else in the app refers to people by id.
func (s *Server) moveAddress(ctx context.Context, from, to string) error {
	from, to = strings.ToLower(strings.TrimSpace(from)), strings.ToLower(strings.TrimSpace(to))
	var id string
	if s.r.QueryRow(`SELECT id FROM users WHERE email = ?`, from).Scan(&id) != nil {
		return errf("no one has the address %s", from)
	}
	u := s.userByID(id)
	local, domain, _ := strings.Cut(to, "@")
	if validUsername(local) != "" || !domainRe.MatchString(domain) {
		return errf("%s is not a valid address", to)
	}
	if s.addressTaken(to) {
		return errf("%s is already taken", to)
	}
	if !slices.Contains(s.mailDomainsFor(u.OrgID), domain) {
		return errf("%s is not a mail domain of this organisation", domain)
	}
	if s.cfg.MailURL != "" && u.MailID != "" {
		domID, err := s.mailDomainID(ctx, s.cfg.MailURL, domain, true)
		if err != nil {
			return err
		}
		res, err := s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Account/set", map[string]any{"update": map[string]any{
			u.MailID: map[string]any{"name": local, "domainId": domID}}}})
		if err != nil {
			return err
		}
		var sr setResult
		json.Unmarshal(res[0].Args, &sr)
		if _, moved := sr.Updated[u.MailID]; !moved {
			return errf("mail engine refused the move: %s", res[0].Args)
		}
	}
	if _, err := s.w.Exec(`UPDATE users SET email = ? WHERE id = ?`, to, id); err != nil {
		return err
	}
	s.refreshPolicies(u.OrgID) // restricted groups now hear from the new address
	return nil
}

func (s *Server) mailDeleteAccount(u *User) {
	if s.cfg.MailURL == "" || u.MailID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Account/set", map[string]any{"destroy": []string{u.MailID}}}); err != nil {
		log.Printf("mail: deleting %s: %v", u.Email, err)
	}
}

// mailEnsureDomain adds a customer domain and returns its DKIM records as
// "name<TAB>value" lines for the admin to publish.
func (s *Server) mailEnsureDomain(domain string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	id, err := s.mailDomainID(ctx, s.cfg.MailURL, domain, true)
	if err != nil {
		return "", err
	}
	// Keys are generated in the background just after the domain appears.
	for i := 0; i < 10; i++ {
		res, err := s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Domain/get", map[string]any{"ids": []string{id}, "properties": []string{"dnsZoneFile"}}})
		if err != nil {
			return "", err
		}
		var g struct {
			List []struct {
				Zone string `json:"dnsZoneFile"`
			} `json:"list"`
		}
		json.Unmarshal(res[0].Args, &g)
		if len(g.List) > 0 {
			if recs := dkimFromZone(g.List[0].Zone); recs != "" {
				return recs, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return "", errf("DKIM keys for %s are not ready", domain)
}

// dkimFromZone pulls the _domainkey TXT records out of a BIND-format zone,
// joining values that were split across quoted chunks.
func dkimFromZone(zone string) string {
	var out []string
	lines := strings.Split(zone, "\n")
	for i := 0; i < len(lines); i++ {
		name, rest, found := strings.Cut(lines[i], " IN TXT ")
		if !found || !strings.Contains(name, "._domainkey.") {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(rest), "(") {
			for i++; i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), ")"); i++ {
				rest += lines[i]
			}
		}
		value := ""
		for j, part := range strings.Split(rest, `"`) {
			if j%2 == 1 {
				value += part
			}
		}
		out = append(out, strings.TrimSuffix(name, ".")+"\t"+value)
	}
	return strings.Join(out, "\n")
}

func (s *Server) mailDeleteDomain(domain string) {
	if s.cfg.MailURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	id, err := s.mailDomainID(ctx, s.cfg.MailURL, domain, false)
	if err != nil {
		return
	}
	res, err := s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:DkimSignature/query", map[string]any{"filter": map[string]string{"domainId": id}}})
	if err == nil {
		var q queryResult
		json.Unmarshal(res[0].Args, &q)
		if len(q.IDs) > 0 {
			s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:DkimSignature/set", map[string]any{"destroy": q.IDs}})
		}
	}
	s.jmapAdmin(ctx, s.cfg.MailURL, jmapCall{"x:Domain/set", map[string]any{"destroy": []string{id}}})
	mailDomains.mu.Lock()
	delete(mailDomains.m, domain)
	mailDomains.mu.Unlock()
}

// --- the browser's mail traffic ---

var jmapAllowedMethods = append([]string{"Mailbox/", "Email/", "Thread/", "EmailSubmission/", "Identity/", "SearchSnippet/", "VacationResponse/", "Core/echo"}, jmapGroupware...)

var jmapUsing = []string{"urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission", "urn:ietf:params:jmap:vacationresponse",
	"urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:calendars:parse", "urn:ietf:params:jmap:contacts", "urn:ietf:params:jmap:contacts:parse"}

// handleJMAP forwards a mail request for the signed-in person. It pins every
// call to one mailbox, their own or with ?group= a group's they belong to,
// and to mail methods only, so the engine's management surface is
// unreachable from a browser.
func (s *Server) handleJMAP(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.MailReady {
		fail(w, 503, "Your mailbox is being set up.")
		return
	}
	acct, code, msg := s.mailAccount(r, u)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	var in struct {
		MethodCalls [][]json.RawMessage `json:"methodCalls"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 12<<20)).Decode(&in); err != nil {
		fail(w, 400, "bad request")
		return
	}
	calls := make([][]any, 0, len(in.MethodCalls))
	for _, c := range in.MethodCalls {
		if len(c) != 3 {
			fail(w, 400, "bad request")
			return
		}
		var name string
		var args map[string]json.RawMessage
		if json.Unmarshal(c[0], &name) != nil || json.Unmarshal(c[1], &args) != nil {
			fail(w, 400, "bad request")
			return
		}
		allowed := false
		for _, p := range jmapAllowedMethods {
			allowed = allowed || strings.HasPrefix(name, p)
		}
		if !allowed || !groupwareCallOK(name, args) {
			fail(w, 403, "method not available")
			return
		}
		id, _ := json.Marshal(acct.ID)
		args["accountId"] = id
		delete(args, "fromAccountId")
		calls = append(calls, []any{name, args, c[2]})
	}
	if code, msg := s.callsAllowed(r.Context(), u, acct, in.MethodCalls); code != 0 {
		fail(w, code, msg)
		return
	}
	body, _ := json.Marshal(map[string]any{"using": jmapUsing, "methodCalls": calls})
	s.mailForward(w, r, u, "POST", "/jmap/", bytes.NewReader(body), "application/json", nil)
}

// callsAllowed applies the rules every request that reaches a mailbox
// follows, from the app or the API: what the caller's role in a group allows,
// whom the plan lets them mail, and that what they send is from the mailbox
// they send it from.
func (s *Server) callsAllowed(ctx context.Context, u *User, acct *mailAccount, calls [][]json.RawMessage) (int, string) {
	if !groupCallsOK(acct, u.ID, calls) {
		if acct.Role == "viewer" {
			return 403, viewerRefused
		}
		return 403, "That is not available in a group's mailbox."
	}
	if !s.recipientsAllowed(u, calls) {
		return 403, "Your organisation's plan sends mail only to addresses on Open Suite."
	}
	if !s.sendersAllowed(ctx, u, acct, calls) {
		return 403, "Mail can only be sent from the address of the mailbox it is sent from."
	}
	return 0, ""
}

type jmapAddr struct {
	Email string `json:"email"`
}

// recipientsAllowed checks a request that sends mail for an organisation
// whose plan keeps mail inside the installation. Every message sent must be
// created in the same request, so its recipients are all visible here, and
// each of them must be on a domain this installation hosts. A message
// imported whole (a calendar invitation) has its recipients inside the
// uploaded file, so sending one needs an envelope that names them.
func (s *Server) recipientsAllowed(u *User, calls [][]json.RawMessage) bool {
	var plan string
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&plan)
	if planFor(plan).MailOutside {
		return true
	}
	created := map[string]bool{}  // made with Email/set
	imported := map[string]bool{} // made with Email/import
	var rcpts []jmapAddr
	type submission struct {
		emailID  string
		rcptTo   []jmapAddr
		envelope bool
	}
	var subs []submission
	updates := false
	for _, c := range calls {
		var name string
		var args struct {
			Create map[string]struct {
				To, Cc, Bcc []jmapAddr
				EmailID     string `json:"emailId"`
				Envelope    *struct {
					RcptTo []jmapAddr `json:"rcptTo"`
				} `json:"envelope"`
			} `json:"create"`
			Update map[string]json.RawMessage `json:"update"`
			Emails map[string]json.RawMessage `json:"emails"`
		}
		json.Unmarshal(c[0], &name)
		json.Unmarshal(c[1], &args)
		switch name {
		case "Email/set":
			// An update could change recipients after the check; the app
			// never combines one with sending.
			updates = updates || len(args.Update) > 0
			for id, e := range args.Create {
				created[id] = true
				rcpts = append(append(append(rcpts, e.To...), e.Cc...), e.Bcc...)
			}
		case "Email/import":
			for id := range args.Emails {
				imported[id] = true
			}
		case "EmailSubmission/set":
			for _, sub := range args.Create {
				var to []jmapAddr
				if sub.Envelope != nil {
					to = sub.Envelope.RcptTo
				}
				subs = append(subs, submission{sub.EmailID, to, sub.Envelope != nil})
			}
		}
	}
	if len(subs) == 0 {
		return true
	}
	// Judged after every call is read, so a later call cannot reuse an id.
	for _, sub := range subs {
		ref, isRef := strings.CutPrefix(sub.emailID, "#")
		switch {
		case isRef && created[ref] && !imported[ref]:
		case isRef && imported[ref] && !created[ref] && sub.envelope && len(sub.rcptTo) > 0:
		default:
			return false
		}
		rcpts = append(rcpts, sub.rcptTo...)
	}
	if updates {
		return false
	}
	local := map[string]bool{s.cfg.MailDomain: true}
	rows, err := s.r.Query(`SELECT domain FROM domains WHERE mail_ok = 1`)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		rows.Scan(&d)
		local[strings.ToLower(d)] = true
	}
	for _, a := range rcpts {
		at := strings.LastIndexByte(a.Email, '@')
		if at < 0 || !local[strings.ToLower(a.Email[at+1:])] {
			return false
		}
	}
	return true
}

// sendersAllowed checks that every message a request sends is from the
// address of the mailbox it is sent from: a person's own from their own
// mailbox, a group's from the group's. The engine checks only the envelope,
// so without this anyone could put a colleague's or a group's address in
// From. As for recipientsAllowed, a message sent must be made in the same
// request; one imported whole (an invitation) is read back from the engine.
func (s *Server) sendersAllowed(ctx context.Context, u *User, acct *mailAccount, calls [][]json.RawMessage) bool {
	created := map[string][]jmapAddr{} // From of messages made with Email/set
	imported := map[string]string{}    // blob of messages made with Email/import
	var sent []string
	for _, c := range calls {
		var name string
		var args struct {
			Create map[string]struct {
				From    []jmapAddr
				EmailID string `json:"emailId"`
			} `json:"create"`
			Emails map[string]struct {
				BlobID string `json:"blobId"`
			} `json:"emails"`
		}
		json.Unmarshal(c[0], &name)
		json.Unmarshal(c[1], &args)
		switch name {
		case "Email/set":
			for id, e := range args.Create {
				created[id] = e.From
			}
		case "Email/import":
			for id, e := range args.Emails {
				imported[id] = e.BlobID
			}
		case "EmailSubmission/set":
			for _, sub := range args.Create {
				sent = append(sent, sub.EmailID)
			}
		}
	}
	for _, ref := range sent {
		id, isRef := strings.CutPrefix(ref, "#")
		from, made := created[id]
		blob, wasImported := imported[id]
		switch {
		case !isRef || made == wasImported:
			return false
		case made:
			if len(from) != 1 || !strings.EqualFold(from[0].Email, acct.Email) {
				return false
			}
		case !strings.EqualFold(s.importedFrom(ctx, u, acct, blob), acct.Email):
			return false
		}
	}
	return true
}

// importedFrom reads the From address of a message uploaded for import.
func (s *Server) importedFrom(ctx context.Context, u *User, acct *mailAccount, blob string) string {
	req, err := http.NewRequestWithContext(ctx, "GET", s.cfg.MailURL+"/jmap/download/"+url.PathEscape(acct.ID)+"/"+url.PathEscape(blob)+"/m.eml?accept=message/rfc822", nil)
	if err != nil {
		return ""
	}
	req.SetBasicAuth(u.Email, u.MailSecret)
	res, err := mailClient.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return ""
	}
	m, err := mail.ReadMessage(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return ""
	}
	from, err := mail.ParseAddressList(m.Header.Get("From"))
	if err != nil || len(from) != 1 {
		return ""
	}
	return from[0].Address
}

func (s *Server) mailForward(w http.ResponseWriter, r *http.Request, u *User, method, path string, body io.Reader, ctype string, decorate func(http.Header)) {
	req, err := http.NewRequestWithContext(r.Context(), method, s.cfg.MailURL+path, body)
	if err != nil {
		fail(w, 500, "mail error")
		return
	}
	req.SetBasicAuth(u.Email, u.MailSecret)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	res, err := mailClient.Do(req)
	if err != nil {
		fail(w, 502, "The mail service is not responding.")
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-store")
	if decorate != nil {
		decorate(w.Header())
	}
	w.WriteHeader(res.StatusCode)
	io.Copy(w, res.Body)
}

// mailClient has no overall timeout: uploads, downloads and the event stream
// are bounded by the browser's request instead.
var mailClient = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64, IdleConnTimeout: 90 * time.Second}}

var inlineImage = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

func (s *Server) handleMailBlob(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.MailReady {
		http.NotFound(w, r)
		return
	}
	acct, code, msg := s.mailAccount(r, u)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	name := r.PathValue("name")
	accept := r.URL.Query().Get("type")
	if accept == "" {
		accept = "application/octet-stream"
	}
	path := "/jmap/download/" + url.PathEscape(acct.ID) + "/" + url.PathEscape(r.PathValue("blob")) + "/" + url.PathEscape(name) + "?accept=" + url.QueryEscape(accept)
	s.mailForward(w, r, u, "GET", path, nil, "", func(h http.Header) {
		// Attachments are data. Only plain raster images may render inline.
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
		if inlineImage[accept] && r.URL.Query().Get("dl") == "" {
			h.Set("Content-Type", accept)
			h.Set("Cache-Control", "private, max-age=86400")
		} else {
			h.Set("Content-Type", "application/octet-stream")
			h.Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
		}
	})
}

func (s *Server) handleMailUpload(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.MailReady {
		fail(w, 503, "Your mailbox is being set up.")
		return
	}
	acct, code, msg := s.mailAccount(r, u)
	if code != 0 {
		fail(w, code, msg)
		return
	}
	if !acct.maySend() {
		fail(w, 403, viewerRefused)
		return
	}
	ctype := r.Header.Get("Content-Type")
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	s.mailForward(w, r, u, "POST", "/jmap/upload/"+url.PathEscape(acct.ID)+"/", http.MaxBytesReader(w, r.Body, 50<<20), ctype, nil)
}

// handleMailEvents relays the engine's change feed so new mail appears
// without polling.
func (s *Server) handleMailEvents(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.MailReady {
		fail(w, 503, "Your mailbox is being set up.")
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", s.cfg.MailURL+"/jmap/eventsource/?types=Email,Mailbox,Calendar,CalendarEvent,AddressBook,ContactCard&closeafter=no&ping=30", nil)
	req.SetBasicAuth(u.Email, u.MailSecret)
	req.Header.Set("Accept", "text/event-stream")
	res, err := mailClient.Do(req)
	if err != nil {
		fail(w, 502, "The mail service is not responding.")
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(res.StatusCode)
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}
