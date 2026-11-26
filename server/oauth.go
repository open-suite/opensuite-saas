package main

// OAuth 2.1 for apps that act for a person: AI assistants connecting to the
// MCP server (mcp.go) by its address alone, and any other program that would
// rather send a person to approve it than ask them to paste a token. It
// follows the MCP authorization spec (2026-07-28): protected resource
// metadata (RFC 9728) tells a client where to sign in; authorization server
// metadata (RFC 8414) lists the endpoints; clients identify themselves with a
// Client ID Metadata Document (an https URL as client_id) or, for older
// clients, by dynamic registration (RFC 7591); only the authorization code
// grant with PKCE (S256) is offered; the authorization response names the
// issuer (RFC 9207).
//
// The person approves on a screen of the app itself (apps/connect.jsx), signed
// in as they always are. What they approve becomes a "connection": a row in
// api_tokens holding a short-lived access token and a rotating refresh token,
// listed beside their API tokens and revoked the same way.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

const schemaOAuth = `
CREATE TABLE IF NOT EXISTS oauth_clients(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uri TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL,
  secret_hash TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes(
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  read_only INTEGER NOT NULL,
  resource TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		_, err := w.Exec(schemaOAuth)
		return err
	})
}

const (
	accessTTL  = 3600       // an access token lasts an hour
	refreshTTL = 90 * 86400 // a connection unused for 90 days lapses
	codeTTL    = 120
)

var oauthScopes = []string{"read", "write"}

func (s *Server) routesOAuth(m *http.ServeMux) {
	m.HandleFunc("GET /.well-known/oauth-protected-resource", s.handleResourceMetadata)
	m.HandleFunc("GET /.well-known/oauth-protected-resource/{path...}", s.handleResourceMetadata)
	m.HandleFunc("GET /.well-known/oauth-authorization-server", s.handleServerMetadata)
	m.HandleFunc("OPTIONS /.well-known/", preflight)
	m.HandleFunc("POST /oauth/register", s.handleRegister)
	m.HandleFunc("OPTIONS /oauth/register", preflight)
	m.HandleFunc("GET /oauth/authorize", s.handleAuthorize)
	m.HandleFunc("POST /oauth/token", s.handleToken)
	m.HandleFunc("OPTIONS /oauth/token", preflight)
	m.HandleFunc("POST /oauth/revoke", s.handleRevoke)
	m.HandleFunc("OPTIONS /oauth/revoke", preflight)
	m.HandleFunc("GET /api/oauth/request", s.auth(s.handleOAuthRequest))
	m.HandleFunc("POST /api/oauth/approve", s.auth(s.handleOAuthApprove))
	m.HandleFunc("POST /api/oauth/deny", s.auth(s.handleOAuthDeny))
}

// handleResourceMetadata describes the API (at /) and the MCP server (at
// /mcp) as protected resources, both issued tokens by this server.
func (s *Server) handleResourceMetadata(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	resource := baseURL(r)
	switch p := r.PathValue("path"); p {
	case "":
	case "mcp":
		resource += "/mcp"
	default:
		fail(w, 404, "not found")
		return
	}
	ok(w, map[string]any{
		"resource":                 resource,
		"resource_name":            "Open Suite",
		"authorization_servers":    []string{baseURL(r)},
		"scopes_supported":         oauthScopes,
		"bearer_methods_supported": []string{"header"},
		"resource_documentation":   baseURL(r) + "/api/v1/reference",
	})
}

func (s *Server) handleServerMetadata(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	b := baseURL(r)
	ok(w, map[string]any{
		"issuer":                                         b,
		"authorization_endpoint":                         b + "/oauth/authorize",
		"token_endpoint":                                 b + "/oauth/token",
		"registration_endpoint":                          b + "/oauth/register",
		"revocation_endpoint":                            b + "/oauth/revoke",
		"scopes_supported":                               oauthScopes,
		"response_types_supported":                       []string{"code"},
		"response_modes_supported":                       []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none", "client_secret_post", "client_secret_basic"},
		"revocation_endpoint_auth_methods_supported":     []string{"none", "client_secret_post", "client_secret_basic"},
		"client_id_metadata_document_supported":          true,
		"authorization_response_iss_parameter_supported": true,
		"service_documentation":                          b + "/api/v1/reference",
	})
}

func oauthError(w http.ResponseWriter, code int, kind, desc string) {
	allowCORS(w)
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, code, map[string]string{"error": kind, "error_description": desc})
}

// --- clients ------------------------------------------------------------------

type oauthClient struct {
	ID           string
	Name, URI    string
	RedirectURIs []string
	SecretHash   string
}

// redirectAllowed accepts what OAuth 2.1 and RFC 8252 allow: an https
// address, http on the loopback interface (a desktop app listening locally),
// or a private-use scheme such as cursor:// for a native app.
func redirectAllowed(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.Scheme == "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return u.Host != ""
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1" || h == "::1"
	case "javascript", "data", "file", "vbscript", "about", "blob", "ws", "wss", "ftp":
		return false
	}
	return true
}

// redirectMatches compares a requested redirect with a registered one. For a
// loopback address the port may differ (RFC 8252 7.3): the app picks a free
// one each time.
func redirectMatches(registered, got string) bool {
	if registered == got {
		return true
	}
	a, err1 := url.Parse(registered)
	b, err2 := url.Parse(got)
	if err1 != nil || err2 != nil || a.Scheme != "http" || b.Scheme != "http" {
		return false
	}
	loop := func(h string) bool { return h == "localhost" || h == "127.0.0.1" || h == "::1" }
	return loop(a.Hostname()) && a.Hostname() == b.Hostname() && a.Path == b.Path && a.RawQuery == b.RawQuery
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.lim.allow("register:"+clientIP(r), 30, time.Hour) {
		oauthError(w, 429, "slow_down", "Too many registrations from this network.")
		return
	}
	var in struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
		ClientURI    string   `json:"client_uri"`
		GrantTypes   []string `json:"grant_types"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&in) != nil {
		oauthError(w, 400, "invalid_client_metadata", "The registration must be JSON.")
		return
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > 10 {
		oauthError(w, 400, "invalid_redirect_uri", "Give between one and ten redirect_uris.")
		return
	}
	for _, u := range in.RedirectURIs {
		if !redirectAllowed(u) {
			oauthError(w, 400, "invalid_redirect_uri", "Redirect addresses must be https, http on the loopback interface, or an app's own scheme.")
			return
		}
	}
	for _, g := range in.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			oauthError(w, 400, "invalid_client_metadata", "Only the authorization_code and refresh_token grants are offered.")
			return
		}
	}
	method := in.AuthMethod
	if method == "" {
		method = "client_secret_basic" // the RFC 7591 default
	}
	if method != "none" && method != "client_secret_post" && method != "client_secret_basic" {
		oauthError(w, 400, "invalid_client_metadata", "token_endpoint_auth_method is none, client_secret_post or client_secret_basic.")
		return
	}
	name := strings.TrimSpace(in.ClientName)
	if name == "" {
		name = hostOf(in.RedirectURIs[0])
	}
	if len(name) > 80 {
		name = name[:80]
	}
	c := oauthClient{ID: "osc_" + newID(20), Name: name, URI: in.ClientURI, RedirectURIs: in.RedirectURIs}
	out := map[string]any{
		"client_id": c.ID, "client_id_issued_at": now(), "client_name": c.Name, "redirect_uris": c.RedirectURIs,
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": method,
	}
	if method != "none" {
		secret := newToken()
		c.SecretHash = hashToken(secret)
		out["client_secret"], out["client_secret_expires_at"] = secret, 0
	}
	uris, _ := json.Marshal(c.RedirectURIs)
	if _, err := s.w.Exec(`INSERT INTO oauth_clients(id, name, uri, redirect_uris, secret_hash, created) VALUES(?,?,?,?,?,?)`, c.ID, c.Name, c.URI, string(uris), c.SecretHash, now()); err != nil {
		oauthError(w, 500, "server_error", "storage error")
		return
	}
	allowCORS(w)
	writeJSON(w, 201, out)
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Hostname()
	}
	return "An app"
}

