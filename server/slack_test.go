package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func signSlackTest(secret, ts string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("v0:" + ts + ":"))
	m.Write(body)
	return "v0=" + hex.EncodeToString(m.Sum(nil))
}

func TestSlackHelpers(t *testing.T) {
	s, _ := newTestServer(t, nil)
	sealed, err := s.sealSecret("xoxb-secret-token")
	if err != nil || strings.Contains(sealed, "xoxb-secret-token") {
		t.Fatalf("sealSecret failed: %q %v", sealed, err)
	}
	got, err := s.openSecret(sealed)
	if err != nil || got != "xoxb-secret-token" {
		t.Fatalf("openSecret = %q %v", got, err)
	}
	if _, err := s.openSecret("v1:tampered"); err == nil {
		t.Error("tampered secret should fail")
	}

	body := []byte(`{"type":"url_verification","challenge":"abc"}`)
	ts := strconv.FormatInt(now(), 10)
	sig := signSlackTest("signing-secret", ts, body)
	if !verifySlackSignature("signing-secret", ts, sig, body) {
		t.Error("valid signature rejected")
	}
	if verifySlackSignature("signing-secret", ts, "v0=bad", body) {
		t.Error("bad signature accepted")
	}
	oldTS := strconv.FormatInt(now()-600, 10)
	if verifySlackSignature("signing-secret", oldTS, signSlackTest("signing-secret", oldTS, body), body) {
		t.Error("stale timestamp accepted")
	}

	if got := slackShortcodeToEmoji("thumbsup::skin-tone-3"); got != "👍" {
		t.Errorf("shortcode = %q", got)
	}
	if got := emojiToSlackShortcode("🎉"); got != "tada" {
		t.Errorf("emoji reverse = %q", got)
	}
	plain := s.slackTextToPlain(t.Context(), "T1", "tok", "Hi <@U1|Jane> check <#C1|ops> &amp; <https://example.com|docs> <https://open.eu>")
	if want := "Hi @Jane check #ops & docs (https://example.com) https://open.eu"; plain != want {
		t.Errorf("slackTextToPlain = %q, want %q", plain, want)
	}
}

