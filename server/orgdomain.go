package main

// An organisation's own mail domain. With OS_ORG_DOMAIN_SUFFIX set, every
// organisation made at sign-up gets <slug>.<suffix>, e.g.
// ritza.opensuite.online, and its people and groups get their addresses
// there instead of on the installation's shared mail domain. Nothing has to
// be published per organisation: a wildcard MX record for the suffix sends
// every such domain's mail here (or, with no MX at all, a wildcard A record,
// which senders fall back to).
//
// The domain is a row in domains with kind 'org', verified from the start;
// the mail engine learns it when the first mailbox is made on it
// (mailEnsureAccount).
// It is not a custom domain: it does not count against the plan's allowance,
// it cannot be removed, and the reserved names that guard the shared domain
// do not apply on it, so an organisation may have support@ and info@.
// Organisations made before the setting, or without it, keep the shared
// domain.

import (
	"database/sql"
	"regexp"
	"slices"
	"strings"
)

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		return ensureColumn(w, "domains", "kind", "TEXT NOT NULL DEFAULT 'own'")
	})
}

var slugRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$`)

// reservedSlugs are names an organisation may not take: every host name in
// use under the demo and production domains (the web suite, the classic
// stack's apps, mail), names that infrastructure looks up (autoconfig,
// _domainkey targets), and names that would let an organisation pose as us
// or as a well-known service.
var reservedSlugs = []string{
	// in use under demo.opensuite.online and opensuite.online
	"office", "bridge", "auth", "collabora", "docs", "static-docs", "element", "matrix", "grist", "static-grist",
	"id", "livekit", "meet", "static-meet", "messages", "nextcloud", "mail", "demo", "www", "classic",
	// infrastructure
	"smtp", "imap", "pop", "pop3", "mx", "mx1", "mx2", "webmail", "autoconfig", "autodiscover", "ns", "ns1", "ns2",
	"dns", "ftp", "vpn", "turn", "stun", "rtc", "sip", "ldap", "cdn", "static", "assets", "media", "img", "api",
	"mcp", "status", "app", "apps", "dev", "test", "staging", "beta", "preview", "localhost", "git", "cloud",
	// posing as us, or as someone people trust
	"opensuite", "open-suite", "admin", "administrator", "support", "help", "helpdesk", "abuse", "postmaster",
	"hostmaster", "webmaster", "security", "billing", "info", "noreply", "no-reply", "root", "system", "login",
	"signin", "signup", "account", "accounts", "sso", "oauth", "secure", "verify", "password", "official",
	"team", "staff", "sales", "legal", "privacy", "terms", "press", "about", "contact", "blog", "news", "jobs",
	"google", "gmail", "microsoft", "outlook", "office365", "apple", "icloud", "paypal", "bank", "example",
}

// slugify turns an organisation's name into the start of its domain:
// "Shah & Daughters Ltd." becomes "shah-daughters-ltd".
func slugify(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if a, found := foldAccent[r]; found {
			r = a
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 32 {
		out = strings.TrimRight(out[:32], "-")
	}
	return out
}

var foldAccent = map[rune]rune{
	'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'a', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e',
	'ë': 'e', 'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
	'ø': 'o', 'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y', 'ß': 's', 'ł': 'l', 'ś': 's', 'ż': 'z',
	'ź': 'z', 'ć': 'c', 'ń': 'n', 'ę': 'e', 'ą': 'a', 'č': 'c', 'š': 's', 'ž': 'z', 'ř': 'r', 'ő': 'o', 'ű': 'u',
}

// checkSlug says why a slug cannot be used, or "" if it can.
func (s *Server) checkSlug(slug string) string {
	if !slugRe.MatchString(slug) || strings.Contains(slug, "--") {
		return "Use 3 to 32 lowercase letters, digits or single dashes."
	}
	if slices.Contains(reservedSlugs, slug) {
		return "That name is reserved."
	}
	var n int
	s.r.QueryRow(`SELECT count(*) FROM domains WHERE domain = ?`, slug+"."+s.cfg.OrgDomainSuffix).Scan(&n)
	if n > 0 {
		return "Another organisation has that name."
	}
	return ""
}

// underSuffix reports whether a domain belongs to the installation's own
// namespace, where no organisation may claim one as a custom domain.
func (s *Server) underSuffix(d string) bool {
	suf := s.cfg.OrgDomainSuffix
	return suf != "" && (d == suf || strings.HasSuffix(d, "."+suf))
}

// orgDomain is the organisation's own subdomain, or "" if it has none.
func (s *Server) orgDomain(orgID string) string {
	var d string
	s.r.QueryRow(`SELECT domain FROM domains WHERE org_id = ? AND kind = 'org'`, orgID).Scan(&d)
	return d
}

// mailDomainsFor lists the domains an organisation may create addresses on,
// its default first: its own subdomain if it has one, else the shared mail
// domain; then its verified custom domains.
func (s *Server) mailDomainsFor(orgID string) []string {
	var out []string
	if d := s.orgDomain(orgID); d != "" {
		out = append(out, d)
	} else {
		out = append(out, s.cfg.MailDomain)
	}
	rows, err := s.r.Query(`SELECT domain FROM domains WHERE org_id = ? AND mail_ok = 1 AND kind = 'own' ORDER BY created`, orgID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		rows.Scan(&d)
		out = append(out, d)
	}
	return out
}