var metadataDocs = struct {
	mu sync.Mutex
	m  map[string]cachedClient
}{m: map[string]cachedClient{}}

type cachedClient struct {
	c  *oauthClient
	at time.Time
}

// publicDialer refuses to connect anywhere but the public internet, so a
// client_id URL cannot make this server reach into its own network.
var publicDialer = &net.Dialer{Timeout: 5 * time.Second, Control: func(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return errors.New("not a public address")
	}
	return nil
}}

var metadataClient = &http.Client{
	Timeout:   8 * time.Second,
	Transport: &http.Transport{DialContext: publicDialer.DialContext, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("client metadata must not redirect")
	},
}

// isMetadataURL says whether a client_id is a Client ID Metadata Document.
func isMetadataURL(id string) bool {
	u, err := url.Parse(id)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.Path != "" && u.Path != "/" && u.Fragment == "" && u.User == nil
}

// fetchMetadataClient reads a client's own description of itself, as the
// Client ID Metadata Document draft describes, and keeps it for a while.
func (s *Server) fetchMetadataClient(ctx context.Context, id string) (*oauthClient, string) {
	metadataDocs.mu.Lock()
	if c, found := metadataDocs.m[id]; found && time.Since(c.at) < 10*time.Minute {
		metadataDocs.mu.Unlock()
		return c.c, ""
	}
	metadataDocs.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, "GET", id, nil)
	if err != nil {
		return nil, "That client id is not a valid address."
	}
	req.Header.Set("Accept", "application/json")
	res, err := metadataClient.Do(req)
	if err != nil {
		return nil, "The app's description could not be fetched from " + id + "."
	}
	defer res.Body.Close()
	var doc struct {
		ClientID     string   `json:"client_id"`
		ClientName   string   `json:"client_name"`
		ClientURI    string   `json:"client_uri"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&doc) != nil {
		return nil, "The app's description at " + id + " is not valid JSON."
	}
	if doc.ClientID != id || doc.ClientName == "" || len(doc.RedirectURIs) == 0 {
		return nil, "The app's description must name itself (client_id equal to its address), its client_name and its redirect_uris."
	}
	if doc.AuthMethod != "" && doc.AuthMethod != "none" {
		return nil, "Only public clients (token_endpoint_auth_method none) can be identified by a metadata document here."
	}
	for _, u := range doc.RedirectURIs {
		if !redirectAllowed(u) {
			return nil, "The app's description lists a redirect address that is not allowed."
		}
	}
	name := doc.ClientName
	if len(name) > 80 {
		name = name[:80]
	}
	c := &oauthClient{ID: id, Name: name, URI: doc.ClientURI, RedirectURIs: doc.RedirectURIs}
	metadataDocs.mu.Lock()
	if len(metadataDocs.m) > 1000 {
		metadataDocs.m = map[string]cachedClient{}
	}
	metadataDocs.m[id] = cachedClient{c, time.Now()}
	metadataDocs.mu.Unlock()
	return c, ""
}

func (s *Server) client(ctx context.Context, id string) (*oauthClient, string) {
	if isMetadataURL(id) {
		return s.fetchMetadataClient(ctx, id)
	}
	c := &oauthClient{ID: id}
	var uris string
	if s.r.QueryRow(`SELECT name, uri, redirect_uris, secret_hash FROM oauth_clients WHERE id = ?`, id).Scan(&c.Name, &c.URI, &uris, &c.SecretHash) != nil {
		return nil, "This app is not registered here. Remove the connection in the app and add it again."
	}
	json.Unmarshal([]byte(uris), &c.RedirectURIs)
	return c, ""
}

// --- authorization ---------------------------------------------------------------

type authRequest struct {
	client      *oauthClient
	redirect    string
	state       string
	challenge   string
	resource    string
	write       bool // write access was asked for
	issuer      string
	redirectErr string // set when the request is bad but the redirect is known good
	pageErr     string // set when not even the redirect can be trusted
}

// readAuthRequest checks an authorization request. Until the client and its
// redirect address are known good, nothing may be sent back to that address.
func (s *Server) readAuthRequest(r *http.Request, q url.Values) *authRequest {
	a := &authRequest{state: q.Get("state"), issuer: baseURL(r)}
	c, msg := s.client(r.Context(), q.Get("client_id"))
	if c == nil {
		a.pageErr = msg
		return a
	}
	a.client = c
	a.redirect = q.Get("redirect_uri")
	if a.redirect == "" && len(c.RedirectURIs) == 1 {
		a.redirect = c.RedirectURIs[0]
	}
	if !slices.ContainsFunc(c.RedirectURIs, func(reg string) bool { return redirectMatches(reg, a.redirect) }) {
		a.pageErr = "The app asked to return to an address it did not register."
		return a
	}
	switch {
	case q.Get("response_type") != "code":
		a.redirectErr = "unsupported_response_type"
	case q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256":
		a.redirectErr = "invalid_request"
	}
	a.challenge = q.Get("code_challenge")
	a.resource = q.Get("resource")
	if a.resource != "" && !s.ownResource(r, a.resource) {
		a.redirectErr = "invalid_target"
	}
	scopes := strings.Fields(q.Get("scope"))
	a.write = len(scopes) == 0 || slices.Contains(scopes, "write")
	return a
}

// ownResource accepts the resource identifiers this server answers for: the
// API and the MCP server, at the address the client used.
func (s *Server) ownResource(r *http.Request, resource string) bool {
	b := strings.ToLower(baseURL(r))
	res := strings.ToLower(strings.TrimRight(resource, "/"))
	return res == b || res == b+"/mcp" || res == b+"/api/v1"
}

func (a *authRequest) back(params url.Values) string {
	if a.state != "" {
		params.Set("state", a.state)
	}
	params.Set("iss", a.issuer)
	sep := "?"
	if strings.Contains(a.redirect, "?") {
		sep = "&"
	}
	return a.redirect + sep + params.Encode()
}

// handleAuthorize starts the approval: a bad request is answered here or sent
// back to the app; a good one opens the app on its consent screen, after
// signing in if need be.
func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	a := s.readAuthRequest(r, r.URL.Query())
	if a.pageErr != "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		w.WriteHeader(400)
		w.Write([]byte(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open Suite</title>` +
			`<style>:root{color-scheme:light dark}body{margin:0;color:#102033;background:#fff}@media (prefers-color-scheme:dark){body{color:#e6edf5;background:#0f161d}}</style>` +
			`<div style="font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px">` +
			`<h1 style="font-size:20px">This connection can't be made</h1><p>` + html.EscapeString(a.pageErr) + `</p></div>`))
		return
	}
	if a.redirectErr != "" {
		http.Redirect(w, r, a.back(url.Values{"error": {a.redirectErr}}), http.StatusFound)
		return
	}
	s.handleApp(w, r)
}