// End-to-end test with fake Matrix homeserver and fake Slack API:
// invite creation, tenant/membership enforcement, OAuth + channel linking,
// Slack -> Matrix (ghost user, message, edit, reaction, delete),
// Matrix -> Slack (postMessage with customize, edit, reaction, delete, loop guard).
func TestSlackBridgeFlow(t *testing.T) {
	var mxMu sync.Mutex
	var mxSent []map[string]any
	var mxRedacts []string
	var mxUsers []string
	mxSeq := 0
	const roomID = "!room1:office.test"

	fakeMatrix := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		auth := r.Header.Get("Authorization")
		switch {
		case r.Method == "GET" && r.URL.Path == "/_matrix/client/v3/joined_rooms":
			if auth == "Bearer tok-alice" {
				json.NewEncoder(w).Encode(map[string]any{"joined_rooms": []string{roomID}})
			} else {
				json.NewEncoder(w).Encode(map[string]any{"joined_rooms": []string{}})
			}
		case r.Method == "POST" && r.URL.Path == "/_matrix/client/v3/register":
			var in map[string]any
			json.NewDecoder(r.Body).Decode(&in)
			mxMu.Lock()
			if u, _ := in["username"].(string); u != "" {
				mxUsers = append(mxUsers, u)
			}
			mxMu.Unlock()
			w.Write([]byte(`{"user_id":"@ok:office.test"}`))
		case r.Method == "PUT" && strings.Contains(r.URL.Path, "/send/"):
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			mxMu.Lock()
			mxSeq++
			evID := fmt.Sprintf("$mx%d", mxSeq)
			mxSent = append(mxSent, map[string]any{
				"event_id": evID,
				"path":     r.URL.Path,
				"user_id":  r.URL.Query().Get("user_id"),
				"content":  body,
			})
			mxMu.Unlock()
			json.NewEncoder(w).Encode(map[string]string{"event_id": evID})
		case r.Method == "PUT" && strings.Contains(r.URL.Path, "/redact/"):
			mxMu.Lock()
			mxRedacts = append(mxRedacts, r.URL.Path)
			mxMu.Unlock()
			w.Write([]byte(`{"event_id":"$red"}`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	defer fakeMatrix.Close()

	var slkMu sync.Mutex
	var slkCalls []map[string]any
	slkSeq := 0
	fakeSlack := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth.v2.access":
			json.NewEncoder(w).Encode(map[string]any{
				"ok":           true,
				"access_token": "xoxb-partner-token",
				"bot_user_id":  "UBOT",
				"team":         map[string]string{"id": "T99", "name": "Acme Corp"},
				"authed_user":  map[string]string{"id": "UADMIN"},
			})
		case "/conversations.list":
			json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"channels": []map[string]any{
					{"id": "C42", "name": "partner-ops", "is_private": false, "is_member": true},
				},
			})
		case "/conversations.join":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "channel": map[string]string{"id": "C42", "name": "partner-ops"}})
		case "/users.info":
			json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"user": map[string]any{
					"real_name": "Jane Partner",
					"profile":   map[string]string{"display_name": "Jane Partner", "image_72": "https://img.test/jane.png"},
				},
			})
		case "/chat.postMessage", "/chat.update", "/chat.delete", "/reactions.add":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			slkMu.Lock()
			slkSeq++
			ts := fmt.Sprintf("1700000000.%06d", slkSeq)
			slkCalls = append(slkCalls, map[string]any{"path": r.URL.Path, "body": body, "ts": ts})
			slkMu.Unlock()
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": ts})
		default:
			w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer fakeSlack.Close()

	const signingSecret = "test-slack-signing-secret"
	s, ts := newTestServer(t, func(cfg *Config) {
		cfg.MatrixURL = fakeMatrix.URL
		cfg.SlackClientID = "cid"
		cfg.SlackClientSecret = "csec"
		cfg.SlackSigningSecret = signingSecret
		cfg.SlackAPIBase = fakeSlack.URL
		cfg.SlackOAuthBase = fakeSlack.URL + "/oauth/authorize"
	})

	alice := newClient(t, ts)
	alice.signup("Alpha", "alice")
	bob := newClient(t, ts)
	bob.signup("Beta", "bob")
	s.w.Exec(`UPDATE users SET mx_token = 'tok-alice' WHERE email = 'alice@office.test'`)
	s.w.Exec(`UPDATE users SET mx_token = 'tok-bob' WHERE email = 'bob@office.test'`)

	// Non-member in another org cannot inspect or create Slack invites for Alice's room.
	if code := bob.do("GET", "/api/chat/rooms/"+url.PathEscape(roomID)+"/slack", nil, nil); code != 403 {
		t.Fatalf("non-member status = %d, want 403", code)
	}
	if code := bob.do("POST", "/api/chat/rooms/"+url.PathEscape(roomID)+"/slack/invites", map[string]string{"roomName": "Ops"}, nil); code != 403 {
		t.Fatalf("non-member invite = %d, want 403", code)
	}

	// Alice creates an invite link for her room.
	var inv SlackInviteView
	if code := alice.do("POST", "/api/chat/rooms/"+url.PathEscape(roomID)+"/slack/invites", map[string]string{"roomName": "Partner Ops"}, &inv); code != 200 || inv.Token == "" {
		t.Fatalf("create invite: %d %+v", code, inv)
	}

	// External partner (unauthenticated) loads invite info and completes OAuth.
	partner := newClient(t, ts)
	partner.http.CheckRedirect = func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
	var info map[string]any
	if code := partner.do("GET", "/api/slack/invite/"+inv.Token, nil, &info); code != 200 || info["org"] != "Alpha" {
		t.Fatalf("invite info: %d %+v", code, info)
	}

	// Start OAuth -> sets CSRF cookie and redirects to Slack with state.
	startRes, err := partner.http.Get(ts.URL + "/api/slack/oauth/start?token=" + inv.Token)
	if err != nil || startRes.StatusCode != 302 {
		t.Fatalf("oauth start: %v %v", err, startRes)
	}
	loc, _ := url.Parse(startRes.Header.Get("Location"))
	state := loc.Query().Get("state")
	if state == "" {
		t.Fatal("missing oauth state")
	}

	// Callback with mismatched state fails.
	badRes, _ := partner.http.Get(ts.URL + "/api/slack/oauth/callback?code=abc&state=wrong")
	if badRes.StatusCode != 400 {
		t.Fatalf("bad state = %d, want 400", badRes.StatusCode)
	}

	// Callback with valid state exchanges code and sets picker cookie.
	cbRes, err := partner.http.Get(ts.URL + "/api/slack/oauth/callback?code=good&state=" + url.QueryEscape(state))
	if err != nil || cbRes.StatusCode != 302 || !strings.Contains(cbRes.Header.Get("Location"), "?step=pick") {
		t.Fatalf("oauth callback: %v %v", err, cbRes)
	}

	// Partner lists channels and links #partner-ops.
	var chans struct {
		TeamName string `json:"teamName"`
		Channels []struct {
			ID, Name string
		} `json:"channels"`
	}
	if code := partner.do("GET", "/api/slack/invite/"+inv.Token+"/channels", nil, &chans); code != 200 || len(chans.Channels) != 1 {
		t.Fatalf("channels: %d %+v", code, chans)
	}
	if code := partner.do("POST", "/api/slack/invite/"+inv.Token+"/link", map[string]string{"channelId": "C42", "channelName": "partner-ops"}, nil); code != 200 {
		t.Fatalf("link channel: %d", code)
	}
	// Used invite cannot be reused.
	if code := partner.do("GET", "/api/slack/invite/"+inv.Token, nil, nil); code != 410 {
		t.Fatalf("reused invite = %d, want 410", code)
	}

	// Alice sees the active link on her room.
	var status struct {
		Enabled bool            `json:"enabled"`
		Links   []SlackLinkView `json:"links"`
	}
	if code := alice.do("GET", "/api/chat/rooms/"+url.PathEscape(roomID)+"/slack", nil, &status); code != 200 || len(status.Links) != 1 || status.Links[0].TeamName != "Acme Corp" {
		t.Fatalf("room status: %d %+v", code, status)
	}

	// --- Slack -> Matrix: webhook challenge, message, edit, reaction, delete ---
	postSlackEvent := func(payload any) int {
		b, _ := json.Marshal(payload)
		tsStr := strconv.FormatInt(now(), 10)
		req, _ := http.NewRequest("POST", ts.URL+"/api/slack/events", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Slack-Request-Timestamp", tsStr)
		req.Header.Set("X-Slack-Signature", signSlackTest(signingSecret, tsStr, b))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		io.ReadAll(res.Body)
		return res.StatusCode
	}

	if code := postSlackEvent(map[string]any{"type": "url_verification", "challenge": "hello"}); code != 200 {
		t.Fatalf("url_verification = %d", code)
	}

	// Incoming message from Slack partner Jane.
	if code := postSlackEvent(map[string]any{
		"type":    "event_callback",
		"team_id": "T99",
		"event": map[string]any{
			"type":    "message",
			"channel": "C42",
			"user":    "U77",
			"text":    "Hello from Slack!",
			"ts":      "1700001000.000100",
		},
	}); code != 200 {
		t.Fatalf("slack msg webhook = %d", code)
	}

	waitFor := func(cond func() bool) bool {
		for i := 0; i < 40; i++ {
			if cond() {
				return true
			}
			time.Sleep(25 * time.Millisecond)
		}
		return false
	}

	if !waitFor(func() bool { mxMu.Lock(); defer mxMu.Unlock(); return len(mxSent) >= 1 }) {
		t.Fatal("Slack message never relayed to Matrix")
	}
	mxMu.Lock()
	first := mxSent[0]
	mxMu.Unlock()
	if first["user_id"] != "@slack_t99_u77:office.test" {
		t.Errorf("ghost user = %v", first["user_id"])
	}
	if first["content"].(map[string]any)["body"] != "Hello from Slack!" {
		t.Errorf("relayed body = %v", first["content"])
	}

	// Incoming Slack edit + reaction + delete.
	postSlackEvent(map[string]any{
		"type": "event_callback", "team_id": "T99",
		"event": map[string]any{
			"type": "message", "subtype": "message_changed", "channel": "C42",
			"message": map[string]any{"user": "U77", "text": "Hello edited!", "ts": "1700001000.000100"},
		},
	})
	postSlackEvent(map[string]any{
		"type": "event_callback", "team_id": "T99",
		"event": map[string]any{
			"type": "reaction_added", "user": "U77", "reaction": "rocket",
			"item": map[string]any{"type": "message", "channel": "C42", "ts": "1700001000.000100"},
		},
	})
	if !waitFor(func() bool { mxMu.Lock(); defer mxMu.Unlock(); return len(mxSent) >= 3 }) {
		t.Fatalf("expected edit and reaction relayed to Matrix, got %d", len(mxSent))
	}
	postSlackEvent(map[string]any{
		"type": "event_callback", "team_id": "T99",
		"event": map[string]any{
			"type": "message", "subtype": "message_deleted", "channel": "C42", "deleted_ts": "1700001000.000100",
		},
	})
	if !waitFor(func() bool { mxMu.Lock(); defer mxMu.Unlock(); return len(mxRedacts) >= 1 }) {
		t.Fatal("Slack delete not relayed as Matrix redaction")
	}

	// --- Matrix -> Slack: appservice transaction, loop guard, auth check ---
	sendAS := func(txnID, hsTok string, events []map[string]any) int {
		b, _ := json.Marshal(map[string]any{"events": events})
		req, _ := http.NewRequest("PUT", ts.URL+"/_opensuite/as/_matrix/app/v1/transactions/"+txnID, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		if hsTok != "" {
			req.Header.Set("Authorization", "Bearer "+hsTok)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		io.ReadAll(res.Body)
		return res.StatusCode
	}

	if code := sendAS("t0", "wrong-token", nil); code != 401 {
		t.Fatalf("bad hs_token = %d, want 401", code)
	}

	slkMu.Lock()
	beforeSlk := len(slkCalls)
	slkMu.Unlock()

	// Send one message from Alice and one from a ghost user (which MUST be ignored).
	if code := sendAS("t1", s.slackHsToken(), []map[string]any{
		{
			"event_id": "$alice1",
			"room_id":  roomID,
			"sender":   "@alice:office.test",
			"type":     "m.room.message",
			"content":  map[string]any{"msgtype": "m.text", "body": "Hi from Open Suite!"},
		},
		{
			"event_id": "$ghost_echo",
			"room_id":  roomID,
			"sender":   "@slack_t99_u77:office.test",
			"type":     "m.room.message",
			"content":  map[string]any{"msgtype": "m.text", "body": "Should not loop"},
		},
	}); code != 200 {
		t.Fatalf("appservice txn = %d", code)
	}

	if !waitFor(func() bool { slkMu.Lock(); defer slkMu.Unlock(); return len(slkCalls) > beforeSlk }) {
		t.Fatal("Matrix message never relayed to Slack")
	}
	time.Sleep(150 * time.Millisecond)
	slkMu.Lock()
	relayed := slkCalls[beforeSlk:]
	slkMu.Unlock()
	if len(relayed) != 1 {
		t.Fatalf("expected 1 relayed call (ghost ignored), got %d: %+v", len(relayed), relayed)
	}
	postBody := relayed[0]["body"].(map[string]any)
	if postBody["text"] != "Hi from Open Suite!" || postBody["username"] != "Alice (Alpha)" || postBody["channel"] != "C42" {
		t.Errorf("unexpected Slack post payload: %+v", postBody)
	}

	// Alice disconnects the link; afterwards Bob still cannot touch it and status is empty.
	if code := alice.do("DELETE", "/api/chat/rooms/"+url.PathEscape(roomID)+"/slack/links/"+status.Links[0].ID, nil, nil); code != 200 {
		t.Fatalf("delete link = %d", code)
	}
	alice.do("GET", "/api/chat/rooms/"+url.PathEscape(roomID)+"/slack", nil, &status)
	if len(status.Links) != 0 {
		t.Errorf("expected 0 links after disconnect, got %d", len(status.Links))
	}
}
