package main

// External Slack channel bridging ("Open Suite Connect"): lets an Open Suite
// organisation link a Chat room to a channel in an external Slack workspace
// through a one-time invite link and standard Slack OAuth2 + Events API.
//
// Messages flow in real time in both directions with no extra daemons:
//   Slack -> Open Suite: Events API webhook -> Matrix appservice ghost users
//   Open Suite -> Slack: Matrix appservice transactions -> chat.postMessage
//
// Everything stays dormant unless OS_SLACK_CLIENT_ID, OS_SLACK_CLIENT_SECRET
// and OS_SLACK_SIGNING_SECRET are set.

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const schemaSlack = `
CREATE TABLE IF NOT EXISTS slack_invites(
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  room_name TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS slack_invites_room ON slack_invites(org_id, room_id);

CREATE TABLE IF NOT EXISTS slack_installs(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  bot_user_id TEXT NOT NULL DEFAULT '',
  bot_token TEXT NOT NULL,
  installed_by TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(org_id, team_id)
);

CREATE TABLE IF NOT EXISTS slack_links(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  install_id TEXT NOT NULL REFERENCES slack_installs(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  UNIQUE(room_id, team_id, channel_id)
);
CREATE INDEX IF NOT EXISTS slack_links_room ON slack_links(room_id);
CREATE INDEX IF NOT EXISTS slack_links_slack ON slack_links(team_id, channel_id);

CREATE TABLE IF NOT EXISTS slack_users(
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  mx_local TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL,
  PRIMARY KEY(team_id, slack_user_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS slack_messages(
  link_id TEXT NOT NULL REFERENCES slack_links(id) ON DELETE CASCADE,
  matrix_event_id TEXT NOT NULL,
  slack_ts TEXT NOT NULL,
  thread_ts TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(link_id, matrix_event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS slack_messages_ts ON slack_messages(link_id, slack_ts);
`

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		_, err := w.Exec(schemaSlack)
		return err
	})
}

const (
	slackBridgeLocal  = "opensuite-bridge"
	slackGhostPrefix  = "slack_"
	slackInviteTTL    = 7 * 86400
	slackOAuthCookie  = "os_slack_oauth"
	slackPickCookie   = "os_slack_pick"
	slackMaxFileBytes = 25 << 20
)

// slackBotScopes are the minimum bot scopes for forward-only channel bridging.
// No user tokens and no bulk workspace-history scraping are requested.
const slackBotScopes = "channels:read,groups:read,channels:history,groups:history,channels:join,channels:manage,chat:write,chat:write.customize,files:read,files:write,reactions:read,reactions:write,users:read"

type slackBridge struct {
	mu       sync.Mutex
	txns     map[string]int64
	channels map[string]*slackPacer
	sem      chan struct{}
}

// slackPacer enforces Slack's ~1 message/second/channel guidance and backs off
// cleanly when Slack replies with HTTP 429 Retry-After.
type slackPacer struct {
	mu   sync.Mutex
	next time.Time
}

