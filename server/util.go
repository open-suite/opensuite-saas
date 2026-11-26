package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

func now() int64 { return time.Now().Unix() }

const idAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

func newID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return string(b)
}

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func ok(w http.ResponseWriter, v any) { writeJSON(w, 200, v) }

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(v)
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	h, _, _ := net.SplitHostPort(r.RemoteAddr)
	return h
}

// --- passwords: argon2id, encoded as salt$hash ---

// cleanPassword drops whitespace around a password. A password copied from a
// message or a table often arrives with a stray space or line break, and
// nobody means that to be part of it. Applied both when setting and checking.
func cleanPassword(pw string) string { return strings.TrimSpace(pw) }

func hashPassword(pw string) string {
	pw = cleanPassword(pw)
	salt := make([]byte, 16)
	rand.Read(salt)
	h := argon2.IDKey([]byte(pw), salt, 2, 32*1024, 2, 32)
	return base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(h)
}

func checkPassword(enc, pw string) bool {
	a, b, found := strings.Cut(enc, "$")
	if !found {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(a)
	want, err2 := base64.RawStdEncoding.DecodeString(b)
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(cleanPassword(pw)), salt, 2, 32*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

// --- a small fixed-window limiter for login and signup ---

type limiter struct {
	mu sync.Mutex
	m  map[string]*window
}

type window struct {
	n     int
	reset int64
}

func newLimiter() *limiter { return &limiter{m: map[string]*window{}} }

// allow reports whether key may act again: at most max actions per period.
func (l *limiter) allow(key string, max int, period time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := now()
	if len(l.m) > 50000 {
		for k, w := range l.m {
			if w.reset < t {
				delete(l.m, k)
			}
		}
	}
	w := l.m[key]
	if w == nil || w.reset < t {
		l.m[key] = &window{n: 1, reset: t + int64(period.Seconds())}
		return true
	}
	w.n++
	return w.n <= max
}

// guard applies the cross-site request rule for the whole API: a state
// changing request must come from our own pages. Browsers always send Origin
// on cross-site POSTs, so comparing it with Host is sufficient with a
// SameSite=Lax cookie. Requests that carry no cookie authority are exempt:
// the public API with a Bearer token (a cookie is then ignored, see
// apiCaller), and the MCP server and OAuth endpoints, which never read one.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		noCookie := (r.Header.Get("Authorization") != "" && strings.HasPrefix(p, "/api/v1/")) ||
			p == "/mcp" || p == "/oauth/token" || p == "/oauth/register" || p == "/oauth/revoke"
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" && !noCookie {
			if o := r.Header.Get("Origin"); o != "" && !sameHost(o, r.Host) {
				fail(w, 403, "cross-site request refused")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func sameHost(origin, host string) bool {
	o := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	return strings.EqualFold(o, host)
}

func varint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func readVarint(b []byte) (uint64, int) {
	var v uint64
	for i := 0; i < len(b) && i < 10; i++ {
		v |= uint64(b[i]&0x7f) << (7 * i)
		if b[i] < 0x80 {
			return v, i + 1
		}
	}
	return 0, 0
}

func errf(format string, a ...any) error { return fmt.Errorf(format, a...) }