func (s *Server) handleOAuthRequest(w http.ResponseWriter, r *http.Request, u *User) {
	a := s.readAuthRequest(r, r.URL.Query())
	if a.pageErr != "" || a.redirectErr != "" {
		fail(w, 400, map[bool]string{true: a.pageErr, false: "The app's request is not valid (" + a.redirectErr + ")."}[a.pageErr != ""])
		return
	}
	scopes := []string{"read"}
	if a.write {
		scopes = append(scopes, "write")
	}
	ok(w, map[string]any{
		"client":            map[string]string{"name": a.client.Name, "uri": a.client.URI},
		"redirectHost":      hostOf(a.redirect),
		"scopes":            scopes,
		"canChooseReadOnly": a.write,
	})
}

func (s *Server) handleOAuthApprove(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct {
		Query    string
		ReadOnly bool
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}
	q, _ := url.ParseQuery(in.Query)
	a := s.readAuthRequest(r, q)
	if a.pageErr != "" || a.redirectErr != "" {
		fail(w, 400, "The app's request is no longer valid. Start again from the app.")
		return
	}
	resource := a.resource
	if resource == "" {
		resource = baseURL(r) + "/mcp"
	}
	code := newToken()
	if _, err := s.w.Exec(`INSERT INTO oauth_codes(hash, client_id, client_name, user_id, redirect_uri, challenge, read_only, resource, expires) VALUES(?,?,?,?,?,?,?,?,?)`,
		hashToken(code), a.client.ID, a.client.Name, u.ID, a.redirect, a.challenge, in.ReadOnly || !a.write, resource, now()+codeTTL); err != nil {
		fail(w, 500, "storage error")
		return
	}
	ok(w, map[string]string{"redirect": a.back(url.Values{"code": {code}})})
}