func (p *slackPacer) wait(ctx context.Context, minGap time.Duration) error {
	p.mu.Lock()
	now := time.Now()
	wait := time.Until(p.next)
	if wait < 0 {
		wait = 0
		p.next = now.Add(minGap)
	} else {
		p.next = p.next.Add(minGap)
	}
	p.mu.Unlock()
	if wait == 0 {
		return nil
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (p *slackPacer) backoff(d time.Duration) {
	p.mu.Lock()
	if until := time.Now().Add(d); until.After(p.next) {
		p.next = until
	}
	p.mu.Unlock()
}

func newSlackBridge() *slackBridge {
	return &slackBridge{
		txns:     map[string]int64{},
		channels: map[string]*slackPacer{},
		sem:      make(chan struct{}, 16),
	}
}

func (b *slackBridge) pacer(key string) *slackPacer {
	b.mu.Lock()
	defer b.mu.Unlock()
	p := b.channels[key]
	if p == nil {
		p = &slackPacer{}
		b.channels[key] = p
	}
	return p
}

func (b *slackBridge) seenTxn(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := now()
	if len(b.txns) > 4096 {
		for k, at := range b.txns {
			if t-at > 3600 {
				delete(b.txns, k)
			}
		}
	}
	if _, dup := b.txns[id]; dup {
		return true
	}
	b.txns[id] = t
	return false
}

func (s *Server) slackEnabled() bool {
	return s.cfg.SlackClientID != "" && s.cfg.SlackClientSecret != "" && s.cfg.SlackSigningSecret != ""
}

func (s *Server) slackAPIBase() string {
	if s.cfg.SlackAPIBase != "" {
		return strings.TrimRight(s.cfg.SlackAPIBase, "/")
	}
	return "https://slack.com/api"
}

func (s *Server) slackOAuthBase() string {
	if s.cfg.SlackOAuthBase != "" {
		return s.cfg.SlackOAuthBase
	}
	return "https://slack.com/oauth/v2/authorize"
}

func (s *Server) slackAsToken() string { return s.deriveHex("slack-as-token") }
func (s *Server) slackHsToken() string { return s.deriveHex("slack-hs-token") }

func (s *Server) slackManifest() string {
	base := strings.TrimRight(s.cfg.BridgeURL, "/")
	if base == "" {
		base = "http://" + s.cfg.Listen
	}
	escapedDomain := regexp.QuoteMeta(s.cfg.MatrixName)
	return fmt.Sprintf(`id: opensuite-slack
url: %s/_opensuite/as
as_token: %s
hs_token: %s
sender_localpart: %s
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@%s.*:%s"
  aliases: []
  rooms: []
`, base, s.slackAsToken(), s.slackHsToken(), slackBridgeLocal, slackGhostPrefix, escapedDomain)
}

func (s *Server) routesSlack(m *http.ServeMux) {
	// Open Suite users managing external Slack links on a Chat room.
	m.HandleFunc("GET /api/chat/rooms/{roomId}/slack", s.auth(s.handleSlackRoomStatus))
	m.HandleFunc("POST /api/chat/rooms/{roomId}/slack/invites", s.auth(s.handleSlackInviteCreate))
	m.HandleFunc("DELETE /api/chat/rooms/{roomId}/slack/invites/{token}", s.auth(s.handleSlackInviteDelete))
	m.HandleFunc("DELETE /api/chat/rooms/{roomId}/slack/links/{linkId}", s.auth(s.handleSlackLinkDelete))

	// Public invite + OAuth flow for external Slack partners.
	m.HandleFunc("GET /api/slack/invite/{token}", s.handleSlackInviteInfo)
	m.HandleFunc("GET /api/slack/oauth/start", s.handleSlackOAuthStart)
	m.HandleFunc("GET /api/slack/oauth/callback", s.handleSlackOAuthCallback)
	m.HandleFunc("GET /api/slack/invite/{token}/channels", s.handleSlackInviteChannels)
	m.HandleFunc("POST /api/slack/invite/{token}/link", s.handleSlackInviteLink)

	// Slack Events API webhook (server-to-server, HMAC-signed by Slack).
	m.HandleFunc("POST /api/slack/events", s.handleSlackEvents)

	// Matrix Application Service callbacks (loopback only, authenticated by hs_token).
	m.HandleFunc("PUT /_opensuite/as/_matrix/app/v1/transactions/{txnId}", s.handleAppserviceTxn)
	m.HandleFunc("PUT /_opensuite/as/transactions/{txnId}", s.handleAppserviceTxn)
	m.HandleFunc("GET /_opensuite/as/_matrix/app/v1/users/{userId}", s.handleAppserviceQuery)
	m.HandleFunc("GET /_opensuite/as/users/{userId}", s.handleAppserviceQuery)
	m.HandleFunc("GET /_opensuite/as/_matrix/app/v1/rooms/{roomAlias}", s.handleAppserviceQuery)
	m.HandleFunc("GET /_opensuite/as/rooms/{roomAlias}", s.handleAppserviceQuery)
}

func (s *Server) slackJanitor() {
	s.w.Exec(`DELETE FROM slack_invites WHERE expires < ?`, now()-7*86400)
	s.w.Exec(`DELETE FROM slack_messages WHERE created < ?`, now()-180*86400)
}

// --- encryption at rest for Slack bot tokens and signed state cookies ---

func (s *Server) sealSecret(plain string) (string, error) {
	blk, err := aes.NewCipher(s.derive("slack-token-key"))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return "v1:" + base64.RawStdEncoding.EncodeToString(out), nil
}

func (s *Server) openSecret(enc string) (string, error) {
	raw, ok := strings.CutPrefix(enc, "v1:")
	if !ok {
		return "", errf("unknown secret format")
	}
	buf, err := base64.RawStdEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	blk, err := aes.NewCipher(s.derive("slack-token-key"))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(buf) < ns {
		return "", errf("truncated secret")
	}
	plain, err := gcm.Open(nil, buf[:ns], buf[ns:], nil)
	return string(plain), err
}

func (s *Server) signCookieValue(purpose, payload string) string {
	m := hmac.New(sha256.New, s.derive(purpose))
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(m.Sum(nil))
}

func (s *Server) verifyCookieValue(purpose, val string) (string, bool) {
	a, sig, ok := strings.Cut(val, ".")
	if !ok {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(a)
	if err != nil {
		return "", false
	}
	m := hmac.New(sha256.New, s.derive(purpose))
	m.Write(raw)
	want := hex.EncodeToString(m.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return "", false
	}
	return string(raw), true
}

func requestOrigin(r *http.Request, fallbackDomain string) string {
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := r.Host
	if host == "" {
		host = fallbackDomain
	}
	return proto + "://" + host
}

// --- Matrix room membership and appservice helpers ---

func (s *Server) userInRoom(ctx context.Context, u *User, roomID string) bool {
	if s.cfg.MatrixURL == "" {
		return false
	}
	if u.MxToken == "" {
		return false
	}
	var out struct {
		JoinedRooms []string `json:"joined_rooms"`
	}
	if _, err := s.matrix(ctx, "GET", "/_matrix/client/v3/joined_rooms", u.MxToken, nil, &out); err != nil {
		return false
	}
	for _, r := range out.JoinedRooms {
		if r == roomID {
			return true
		}
	}
	return false
}

func (s *Server) asMatrix(ctx context.Context, method, path, userID string, body, out any) (int, error) {
	if s.cfg.MatrixURL == "" {
		return 0, errf("chat engine is not configured")
	}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	full := path
	if userID != "" {
		full += sep + "user_id=" + url.QueryEscape(userID)
	}
	return s.matrix(ctx, method, full, s.slackAsToken(), body, out)
}

func (s *Server) asUploadMedia(ctx context.Context, userID, filename, ctype string, data []byte) (string, error) {
	if s.cfg.MatrixURL == "" {
		return "", errf("chat engine is not configured")
	}
	u := s.cfg.MatrixURL + "/_matrix/media/v3/upload?filename=" + url.QueryEscape(filename)
	if userID != "" {
		u += "&user_id=" + url.QueryEscape(userID)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+s.slackAsToken())
	res, err := s.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return "", errf("matrix upload: %d %s", res.StatusCode, raw)
	}
	var out struct {
		ContentURI string `json:"content_uri"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.ContentURI == "" {
		return "", errf("matrix upload: missing content_uri")
	}
	return out.ContentURI, nil
}

func (s *Server) asDownloadMedia(ctx context.Context, mxc string) ([]byte, string, error) {
	rest, ok := strings.CutPrefix(mxc, "mxc://")
	if !ok {
		return nil, "", errf("invalid mxc uri")
	}
	serverName, mediaID, ok := strings.Cut(rest, "/")
	if !ok || serverName == "" || mediaID == "" {
		return nil, "", errf("invalid mxc uri")
	}
	paths := []string{
		"/_matrix/client/v1/media/download/" + url.PathEscape(serverName) + "/" + url.PathEscape(mediaID),
		"/_matrix/media/v3/download/" + url.PathEscape(serverName) + "/" + url.PathEscape(mediaID),
	}
	var lastErr error
	for _, p := range paths {
		req, err := http.NewRequestWithContext(ctx, "GET", s.cfg.MatrixURL+p, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Authorization", "Bearer "+s.slackAsToken())
		res, err := s.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		data, rerr := io.ReadAll(io.LimitReader(res.Body, slackMaxFileBytes+1))
		ctype := res.Header.Get("Content-Type")
		res.Body.Close()
		if res.StatusCode == 200 && rerr == nil {
			if len(data) > slackMaxFileBytes {
				return nil, "", errf("file too large")
			}
			return data, ctype, nil
		}
		lastErr = errf("matrix download %s: %d", p, res.StatusCode)
	}
	return nil, "", lastErr
}

func (s *Server) ensureBridgeInRoom(ctx context.Context, inviter *User, roomID string) {
	bridgeMX := s.mxid(slackBridgeLocal)
	// Register the bridge user idempotently, invite via the room member, then join.
	s.asMatrix(ctx, "POST", "/_matrix/client/v3/register", "", map[string]any{
		"type": "m.login.application_service", "username": slackBridgeLocal,
	}, nil)
	s.asMatrix(ctx, "PUT", "/_matrix/client/v3/profile/"+url.PathEscape(bridgeMX)+"/displayname", bridgeMX,
		map[string]string{"displayname": "Open Suite Connect"}, nil)
	if inviter != nil && inviter.MxToken != "" {
		s.matrix(ctx, "POST", "/_matrix/client/v3/rooms/"+url.PathEscape(roomID)+"/invite", inviter.MxToken,
			map[string]string{"user_id": bridgeMX}, nil)
	}
	s.asMatrix(ctx, "POST", "/_matrix/client/v3/join/"+url.PathEscape(roomID), bridgeMX, map[string]any{}, nil)
}

func sanitizeMxLocal(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (s *Server) ensureSlackGhost(ctx context.Context, teamID, teamName, slackUserID, botToken, roomID, createdBy string) string {
	local := slackGhostPrefix + sanitizeMxLocal(teamID) + "_" + sanitizeMxLocal(slackUserID)
	mxid := s.mxid(local)

	var displayName string
	var updated int64
	err := s.r.QueryRow(`SELECT display_name, updated FROM slack_users WHERE team_id = ? AND slack_user_id = ?`, teamID, slackUserID).
		Scan(&displayName, &updated)
	if err != nil || now()-updated > 6*3600 {
		name, avatar := s.fetchSlackUser(ctx, botToken, slackUserID)
		if name == "" {
			name = "Slack user"
		}
		if teamName != "" {
			displayName = name + " (" + teamName + ")"
		} else {
			displayName = name
		}
		s.w.Exec(`INSERT INTO slack_users(team_id, slack_user_id, mx_local, display_name, avatar_url, updated) VALUES(?,?,?,?,?,?)
			ON CONFLICT(team_id, slack_user_id) DO UPDATE SET display_name=excluded.display_name, avatar_url=excluded.avatar_url, updated=excluded.updated`,
			teamID, slackUserID, local, displayName, avatar, now())
	}

	// Ensure ghost account exists on Tuwunel and has the right display name.
	s.asMatrix(ctx, "POST", "/_matrix/client/v3/register", "", map[string]any{
		"type": "m.login.application_service", "username": local,
	}, nil)
	if displayName != "" {
		s.asMatrix(ctx, "PUT", "/_matrix/client/v3/profile/"+url.PathEscape(mxid)+"/displayname", mxid,
			map[string]string{"displayname": displayName}, nil)
	}

	// Invite and join the ghost into the linked room. Try bridge bot first,
	// falling back to the user who created the link if custom power levels apply.
	bridgeMX := s.mxid(slackBridgeLocal)
	if _, err := s.asMatrix(ctx, "POST", "/_matrix/client/v3/rooms/"+url.PathEscape(roomID)+"/invite", bridgeMX,
		map[string]string{"user_id": mxid}, nil); err != nil && createdBy != "" {
		if u := s.userByID(createdBy); u != nil && u.MxToken != "" {
			s.matrix(ctx, "POST", "/_matrix/client/v3/rooms/"+url.PathEscape(roomID)+"/invite", u.MxToken,
				map[string]string{"user_id": mxid}, nil)
		}
	}
	s.asMatrix(ctx, "POST", "/_matrix/client/v3/join/"+url.PathEscape(roomID), mxid, map[string]any{}, nil)
	return mxid
}

// --- Open Suite API: room links and invites ---

type SlackLinkView struct {
	ID          string `json:"id"`
	TeamID      string `json:"teamId"`
	TeamName    string `json:"teamName"`
	ChannelID   string `json:"channelId"`
	ChannelName string `json:"channelName"`
	Created     int64  `json:"created"`
}

type SlackInviteView struct {
	Token   string `json:"token"`
	URL     string `json:"url"`
	Created int64  `json:"created"`
	Expires int64  `json:"expires"`
}

func (s *Server) handleSlackRoomStatus(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.slackEnabled() {
		ok(w, map[string]any{"enabled": false, "links": []SlackLinkView{}, "invites": []SlackInviteView{}})
		return
	}
	roomID := r.PathValue("roomId")
	if !s.userInRoom(r.Context(), u, roomID) {
		fail(w, 403, "You aren't a member of this conversation.")
		return
	}
	links := []SlackLinkView{}
	if rows, err := s.r.Query(`SELECT id, team_id, team_name, channel_id, channel_name, created FROM slack_links
		WHERE org_id = ? AND room_id = ? ORDER BY created`, u.OrgID, roomID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var l SlackLinkView
			rows.Scan(&l.ID, &l.TeamID, &l.TeamName, &l.ChannelID, &l.ChannelName, &l.Created)
			links = append(links, l)
		}
	}
	invites := []SlackInviteView{}
	origin := requestOrigin(r, s.cfg.Domain)
	if rows, err := s.r.Query(`SELECT token, created, expires FROM slack_invites
		WHERE org_id = ? AND room_id = ? AND used = 0 AND expires > ? ORDER BY created DESC`, u.OrgID, roomID, now()); err == nil {
		defer rows.Close()
		for rows.Next() {
			var inv SlackInviteView
			rows.Scan(&inv.Token, &inv.Created, &inv.Expires)
			inv.URL = origin + "/connect/slack/" + inv.Token
			invites = append(invites, inv)
		}
	}
	ok(w, map[string]any{"enabled": true, "links": links, "invites": invites})
}

func (s *Server) handleSlackInviteCreate(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.slackEnabled() {
		fail(w, 404, "Slack connections are not enabled on this server.")
		return
	}
	roomID := r.PathValue("roomId")
	if !s.userInRoom(r.Context(), u, roomID) {
		fail(w, 403, "You aren't a member of this conversation.")
		return
	}
	var in struct{ RoomName string }
	readJSON(r, &in)
	roomName := strings.TrimSpace(in.RoomName)
	if len(roomName) > 120 {
		roomName = roomName[:120]
	}
	tok := newID(24)
	t := now()
	exp := t + slackInviteTTL
	if _, err := s.w.Exec(`INSERT INTO slack_invites(token, org_id, room_id, room_name, created_by, created, expires) VALUES(?,?,?,?,?,?,?)`,
		tok, u.OrgID, roomID, roomName, u.ID, t, exp); err != nil {
		fail(w, 500, "storage error")
		return
	}
	// Invite the bridge bot now while we have the creator's active session.
	go s.ensureBridgeInRoom(context.Background(), u, roomID)
	ok(w, SlackInviteView{
		Token:   tok,
		URL:     requestOrigin(r, s.cfg.Domain) + "/connect/slack/" + tok,
		Created: t,
		Expires: exp,
	})
}

func (s *Server) handleSlackInviteDelete(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.slackEnabled() {
		fail(w, 404, "Slack connections are not enabled on this server.")
		return
	}
	roomID := r.PathValue("roomId")
	if !s.userInRoom(r.Context(), u, roomID) {
		fail(w, 403, "You aren't a member of this conversation.")
		return
	}
	s.w.Exec(`DELETE FROM slack_invites WHERE token = ? AND org_id = ? AND room_id = ?`, r.PathValue("token"), u.OrgID, roomID)
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handleSlackLinkDelete(w http.ResponseWriter, r *http.Request, u *User) {
	if !s.slackEnabled() {
		fail(w, 404, "Slack connections are not enabled on this server.")
		return
	}
	roomID := r.PathValue("roomId")
	if !s.userInRoom(r.Context(), u, roomID) {
		fail(w, 403, "You aren't a member of this conversation.")
		return
	}
	res, _ := s.w.Exec(`DELETE FROM slack_links WHERE id = ? AND org_id = ? AND room_id = ?`, r.PathValue("linkId"), u.OrgID, roomID)
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 404, "No such connection.")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

// --- Public invite & OAuth flow for external Slack partners ---

type slackInviteRecord struct {
	Token, OrgID, OrgName, RoomID, RoomName, CreatedBy string
	Expires                                            int64
	Used                                               bool
}

func (s *Server) loadSlackInvite(token string) *slackInviteRecord {
	var inv slackInviteRecord
	var used int
	err := s.r.QueryRow(`SELECT i.token, i.org_id, o.name, i.room_id, i.room_name, i.created_by, i.expires, i.used
		FROM slack_invites i JOIN orgs o ON o.id = i.org_id WHERE i.token = ?`, token).
		Scan(&inv.Token, &inv.OrgID, &inv.OrgName, &inv.RoomID, &inv.RoomName, &inv.CreatedBy, &inv.Expires, &used)
	if err != nil {
		return nil
	}
	inv.Used = used != 0
	return &inv
}

func (s *Server) handleSlackInviteInfo(w http.ResponseWriter, r *http.Request) {
	if !s.slackEnabled() {
		fail(w, 404, "Slack connections are not enabled on this server.")
		return
	}
	inv := s.loadSlackInvite(r.PathValue("token"))
	if inv == nil {
		fail(w, 404, "This invite link doesn't exist or was revoked.")
		return
	}
	if inv.Used {
		fail(w, 410, "This invite link has already been used.")
		return
	}
	if inv.Expires < now() {
		fail(w, 410, "This invite link has expired. Ask for a new one.")
		return
	}
	// Check whether this browser already completed the Slack OAuth step.
	teamName := ""
	if installID, ok := s.verifyPickCookie(r, inv.Token); ok {
		s.r.QueryRow(`SELECT team_name FROM slack_installs WHERE id = ? AND org_id = ?`, installID, inv.OrgID).Scan(&teamName)
	}
	ok(w, map[string]any{
		"org":          inv.OrgName,
		"roomName":     inv.RoomName,
		"expires":      inv.Expires,
		"authorizeUrl": "/api/slack/oauth/start?token=" + url.QueryEscape(inv.Token),
		"authorized":   teamName != "",
		"teamName":     teamName,
	})
}

func (s *Server) handleSlackOAuthStart(w http.ResponseWriter, r *http.Request) {
	if !s.slackEnabled() {
		http.NotFound(w, r)
		return
	}
	tok := r.URL.Query().Get("token")
	inv := s.loadSlackInvite(tok)
	if inv == nil || inv.Used || inv.Expires < now() {
		http.Redirect(w, r, "/connect/slack/"+url.PathEscape(tok), http.StatusFound)
		return
	}
	nonce := newID(16)
	statePayload := tok + "|" + nonce
	signed := s.signCookieValue("slack-oauth", statePayload)
	http.SetCookie(w, &http.Cookie{
		Name: slackOAuthCookie, Value: signed, Path: "/api/slack/", MaxAge: 900,
		HttpOnly: true, Secure: r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteLaxMode,
	})
	redirectURI := requestOrigin(r, s.cfg.Domain) + "/api/slack/oauth/callback"
	q := url.Values{
		"client_id":    {s.cfg.SlackClientID},
		"scope":        {slackBotScopes},
		"redirect_uri": {redirectURI},
		"state":        {signed},
	}
	http.Redirect(w, r, s.slackOAuthBase()+"?"+q.Encode(), http.StatusFound)
}

func (s *Server) handleSlackOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !s.slackEnabled() {
		http.NotFound(w, r)
		return
	}
	state := r.URL.Query().Get("state")
	c, err := r.Cookie(slackOAuthCookie)
	if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(state)) != 1 {
		fail(w, 400, "That authorisation session expired. Start again from the invite link.")
		return
	}
	payload, valid := s.verifyCookieValue("slack-oauth", state)
	if !valid {
		fail(w, 400, "Invalid authorisation state.")
		return
	}
	tok, _, _ := strings.Cut(payload, "|")
	http.SetCookie(w, &http.Cookie{Name: slackOAuthCookie, Value: "", Path: "/api/slack/", MaxAge: -1, HttpOnly: true})

	if r.URL.Query().Get("error") != "" {
		http.Redirect(w, r, "/connect/slack/"+url.PathEscape(tok)+"?error=cancelled", http.StatusFound)
		return
	}
	inv := s.loadSlackInvite(tok)
	if inv == nil || inv.Used || inv.Expires < now() {
		http.Redirect(w, r, "/connect/slack/"+url.PathEscape(tok), http.StatusFound)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail(w, 400, "Missing Slack authorisation code.")
		return
	}

	form := url.Values{
		"client_id":     {s.cfg.SlackClientID},
		"client_secret": {s.cfg.SlackClientSecret},
		"code":          {code},
		"redirect_uri":  {requestOrigin(r, s.cfg.Domain) + "/api/slack/oauth/callback"},
	}
	req, _ := http.NewRequestWithContext(r.Context(), "POST", s.slackAPIBase()+"/oauth.v2.access", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := s.http.Do(req)
	if err != nil {
		http.Redirect(w, r, "/connect/slack/"+url.PathEscape(tok)+"?error=oauth", http.StatusFound)
		return
	}
	defer res.Body.Close()
	var out struct {
		OK          bool   `json:"ok"`
		Error       string `json:"error"`
		AccessToken string `json:"access_token"`
		BotUserID   string `json:"bot_user_id"`
		Team        struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"team"`
		AuthedUser struct {
			ID string `json:"id"`
		} `json:"authed_user"`
	}
	json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	if !out.OK || out.AccessToken == "" || out.Team.ID == "" {
		log.Printf("slack: oauth failed: %s", out.Error)
		http.Redirect(w, r, "/connect/slack/"+url.PathEscape(tok)+"?error=oauth", http.StatusFound)
		return
	}

	sealed, err := s.sealSecret(out.AccessToken)
	if err != nil {
		fail(w, 500, "encryption error")
		return
	}
	t := now()
	var installID string
	if s.r.QueryRow(`SELECT id FROM slack_installs WHERE org_id = ? AND team_id = ?`, inv.OrgID, out.Team.ID).Scan(&installID) == nil {
		s.w.Exec(`UPDATE slack_installs SET team_name = ?, bot_user_id = ?, bot_token = ?, installed_by = ?, updated = ? WHERE id = ?`,
			out.Team.Name, out.BotUserID, sealed, out.AuthedUser.ID, t, installID)
	} else {
		installID = newID(14)
		s.w.Exec(`INSERT INTO slack_installs(id, org_id, team_id, team_name, bot_user_id, bot_token, installed_by, created, updated) VALUES(?,?,?,?,?,?,?,?,?)`,
			installID, inv.OrgID, out.Team.ID, out.Team.Name, out.BotUserID, sealed, out.AuthedUser.ID, t, t)
	}

	pickVal := s.signCookieValue("slack-pick", fmt.Sprintf("%s|%s|%d", tok, installID, t+1800))
	http.SetCookie(w, &http.Cookie{
		Name: slackPickCookie, Value: pickVal, Path: "/api/slack/", MaxAge: 1800,
		HttpOnly: true, Secure: r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/connect/slack/"+url.PathEscape(tok)+"?step=pick", http.StatusFound)
}

func (s *Server) verifyPickCookie(r *http.Request, wantToken string) (string, bool) {
	c, err := r.Cookie(slackPickCookie)
	if err != nil {
		return "", false
	}
	raw, ok := s.verifyCookieValue("slack-pick", c.Value)
	if !ok {
		return "", false
	}
	parts := strings.Split(raw, "|")
	if len(parts) != 3 || parts[0] != wantToken {
		return "", false
	}
	exp, _ := strconv.ParseInt(parts[2], 10, 64)
	if exp < now() {
		return "", false
	}
	return parts[1], true
}

func (s *Server) loadInstall(id, orgID string) (teamID, teamName, botUserID, botToken string, err error) {
	var enc string
	err = s.r.QueryRow(`SELECT team_id, team_name, bot_user_id, bot_token FROM slack_installs WHERE id = ? AND org_id = ?`, id, orgID).
		Scan(&teamID, &teamName, &botUserID, &enc)
	if err != nil {
		return
	}
	botToken, err = s.openSecret(enc)
	return
}

func (s *Server) handleSlackInviteChannels(w http.ResponseWriter, r *http.Request) {
	if !s.slackEnabled() {
		fail(w, 404, "Slack connections are not enabled on this server.")
		return
	}
	tok := r.PathValue("token")
	inv := s.loadSlackInvite(tok)
	if inv == nil || inv.Used || inv.Expires < now() {
		fail(w, 410, "This invite link is no longer valid.")
		return
	}
	installID, valid := s.verifyPickCookie(r, tok)
	if !valid {
		fail(w, 401, "Connect your Slack workspace first.")
		return
	}
	_, teamName, _, botToken, err := s.loadInstall(installID, inv.OrgID)
	if err != nil {
		fail(w, 401, "Slack authorisation expired. Start again.")
		return
	}
	var out struct {
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
		Channels []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			IsPrivate bool   `json:"is_private"`
			IsMember  bool   `json:"is_member"`
		} `json:"channels"`
	}
	err = s.slackAPI(r.Context(), botToken, "GET", "/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200", nil, &out)
	if err != nil || !out.OK {
		fail(w, 502, "Couldn't read Slack channels. Try again.")
		return
	}
	type chanItem struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Private bool   `json:"private"`
	}
	list := make([]chanItem, 0, len(out.Channels))
	for _, ch := range out.Channels {
		list = append(list, chanItem{ID: ch.ID, Name: ch.Name, Private: ch.IsPrivate})
	}
	ok(w, map[string]any{"teamName": teamName, "channels": list})
}

var slackChannelNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,79}$`)

func (s *Server) handleSlackInviteLink(w http.ResponseWriter, r *http.Request) {
	if !s.slackEnabled() {
		fail(w, 404, "Slack connections are not enabled on this server.")
		return
	}
	tok := r.PathValue("token")
	inv := s.loadSlackInvite(tok)
	if inv == nil || inv.Used || inv.Expires < now() {
		fail(w, 410, "This invite link is no longer valid.")
		return
	}
	installID, valid := s.verifyPickCookie(r, tok)
	if !valid {
		fail(w, 401, "Connect your Slack workspace first.")
		return
	}
	teamID, teamName, _, botToken, err := s.loadInstall(installID, inv.OrgID)
	if err != nil {
		fail(w, 401, "Slack authorisation expired. Start again.")
		return
	}
	var in struct {
		ChannelID   string `json:"channelId"`
		ChannelName string `json:"channelName"`
		CreateName  string `json:"createName"`
	}
	if readJSON(r, &in) != nil {
		fail(w, 400, "bad request")
		return
	}

	channelID := strings.TrimSpace(in.ChannelID)
	channelName := strings.TrimSpace(in.ChannelName)
	if create := strings.ToLower(strings.TrimSpace(in.CreateName)); create != "" {
		if !slackChannelNameRe.MatchString(create) {
			fail(w, 400, "Channel names use lowercase letters, digits, dashes or underscores.")
			return
		}
		var created struct {
			OK      bool   `json:"ok"`
			Error   string `json:"error"`
			Channel struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"channel"`
		}
		if err := s.slackAPI(r.Context(), botToken, "POST", "/conversations.create", map[string]any{"name": create}, &created); err != nil || !created.OK {
			msg := "Couldn't create that Slack channel."
			if created.Error == "name_taken" {
				msg = "A channel with that name already exists. Select it from the list instead."
			}
			fail(w, 400, msg)
			return
		}
		channelID = created.Channel.ID
		channelName = created.Channel.Name
	} else {
		if channelID == "" {
			fail(w, 400, "Choose a Slack channel to connect.")
			return
		}
		// Join public channels automatically; private channels require the bot to be invited already.
		var joinRes struct {
			OK      bool   `json:"ok"`
			Error   string `json:"error"`
			Channel struct {
				Name string `json:"name"`
			} `json:"channel"`
		}
		s.slackAPI(r.Context(), botToken, "POST", "/conversations.join", map[string]any{"channel": channelID}, &joinRes)
		if joinRes.Channel.Name != "" {
			channelName = joinRes.Channel.Name
		}
	}

	linkID := newID(14)
	t := now()
	tx, err := s.w.Begin()
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO slack_links(id, org_id, room_id, install_id, team_id, team_name, channel_id, channel_name, created_by, created)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(room_id, team_id, channel_id) DO UPDATE SET install_id=excluded.install_id, team_name=excluded.team_name, channel_name=excluded.channel_name`,
		linkID, inv.OrgID, inv.RoomID, installID, teamID, teamName, channelID, channelName, inv.CreatedBy, t); err != nil {
		fail(w, 500, "storage error")
		return
	}
	tx.Exec(`UPDATE slack_invites SET used = 1 WHERE token = ?`, tok)
	if err := tx.Commit(); err != nil {
		fail(w, 500, "storage error")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: slackPickCookie, Value: "", Path: "/api/slack/", MaxAge: -1, HttpOnly: true})

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		creator := s.userByID(inv.CreatedBy)
		s.ensureBridgeInRoom(ctx, creator, inv.RoomID)
		label := inv.OrgName
		if inv.RoomName != "" {
			label = inv.RoomName + " (" + inv.OrgName + ")"
		}
		s.slackAPI(ctx, botToken, "POST", "/chat.postMessage", map[string]any{
			"channel": channelID,
			"text":    fmt.Sprintf("Connected to %s on Open Suite. Messages sent here from now on will appear in both places.", label),
		}, nil)
	}()

	ok(w, map[string]any{
		"ok":          true,
		"teamName":    teamName,
		"channelName": channelName,
		"org":         inv.OrgName,
		"roomName":    inv.RoomName,
	})
}

// --- Slack Events API webhook (Slack -> Matrix) ---

func verifySlackSignature(secret, ts, sig string, body []byte) bool {
	if secret == "" || ts == "" || sig == "" {
		return false
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	diff := now() - sec
	if diff < -300 || diff > 300 {
		return false
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("v0:" + ts + ":"))
	m.Write(body)
	want := "v0=" + hex.EncodeToString(m.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(sig), []byte(want)) == 1
}

type slackEventEnvelope struct {
	Type      string          `json:"type"`
	Challenge string          `json:"challenge"`
	TeamID    string          `json:"team_id"`
	Event     json.RawMessage `json:"event"`
}

type slackEventPayload struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	Channel   string `json:"channel"`
	User      string `json:"user"`
	BotID     string `json:"bot_id"`
	Text      string `json:"text"`
	TS        string `json:"ts"`
	ThreadTS  string `json:"thread_ts"`
	DeletedTS string `json:"deleted_ts"`
	Reaction  string `json:"reaction"`
	Item      struct {
		Type    string `json:"type"`
		Channel string `json:"channel"`
		TS      string `json:"ts"`
	} `json:"item"`
	Message *struct {
		User     string `json:"user"`
		BotID    string `json:"bot_id"`
		Text     string `json:"text"`
		TS       string `json:"ts"`
		ThreadTS string `json:"thread_ts"`
	} `json:"message"`
	PreviousMessage *struct {
		TS string `json:"ts"`
	} `json:"previous_message"`
	Files []slackFile `json:"files"`
}

type slackFile struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Mimetype           string `json:"mimetype"`
	Size               int64  `json:"size"`
	URLPrivateDownload string `json:"url_private_download"`
	URLPrivate         string `json:"url_private"`
}

func (s *Server) handleSlackEvents(w http.ResponseWriter, r *http.Request) {
	if !s.slackEnabled() {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		fail(w, 400, "bad request")
		return
	}
	if !verifySlackSignature(s.cfg.SlackSigningSecret, r.Header.Get("X-Slack-Request-Timestamp"), r.Header.Get("X-Slack-Signature"), body) {
		fail(w, 401, "invalid signature")
		return
	}
	var env slackEventEnvelope
	if json.Unmarshal(body, &env) != nil {
		fail(w, 400, "bad payload")
		return
	}
	if env.Type == "url_verification" {
		ok(w, map[string]string{"challenge": env.Challenge})
		return
	}
	// Slack requires a 2xx within 3 seconds; process asynchronously.
	w.WriteHeader(200)
	if env.Type != "event_callback" {
		return
	}
	var ev slackEventPayload
	if json.Unmarshal(env.Event, &ev) != nil {
		return
	}
	// Acquire a worker slot without blocking the webhook response if possible.
	go func() {
		s.slack.sem <- struct{}{}
		defer func() { <-s.slack.sem }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.processSlackEvent(ctx, env.TeamID, &ev)
	}()
}

type activeSlackLink struct {
	ID, OrgID, RoomID, TeamID, TeamName, ChannelID, CreatedBy, BotUserID, BotToken string
}

func (s *Server) slackLinksForChannel(teamID, channelID string) []activeSlackLink {
	rows, err := s.r.Query(`SELECT l.id, l.org_id, l.room_id, l.team_id, l.team_name, l.channel_id, l.created_by, i.bot_user_id, i.bot_token
		FROM slack_links l JOIN slack_installs i ON i.id = l.install_id
		WHERE l.team_id = ? AND l.channel_id = ?`, teamID, channelID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []activeSlackLink
	for rows.Next() {
		var l activeSlackLink
		var enc string
		rows.Scan(&l.ID, &l.OrgID, &l.RoomID, &l.TeamID, &l.TeamName, &l.ChannelID, &l.CreatedBy, &l.BotUserID, &enc)
		if tok, err := s.openSecret(enc); err == nil {
			l.BotToken = tok
			out = append(out, l)
		}
	}
	return out
}

func (s *Server) slackLinksForRoom(roomID string) []activeSlackLink {
	rows, err := s.r.Query(`SELECT l.id, l.org_id, l.room_id, l.team_id, l.team_name, l.channel_id, l.created_by, i.bot_user_id, i.bot_token
		FROM slack_links l JOIN slack_installs i ON i.id = l.install_id
		WHERE l.room_id = ?`, roomID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []activeSlackLink
	for rows.Next() {
		var l activeSlackLink
		var enc string
		rows.Scan(&l.ID, &l.OrgID, &l.RoomID, &l.TeamID, &l.TeamName, &l.ChannelID, &l.CreatedBy, &l.BotUserID, &enc)
		if tok, err := s.openSecret(enc); err == nil {
			l.BotToken = tok
			out = append(out, l)
		}
	}
	return out
}

func (s *Server) processSlackEvent(ctx context.Context, teamID string, ev *slackEventPayload) {
	if ev.Type == "app_uninstalled" || ev.Type == "tokens_revoked" {
		s.w.Exec(`DELETE FROM slack_installs WHERE team_id = ?`, teamID)
		return
	}
	channelID := ev.Channel
	if channelID == "" {
		channelID = ev.Item.Channel
	}
	if channelID == "" {
		return
	}
	links := s.slackLinksForChannel(teamID, channelID)
	if len(links) == 0 {
		return
	}

	switch ev.Type {
	case "message":
		s.relaySlackMessage(ctx, links, ev)
	case "reaction_added":
		s.relaySlackReaction(ctx, links, ev, true)
	case "reaction_removed":
		s.relaySlackReaction(ctx, links, ev, false)
	}
}

func (s *Server) relaySlackMessage(ctx context.Context, links []activeSlackLink, ev *slackEventPayload) {
	switch ev.Subtype {
	case "bot_message", "channel_join", "channel_leave":
		return
	case "message_changed":
		if ev.Message == nil || ev.Message.BotID != "" || ev.Message.User == "" {
			return
		}
		for _, l := range links {
			if ev.Message.User == l.BotUserID {
				continue
			}
			var origEventID string
			if s.r.QueryRow(`SELECT matrix_event_id FROM slack_messages WHERE link_id = ? AND slack_ts = ? LIMIT 1`, l.ID, ev.Message.TS).Scan(&origEventID) != nil {
				continue
			}
			mxid := s.ensureSlackGhost(ctx, l.TeamID, l.TeamName, ev.Message.User, l.BotToken, l.RoomID, l.CreatedBy)
			text := s.slackTextToPlain(ctx, l.TeamID, l.BotToken, ev.Message.Text)
			txn := "slke" + newID(12)
			s.asMatrix(ctx, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(l.RoomID)+"/send/m.room.message/"+txn, mxid, map[string]any{
				"msgtype": "m.text",
				"body":    "* " + text,
				"m.new_content": map[string]any{
					"msgtype": "m.text",
					"body":    text,
				},
				"m.relates_to": map[string]any{
					"rel_type": "m.replace",
					"event_id": origEventID,
				},
			}, nil)
		}
		return
	case "message_deleted":
		ts := ev.DeletedTS
		if ts == "" && ev.PreviousMessage != nil {
			ts = ev.PreviousMessage.TS
		}
		if ts == "" {
			return
		}
		for _, l := range links {
			var origEventID string
			if s.r.QueryRow(`SELECT matrix_event_id FROM slack_messages WHERE link_id = ? AND slack_ts = ? LIMIT 1`, l.ID, ts).Scan(&origEventID) != nil {
				continue
			}
			txn := "slkd" + newID(12)
			s.asMatrix(ctx, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(l.RoomID)+"/redact/"+url.PathEscape(origEventID)+"/"+txn,
				s.mxid(slackBridgeLocal), map[string]any{"reason": "Deleted in Slack"}, nil)
		}
		return
	}

	if ev.BotID != "" || ev.User == "" {
		return
	}
	for _, l := range links {
		if ev.User == l.BotUserID {
			continue
		}
		var dup int
		if s.r.QueryRow(`SELECT count(*) FROM slack_messages WHERE link_id = ? AND slack_ts = ?`, l.ID, ev.TS).Scan(&dup); dup > 0 {
			continue
		}
		mxid := s.ensureSlackGhost(ctx, l.TeamID, l.TeamName, ev.User, l.BotToken, l.RoomID, l.CreatedBy)

		var threadRoot string
		if ev.ThreadTS != "" && ev.ThreadTS != ev.TS {
			s.r.QueryRow(`SELECT matrix_event_id FROM slack_messages WHERE link_id = ? AND slack_ts = ? LIMIT 1`, l.ID, ev.ThreadTS).Scan(&threadRoot)
		}

		text := s.slackTextToPlain(ctx, l.TeamID, l.BotToken, ev.Text)
		if text != "" {
			content := map[string]any{"msgtype": "m.text", "body": text}
			if threadRoot != "" {
				content["m.relates_to"] = map[string]any{
					"rel_type":        "m.thread",
					"event_id":        threadRoot,
					"is_falling_back": true,
					"m.in_reply_to":   map[string]string{"event_id": threadRoot},
				}
			}
			var sent struct {
				EventID string `json:"event_id"`
			}
			txn := "slk" + newID(12)
			if _, err := s.asMatrix(ctx, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(l.RoomID)+"/send/m.room.message/"+txn, mxid, content, &sent); err == nil && sent.EventID != "" {
				s.w.Exec(`INSERT OR IGNORE INTO slack_messages(link_id, matrix_event_id, slack_ts, thread_ts, direction, created) VALUES(?,?,?,?,?,?)`,
					l.ID, sent.EventID, ev.TS, ev.ThreadTS, "in", now())
			}
		}

		for _, f := range ev.Files {
			s.relaySlackFileToMatrix(ctx, l, mxid, ev.TS, ev.ThreadTS, threadRoot, f)
		}
	}
}

func (s *Server) relaySlackFileToMatrix(ctx context.Context, l activeSlackLink, mxid, ts, threadTS, threadRoot string, f slackFile) {
	dlURL := f.URLPrivateDownload
	if dlURL == "" {
		dlURL = f.URLPrivate
	}
	if dlURL == "" || f.Size > slackMaxFileBytes {
		return
	}
	req, err := http.NewRequestWithContext(ctx, "GET", dlURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+l.BotToken)
	res, err := s.http.Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, slackMaxFileBytes+1))
	if err != nil || len(data) == 0 || len(data) > slackMaxFileBytes {
		return
	}
	name := cleanName(f.Name)
	ctype := f.Mimetype
	if ctype == "" {
		ctype = res.Header.Get("Content-Type")
	}
	mxc, err := s.asUploadMedia(ctx, mxid, name, ctype, data)
	if err != nil {
		log.Printf("slack: media upload to matrix failed: %v", err)
		return
	}
	msgtype := "m.file"
	if strings.HasPrefix(ctype, "image/") {
		msgtype = "m.image"
	}
	content := map[string]any{
		"msgtype": msgtype,
		"body":    name,
		"url":     mxc,
		"info":    map[string]any{"mimetype": ctype, "size": len(data)},
	}
	if threadRoot != "" {
		content["m.relates_to"] = map[string]any{
			"rel_type":        "m.thread",
			"event_id":        threadRoot,
			"is_falling_back": true,
			"m.in_reply_to":   map[string]string{"event_id": threadRoot},
		}
	}
	var sent struct {
		EventID string `json:"event_id"`
	}
	txn := "slkf" + newID(12)
	if _, err := s.asMatrix(ctx, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(l.RoomID)+"/send/m.room.message/"+txn, mxid, content, &sent); err == nil && sent.EventID != "" {
		s.w.Exec(`INSERT OR IGNORE INTO slack_messages(link_id, matrix_event_id, slack_ts, thread_ts, direction, created) VALUES(?,?,?,?,?,?)`,
			l.ID, sent.EventID, ts, threadTS, "in", now())
	}
}

func (s *Server) relaySlackReaction(ctx context.Context, links []activeSlackLink, ev *slackEventPayload, added bool) {
	if ev.Item.Type != "message" || ev.User == "" || ev.Reaction == "" {
		return
	}
	emoji := slackShortcodeToEmoji(ev.Reaction)
	for _, l := range links {
		if ev.User == l.BotUserID {
			continue
		}
		var targetEventID string
		if s.r.QueryRow(`SELECT matrix_event_id FROM slack_messages WHERE link_id = ? AND slack_ts = ? LIMIT 1`, l.ID, ev.Item.TS).Scan(&targetEventID) != nil {
			continue
		}
		mxid := s.ensureSlackGhost(ctx, l.TeamID, l.TeamName, ev.User, l.BotToken, l.RoomID, l.CreatedBy)
		if added {
			txn := "slkr" + newID(12)
			var sent struct {
				EventID string `json:"event_id"`
			}
			if _, err := s.asMatrix(ctx, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(l.RoomID)+"/send/m.reaction/"+txn, mxid, map[string]any{
				"m.relates_to": map[string]string{"rel_type": "m.annotation", "event_id": targetEventID, "key": emoji},
			}, &sent); err == nil && sent.EventID != "" {
				s.w.Exec(`INSERT OR IGNORE INTO slack_messages(link_id, matrix_event_id, slack_ts, thread_ts, direction, created) VALUES(?,?,?,?,?,?)`,
					l.ID, sent.EventID, "react:"+ev.Item.TS+":"+ev.User+":"+ev.Reaction, "", "in", now())
			}
		} else {
			var reactEventID string
			key := "react:" + ev.Item.TS + ":" + ev.User + ":" + ev.Reaction
			if s.r.QueryRow(`SELECT matrix_event_id FROM slack_messages WHERE link_id = ? AND slack_ts = ? LIMIT 1`, l.ID, key).Scan(&reactEventID) == nil {
				txn := "slkru" + newID(12)
				s.asMatrix(ctx, "PUT", "/_matrix/client/v3/rooms/"+url.PathEscape(l.RoomID)+"/redact/"+url.PathEscape(reactEventID)+"/"+txn, mxid, map[string]any{}, nil)
				s.w.Exec(`DELETE FROM slack_messages WHERE link_id = ? AND matrix_event_id = ?`, l.ID, reactEventID)
			}
		}
	}
}

// --- Matrix Application Service callbacks (Matrix -> Slack) ---

func (s *Server) checkHsToken(r *http.Request) bool {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == r.Header.Get("Authorization") {
		tok = r.URL.Query().Get("access_token")
	}
	return tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.slackHsToken())) == 1
}

func (s *Server) handleAppserviceQuery(w http.ResponseWriter, r *http.Request) {
	if !s.checkHsToken(r) {
		fail(w, 401, "unauthorized")
		return
	}
	ok(w, map[string]any{})
}

type asTransaction struct {
	Events []matrixEvent `json:"events"`
}

type matrixEvent struct {
	EventID string          `json:"event_id"`
	RoomID  string          `json:"room_id"`
	Sender  string          `json:"sender"`
	Type    string          `json:"type"`
	Redacts string          `json:"redacts"`
	Content json.RawMessage `json:"content"`
}

func (s *Server) handleAppserviceTxn(w http.ResponseWriter, r *http.Request) {
	if !s.checkHsToken(r) {
		fail(w, 401, "unauthorized")
		return
	}
	txnID := r.PathValue("txnId")
	if s.slack.seenTxn(txnID) {
		ok(w, map[string]any{})
		return
	}
	var txn asTransaction
	if readJSON(r, &txn) != nil {
		fail(w, 400, "bad transaction")
		return
	}
	ok(w, map[string]any{})
	if !s.slackEnabled() || len(txn.Events) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, ev := range txn.Events {
			s.relayMatrixEventToSlack(ctx, &ev)
		}
	}()
}

func (s *Server) isBridgeMXID(mxid string) bool {
	local := strings.TrimPrefix(mxid, "@")
	local, _, _ = strings.Cut(local, ":")
	return local == slackBridgeLocal || strings.HasPrefix(local, slackGhostPrefix)
}

func (s *Server) senderLabel(mxid, orgID string) string {
	local := strings.TrimPrefix(mxid, "@")
	local, _, _ = strings.Cut(local, ":")
	var name, orgName string
	if s.r.QueryRow(`SELECT u.name, o.name FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.mx_local = ? AND u.org_id = ?`, local, orgID).
		Scan(&name, &orgName) == nil && name != "" {
		if orgName != "" {
			return name + " (" + orgName + ")"
		}
		return name
	}
	return local
}

func (s *Server) relayMatrixEventToSlack(ctx context.Context, ev *matrixEvent) {
	if ev.RoomID == "" || ev.EventID == "" || s.isBridgeMXID(ev.Sender) {
		return
	}
	links := s.slackLinksForRoom(ev.RoomID)
	if len(links) == 0 {
		return
	}

	switch ev.Type {
	case "m.room.message":
		var c struct {
			MsgType    string `json:"msgtype"`
			Body       string `json:"body"`
			URL        string `json:"url"`
			NewContent *struct {
				MsgType string `json:"msgtype"`
				Body    string `json:"body"`
			} `json:"m.new_content"`
			Info struct {
				MimeType string `json:"mimetype"`
			} `json:"info"`
			RelatesTo *struct {
				RelType   string `json:"rel_type"`
				EventID   string `json:"event_id"`
				InReplyTo *struct {
					EventID string `json:"event_id"`
				} `json:"m.in_reply_to"`
			} `json:"m.relates_to"`
		}
		if json.Unmarshal(ev.Content, &c) != nil {
			return
		}
		for _, l := range links {
			var dup int
			if s.r.QueryRow(`SELECT count(*) FROM slack_messages WHERE link_id = ? AND matrix_event_id = ?`, l.ID, ev.EventID).Scan(&dup); dup > 0 {
				continue
			}
			// Edits (m.replace) -> chat.update
			if c.RelatesTo != nil && c.RelatesTo.RelType == "m.replace" && c.RelatesTo.EventID != "" {
				var ts string
				if s.r.QueryRow(`SELECT slack_ts FROM slack_messages WHERE link_id = ? AND matrix_event_id = ?`, l.ID, c.RelatesTo.EventID).Scan(&ts) == nil && ts != "" {
					body := c.Body
					if c.NewContent != nil && c.NewContent.Body != "" {
						body = c.NewContent.Body
					}
					s.slackPostPaced(ctx, l, "/chat.update", map[string]any{"channel": l.ChannelID, "ts": ts, "text": body}, nil)
				}
				continue
			}

			var threadTS string
			if c.RelatesTo != nil && c.RelatesTo.EventID != "" && (c.RelatesTo.RelType == "m.thread" || c.RelatesTo.InReplyTo != nil) {
				target := c.RelatesTo.EventID
				if target == "" && c.RelatesTo.InReplyTo != nil {
					target = c.RelatesTo.InReplyTo.EventID
				}
				s.r.QueryRow(`SELECT COALESCE(NULLIF(thread_ts,''), slack_ts) FROM slack_messages WHERE link_id = ? AND matrix_event_id = ?`, l.ID, target).Scan(&threadTS)
			}

			username := s.senderLabel(ev.Sender, l.OrgID)
			if (c.MsgType == "m.image" || c.MsgType == "m.file" || c.MsgType == "m.video" || c.MsgType == "m.audio") && c.URL != "" {
				s.relayMatrixFileToSlack(ctx, l, ev.EventID, username, c.Body, c.URL, c.Info.MimeType, threadTS)
				continue
			}
			text := c.Body
			if c.MsgType == "m.emote" {
				text = "_" + text + "_"
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			payload := map[string]any{
				"channel":  l.ChannelID,
				"text":     text,
				"username": username,
			}
			if threadTS != "" {
				payload["thread_ts"] = threadTS
			}
			var posted struct {
				OK bool   `json:"ok"`
				TS string `json:"ts"`
			}
			if err := s.slackPostPaced(ctx, l, "/chat.postMessage", payload, &posted); err == nil && posted.OK && posted.TS != "" {
				s.w.Exec(`INSERT OR IGNORE INTO slack_messages(link_id, matrix_event_id, slack_ts, thread_ts, direction, created) VALUES(?,?,?,?,?,?)`,
					l.ID, ev.EventID, posted.TS, threadTS, "out", now())
			}
		}

	case "m.room.redaction":
		if ev.Redacts == "" {
			return
		}
		for _, l := range links {
			var ts string
			if s.r.QueryRow(`SELECT slack_ts FROM slack_messages WHERE link_id = ? AND matrix_event_id = ?`, l.ID, ev.Redacts).Scan(&ts) == nil && ts != "" && !strings.HasPrefix(ts, "react:") {
				s.slackPostPaced(ctx, l, "/chat.delete", map[string]any{"channel": l.ChannelID, "ts": ts}, nil)
			}
		}

	case "m.reaction":
		var c struct {
			RelatesTo struct {
				RelType string `json:"rel_type"`
				EventID string `json:"event_id"`
				Key     string `json:"key"`
			} `json:"m.relates_to"`
		}
		if json.Unmarshal(ev.Content, &c) != nil || c.RelatesTo.RelType != "m.annotation" || c.RelatesTo.Key == "" {
			return
		}
		name := emojiToSlackShortcode(c.RelatesTo.Key)
		if name == "" {
			return
		}
		for _, l := range links {
			var ts string
			if s.r.QueryRow(`SELECT slack_ts FROM slack_messages WHERE link_id = ? AND matrix_event_id = ?`, l.ID, c.RelatesTo.EventID).Scan(&ts) == nil && ts != "" {
				s.slackPostPaced(ctx, l, "/reactions.add", map[string]any{"channel": l.ChannelID, "timestamp": ts, "name": name}, nil)
			}
		}
	}
}

func (s *Server) relayMatrixFileToSlack(ctx context.Context, l activeSlackLink, eventID, username, filename, mxc, ctype, threadTS string) {
	data, dlType, err := s.asDownloadMedia(ctx, mxc)
	if err != nil {
		log.Printf("slack: download matrix media failed: %v", err)
		return
	}
	if filename == "" {
		filename = "attachment"
	}
	if ctype == "" {
		ctype = dlType
	}
	// Step 1: get upload URL (modern Slack upload flow; files.upload is retired).
	var up struct {
		OK        bool   `json:"ok"`
		UploadURL string `json:"upload_url"`
		FileID    string `json:"file_id"`
	}
	q := url.Values{"filename": {filename}, "length": {strconv.Itoa(len(data))}}
	if err := s.slackAPI(ctx, l.BotToken, "GET", "/files.getUploadURLExternal?"+q.Encode(), nil, &up); err != nil || !up.OK || up.UploadURL == "" {
		log.Printf("slack: getUploadURLExternal failed: %v", err)
		return
	}
	// Step 2: upload file bytes to the presigned URL.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("filename", filename)
	if err != nil {
		return
	}
	part.Write(data)
	mw.Close()
	req, err := http.NewRequestWithContext(ctx, "POST", up.UploadURL, &buf)
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := s.http.Do(req)
	if err != nil {
		return
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return
	}
	// Step 3: share the uploaded file into the channel.
	complete := map[string]any{
		"files":           []map[string]string{{"id": up.FileID, "title": filename}},
		"channel_id":      l.ChannelID,
		"initial_comment": fmt.Sprintf("Shared by %s", username),
	}
	if threadTS != "" {
		complete["thread_ts"] = threadTS
	}
	s.slackPostPaced(ctx, l, "/files.completeUploadExternal", complete, nil)
	s.w.Exec(`INSERT OR IGNORE INTO slack_messages(link_id, matrix_event_id, slack_ts, thread_ts, direction, created) VALUES(?,?,?,?,?,?)`,
		l.ID, eventID, "file:"+up.FileID, threadTS, "out", now())
}

// --- Slack Web API client with rate-limit pacing & Retry-After ---

func (s *Server) slackPostPaced(ctx context.Context, l activeSlackLink, path string, payload any, out any) error {
	p := s.slack.pacer(l.TeamID + ":" + l.ChannelID)
	for attempt := 0; attempt < 3; attempt++ {
		if err := p.wait(ctx, 1100*time.Millisecond); err != nil {
			return err
		}
		retry, err := s.slackAPIWithRetry(ctx, l.BotToken, "POST", path, payload, out)
		if retry > 0 {
			p.backoff(retry)
			continue
		}
		return err
	}
	return errf("slack rate limited")
}

func (s *Server) slackAPI(ctx context.Context, token, method, path string, payload any, out any) error {
	_, err := s.slackAPIWithRetry(ctx, token, method, path, payload, out)
	return err
}

func (s *Server) slackAPIWithRetry(ctx context.Context, token, method, path string, payload any, out any) (time.Duration, error) {
	var body io.Reader
	if payload != nil {
		b, _ := json.Marshal(payload)
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.slackAPIBase()+path, body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	res, err := s.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode == 429 {
		sec, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		if sec <= 0 {
			sec = 2
		}
		return time.Duration(sec) * time.Second, errf("slack 429")
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		return 0, errf("slack %s: %d %s", path, res.StatusCode, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return 0, err
		}
	}
	return 0, nil
}

func (s *Server) fetchSlackUser(ctx context.Context, token, userID string) (name, avatar string) {
	var out struct {
		OK   bool `json:"ok"`
		User struct {
			RealName string `json:"real_name"`
			Name     string `json:"name"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
				Image72     string `json:"image_72"`
			} `json:"profile"`
		} `json:"user"`
	}
	if s.slackAPI(ctx, token, "GET", "/users.info?user="+url.QueryEscape(userID), nil, &out) != nil || !out.OK {
		return "", ""
	}
	for _, candidate := range []string{out.User.Profile.DisplayName, out.User.Profile.RealName, out.User.RealName, out.User.Name} {
		if c := strings.TrimSpace(candidate); c != "" {
			return c, out.User.Profile.Image72
		}
	}
	return "", out.User.Profile.Image72
}

