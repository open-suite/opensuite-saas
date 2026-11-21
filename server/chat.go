package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The chat engine is a Matrix homeserver that never shows a login page. We
// vouch for people with short-lived signed assertions; the homeserver creates
// the account on first use and returns an access token the browser then uses
// directly against /_matrix on our own origin.

const chatDevice = "OPENSUITE"
const chatAdminUser = "opensuite-service"

// mxLocalFor maps a mailbox address to a Matrix localpart. Addresses on the
// shared domain keep the bare name; custom-domain addresses carry the domain
// so two organisations can both have a "jane".
func (s *Server) mxLocalFor(email string) string {
	local, domain, _ := strings.Cut(strings.ToLower(email), "@")
	if domain == s.cfg.MailDomain {
		return local
	}
	return local + "_" + domain
}

func (s *Server) mxid(local string) string {
	if local == "" {
		return ""
	}
	return "@" + local + ":" + s.cfg.MatrixName
}

func (s *Server) matrix(ctx context.Context, method, path, token string, body, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.cfg.MatrixURL+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := s.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if out != nil && res.StatusCode < 300 {
		json.Unmarshal(b, out)
	}
	if res.StatusCode >= 300 {
		return res.StatusCode, errf("matrix %s %s: %d %s", method, path, res.StatusCode, b)
	}
	return res.StatusCode, nil
}

// chatToken logs a localpart in (creating it if new) and returns its token.
func (s *Server) chatToken(ctx context.Context, local string) (string, error) {
	t := now()
	assertion := signHS256([]byte(s.cfg.MatrixSecret), map[string]any{
		"sub": local, "iss": "opensuite", "aud": "chat", "nbf": t - 30, "exp": t + 120,
	})
	var out struct {
		AccessToken string `json:"access_token"`
	}
	_, err := s.matrix(ctx, "POST", "/_matrix/client/v3/login", "", map[string]any{
		"type": "org.matrix.login.jwt", "token": assertion,
		"device_id": chatDevice, "initial_device_display_name": "Open Suite",
	}, &out)
	return out.AccessToken, err
}

func (s *Server) chatEnsure(ctx context.Context, u *User) {
	if s.cfg.MatrixURL == "" || u.MxLocal == "" {
		return
	}
	tok, err := s.chatToken(ctx, u.MxLocal)
	if err != nil {
		log.Printf("chat: provisioning %s: %v", u.Email, err)
		return
	}
	u.MxToken = tok
	s.w.Exec(`UPDATE users SET mx_token = ? WHERE id = ?`, tok, u.ID)
	s.chatSetName(u)
}

// handleChatToken gives a browser the current chat token after its own was
// rejected. If another browser already renewed it, that one is returned, so
// several open sessions settle on a single token instead of evicting each
// other in turn.
func (s *Server) handleChatToken(w http.ResponseWriter, r *http.Request, u *User) {
	var in struct{ Bad string }
	readJSON(r, &in)
	if u.MxToken == "" || u.MxToken == in.Bad {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		u.MxToken = ""
		s.chatEnsure(ctx, u)
	}
	if u.MxToken == "" {
		fail(w, 503, "Chat is not available right now.")
		return
	}
	ok(w, map[string]string{"token": u.MxToken})
}

func (s *Server) chatSetName(u *User) {
	if s.cfg.MatrixURL == "" || u.MxToken == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	s.matrix(ctx, "PUT", "/_matrix/client/v3/profile/"+url.PathEscape(s.mxid(u.MxLocal))+"/displayname", u.MxToken,
		map[string]string{"displayname": u.Name}, nil)
}

// chatSignOut invalidates every chat session a person has.
func (s *Server) chatSignOut(u *User) {
	if s.cfg.MatrixURL == "" || u.MxToken == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	s.matrix(ctx, "POST", "/_matrix/client/v3/logout/all", u.MxToken, map[string]any{}, nil)
	s.w.Exec(`UPDATE users SET mx_token = '' WHERE id = ?`, u.ID)
}

var chatAdmin struct {
	mu    sync.Mutex
	token string
}

// chatAdminToken returns a token for our service account on the homeserver,
// registering it as a server admin the first time.
func (s *Server) chatAdminToken(ctx context.Context) (string, error) {
	chatAdmin.mu.Lock()
	defer chatAdmin.mu.Unlock()
	if chatAdmin.token != "" {
		return chatAdmin.token, nil
	}
	var nonce struct {
		Nonce string `json:"nonce"`
	}
	if _, err := s.matrix(ctx, "GET", "/_synapse/admin/v1/register", "", nil, &nonce); err == nil && nonce.Nonce != "" {
		pw := s.deriveHex("chat-admin-password")
		mac := hmac.New(sha1.New, []byte(s.cfg.MatrixSecret))
		mac.Write([]byte(nonce.Nonce + "\x00" + chatAdminUser + "\x00" + pw + "\x00admin"))
		// "User already exists" on later runs is expected.
		s.matrix(ctx, "POST", "/_synapse/admin/v1/register", "", map[string]any{
			"nonce": nonce.Nonce, "username": chatAdminUser, "password": pw, "admin": true, "mac": hex.EncodeToString(mac.Sum(nil)),
		}, nil)
	}
	tok, err := s.chatToken(ctx, chatAdminUser)
	if err != nil {
		return "", err
	}
	chatAdmin.token = tok
	return tok, nil
}

// chatDeactivate permanently closes a removed person's chat account.
func (s *Server) chatDeactivate(u *User) {
	if s.cfg.MatrixURL == "" || u.MxLocal == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tok, err := s.chatAdminToken(ctx)
	if err != nil {
		log.Printf("chat: admin token: %v", err)
		return
	}
	if _, err := s.matrix(ctx, "POST", "/_synapse/admin/v1/deactivate/"+url.PathEscape(s.mxid(u.MxLocal)), tok, map[string]any{"erase": false}, nil); err != nil {
		log.Printf("chat: deactivating %s: %v", u.Email, err)
	}
}

// provision makes sure a person exists in the chat and mail engines. It is
// safe to call repeatedly and never blocks sign-in for long.
func (s *Server) provision(u *User) {
	if u == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	if u.MxToken == "" {
		wg.Add(1)
		go func() { defer wg.Done(); s.chatEnsure(ctx, u) }()
	}
	if !u.MailReady {
		wg.Add(1)
		go func() { defer wg.Done(); s.mailEnsureAccount(ctx, u) }()
	}
	wg.Wait()
}