func (s *Server) handleOAuthDeny(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Query string }
	readJSON(r, &in)
	q, _ := url.ParseQuery(in.Query)
	a := s.readAuthRequest(r, q)
	if a.pageErr != "" {
		fail(w, 400, a.pageErr)
		return
	}
	ok(w, map[string]string{"redirect": a.back(url.Values{"error": {"access_denied"}})})
}

// --- tokens -----------------------------------------------------------------------

// clientAuth checks a confidential client's secret, from the form or the
// Authorization header, and returns the client id the request is for.
func (s *Server) clientAuth(r *http.Request) (string, bool) {
	id, secret := r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	if u, p, has := r.BasicAuth(); has {
		uid, _ := url.QueryUnescape(u)
		pw, _ := url.QueryUnescape(p)
		id, secret = uid, pw
	}
	if isMetadataURL(id) {
		return id, secret == ""
	}
	var hash string
	if s.r.QueryRow(`SELECT secret_hash FROM oauth_clients WHERE id = ?`, id).Scan(&hash) != nil {
		return id, false
	}
	return id, hash == "" || hashToken(secret) == hash
}

type tokenAnswer struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func scopeOf(readOnly bool) string {
	if readOnly {
		return "read"
	}
	return "read write"
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	w.Header().Set("Cache-Control", "no-store")
	if !s.lim.allow("token:"+clientIP(r), 120, time.Minute) {
		oauthError(w, 429, "slow_down", "Too many requests.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if r.ParseForm() != nil {
		oauthError(w, 400, "invalid_request", "The request must be form-encoded.")
		return
	}
	clientID, authed := s.clientAuth(r)
	if !authed {
		oauthError(w, 401, "invalid_client", "The client could not be authenticated.")
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		s.exchangeCode(w, r, clientID)
	case "refresh_token":
		s.refresh(w, r, clientID)
	default:
		oauthError(w, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.")
	}
}

func (s *Server) exchangeCode(w http.ResponseWriter, r *http.Request, clientID string) {
	f := r.PostForm
	var c struct {
		client, name, user, redirect, challenge, resource string
		readOnly                                          bool
		expires                                           int64
	}
	hash := hashToken(f.Get("code"))
	err := s.r.QueryRow(`SELECT client_id, client_name, user_id, redirect_uri, challenge, read_only, resource, expires FROM oauth_codes WHERE hash = ?`, hash).
		Scan(&c.client, &c.name, &c.user, &c.redirect, &c.challenge, &c.readOnly, &c.resource, &c.expires)
	// A code works once.
	res, _ := s.w.Exec(`DELETE FROM oauth_codes WHERE hash = ?`, hash)
	if n, _ := res.RowsAffected(); err != nil || n == 0 || c.expires < now() {
		oauthError(w, 400, "invalid_grant", "That authorization code is not valid. Start the connection again.")
		return
	}
	sum := sha256.Sum256([]byte(f.Get("code_verifier")))
	switch {
	case c.client != clientID:
		oauthError(w, 400, "invalid_grant", "That code was issued to another app.")
		return
	case f.Get("redirect_uri") != "" && f.Get("redirect_uri") != c.redirect:
		oauthError(w, 400, "invalid_grant", "The redirect address does not match the authorization request.")
		return
	case base64.RawURLEncoding.EncodeToString(sum[:]) != c.challenge:
		oauthError(w, 400, "invalid_grant", "The code verifier does not match (PKCE).")
		return
	case f.Get("resource") != "" && !s.ownResource(r, f.Get("resource")):
		oauthError(w, 400, "invalid_target", "That resource is not served here.")
		return
	}
	access, refresh := newSecret(), "osr_"+newToken()
	t := now()
	_, err = s.w.Exec(`INSERT INTO api_tokens(id, user_id, name, prefix, hash, read_only, created, until, expires, client_id, refresh_hash, resource) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		newID(12), c.user, c.name, access[:len(tokenPrefix)+5], hashToken(access), c.readOnly, t, t+accessTTL, t+refreshTTL, clientID, hashToken(refresh), c.resource)
	if err != nil {
		oauthError(w, 500, "server_error", "storage error")
		return
	}
	writeJSON(w, 200, tokenAnswer{access, "Bearer", accessTTL, refresh, scopeOf(c.readOnly)})
}

// refresh rotates a connection's tokens: each refresh token works once.
func (s *Server) refresh(w http.ResponseWriter, r *http.Request, clientID string) {
	old := hashToken(r.PostForm.Get("refresh_token"))
	var id, client string
	var readOnly bool
	var expires int64
	if s.r.QueryRow(`SELECT t.id, t.client_id, t.read_only, t.expires FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.refresh_hash = ? AND u.status = 'active'`, old).Scan(&id, &client, &readOnly, &expires) != nil || expires < now() {
		oauthError(w, 400, "invalid_grant", "That refresh token is not valid. Connect the app again.")
		return
	}
	if client != clientID {
		oauthError(w, 400, "invalid_grant", "That refresh token was issued to another app.")
		return
	}
	// Asking for less is allowed; asking for more needs the person again.
	if scopes := strings.Fields(r.PostForm.Get("scope")); len(scopes) > 0 && !slices.Contains(scopes, "write") {
		readOnly = true
	}
	access, refresh := newSecret(), "osr_"+newToken()
	t := now()
	res, err := s.w.Exec(`UPDATE api_tokens SET hash = ?, prefix = ?, refresh_hash = ?, read_only = ?, until = ?, expires = ? WHERE id = ? AND refresh_hash = ?`,
		hashToken(access), access[:len(tokenPrefix)+5], hashToken(refresh), readOnly, t+accessTTL, t+refreshTTL, id, old)
	if n, _ := res.RowsAffected(); err != nil || n == 0 {
		oauthError(w, 400, "invalid_grant", "That refresh token has already been used.")
		return
	}
	writeJSON(w, 200, tokenAnswer{access, "Bearer", accessTTL, refresh, scopeOf(readOnly)})
}

// handleRevoke ends a connection given either of its tokens (RFC 7009).
func (s *Server) handleRevoke(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if r.ParseForm() != nil {
		oauthError(w, 400, "invalid_request", "The request must be form-encoded.")
		return
	}
	clientID, authed := s.clientAuth(r)
	if !authed {
		oauthError(w, 401, "invalid_client", "The client could not be authenticated.")
		return
	}
	h := hashToken(r.PostForm.Get("token"))
	s.w.Exec(`DELETE FROM api_tokens WHERE client_id = ? AND (hash = ? OR refresh_hash = ?)`, clientID, h, h)
	w.WriteHeader(200)
}