// --- Slack mrkdwn & emoji helpers ---

var (
	slackMentionRe = regexp.MustCompile(`<@([A-Z0-9]+)(?:\|([^>]+))?>`)
	slackChanRefRe = regexp.MustCompile(`<#[A-Z0-9]+\|([^>]+)>`)
	slackLinkRe    = regexp.MustCompile(`<(https?://[^|>]+)\|([^>]+)>`)
	slackBareURLRe = regexp.MustCompile(`<(https?://[^>]+)>`)
)

func (s *Server) slackTextToPlain(ctx context.Context, teamID, token, text string) string {
	text = slackMentionRe.ReplaceAllStringFunc(text, func(m string) string {
		sub := slackMentionRe.FindStringSubmatch(m)
		if len(sub) >= 3 && sub[2] != "" {
			return "@" + sub[2]
		}
		uid := sub[1]
		var cached string
		if s.r.QueryRow(`SELECT display_name FROM slack_users WHERE team_id = ? AND slack_user_id = ?`, teamID, uid).Scan(&cached) == nil && cached != "" {
			name, _, _ := strings.Cut(cached, " (")
			return "@" + name
		}
		if name, _ := s.fetchSlackUser(ctx, token, uid); name != "" {
			return "@" + name
		}
		return "@" + uid
	})
	text = slackChanRefRe.ReplaceAllString(text, "#$1")
	text = slackLinkRe.ReplaceAllString(text, "$2 ($1)")
	text = slackBareURLRe.ReplaceAllString(text, "$1")
	return html.UnescapeString(text)
}

var slackShortcodes = map[string]string{
	"+1": "👍", "thumbsup": "👍", "-1": "👎", "thumbsdown": "👎",
	"heart": "❤️", "tada": "🎉", "eyes": "👀", "fire": "🔥",
	"white_check_mark": "✅", "heavy_check_mark": "✔️", "x": "❌",
	"rocket": "🚀", "smile": "😄", "grinning": "😀", "laughing": "😆",
	"joy": "😂", "slightly_smiling_face": "🙂", "wink": "😉",
	"thinking_face": "🤔", "clap": "👏", "100": "💯", "pray": "🙏",
	"wave": "👋", "raised_hands": "🙌", "sparkles": "✨", "bulb": "💡",
	"warning": "⚠️", "sob": "😭", "sweat_smile": "😅",
}

var emojiToShortcode = map[string]string{
	"👍": "thumbsup", "👎": "thumbsdown", "❤️": "heart", "🎉": "tada",
	"👀": "eyes", "🔥": "fire", "✅": "white_check_mark", "✔️": "heavy_check_mark",
	"❌": "x", "🚀": "rocket", "😄": "smile", "😀": "grinning", "😆": "laughing",
	"😂": "joy", "🙂": "slightly_smiling_face", "😉": "wink", "🤔": "thinking_face",
	"👏": "clap", "💯": "100", "🙏": "pray", "👋": "wave", "🙌": "raised_hands",
	"✨": "sparkles", "💡": "bulb", "⚠️": "warning", "😭": "sob", "😅": "sweat_smile",
}

func slackShortcodeToEmoji(code string) string {
	base, _, _ := strings.Cut(code, "::") // strip skin-tone modifier
	if e, ok := slackShortcodes[base]; ok {
		return e
	}
	return ":" + code + ":"
}

func emojiToSlackShortcode(emoji string) string {
	if strings.HasPrefix(emoji, ":") && strings.HasSuffix(emoji, ":") && len(emoji) > 2 {
		return strings.Trim(emoji, ":")
	}
	return emojiToShortcode[emoji]
}
