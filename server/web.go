package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type shellCache struct {
	mu   sync.Mutex
	mod  time.Time
	html []byte
}

var shell shellCache

func (s *Server) shellHTML() []byte {
	shell.mu.Lock()
	defer shell.mu.Unlock()
	p := filepath.Join(s.cfg.WebDir, "index.html")
	st, err := os.Stat(p)
	if err != nil {
		return []byte("<!doctype html><title>Open Suite</title><p>The web app has not been built.")
	}
	if shell.html == nil || !st.ModTime().Equal(shell.mod) {
		shell.html, _ = os.ReadFile(p)
		shell.mod = st.ModTime()
	}
	return shell.html
}

// handleApp serves the single-page app. The first HTML response carries the
// whole boot object inline, so a cold visit paints real content without a
// second round trip. nginx serves /assets itself; this fallback covers
// development and the handful of root files.
func (s *Server) handleApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		fail(w, 405, "method not allowed")
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	if clean != "/" && strings.Contains(filepath.Base(clean), ".") {
		f := filepath.Join(s.cfg.WebDir, clean)
		if st, err := os.Stat(f); err == nil && !st.IsDir() {
			if strings.HasPrefix(clean, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.ServeFile(w, r, f)
			return
		}
		http.NotFound(w, r)
		return
	}
	html := s.shellHTML()
	nonce := newToken()[:24]
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()")
	// Everything the app runs comes from this origin. Only our own scripts
	// execute; mail and documents can show remote images but nothing else
	// from elsewhere, and no other site may frame us.
	w.Header().Set("Content-Security-Policy", "default-src 'self'; "+
		"script-src 'self' 'wasm-unsafe-eval' 'nonce-"+nonce+"'; "+
		"style-src 'self' 'unsafe-inline'; "+
		"img-src 'self' data: blob: https: http:; "+
		"media-src 'self' blob:; font-src 'self' data:; "+
		"connect-src 'self' wss://"+r.Host+"; "+
		"worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
	// The service worker asks for the bare shell; it must never cache one
	// person's data.
	if r.URL.Query().Has("shell") {
		w.Write(bytes.Replace(html, []byte("<!--BOOT-->"), nil, 1))
		return
	}
	u := s.sessionUser(r)
	boot, _ := json.Marshal(s.boot(u)) // encoding/json escapes <, > and &
	var b bytes.Buffer
	b.WriteString(`<script nonce="` + nonce + `">window.__BOOT__=`)
	b.Write(boot)
	b.WriteString("</script>")
	w.Write(bytes.Replace(html, []byte("<!--BOOT-->"), b.Bytes(), 1))
}

func (s *Server) handleWellKnownClient(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	ok(w, map[string]any{"m.homeserver": map[string]string{"base_url": "https://" + s.cfg.Domain}})
}

func (s *Server) handleWellKnownServer(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]string{"m.server": s.cfg.Domain + ":443"})
}

// --- uploaded images and attachments used inside documents ---

func (s *Server) orgUsage(orgID string) int64 {
	var blobs, docs, log int64
	s.r.QueryRow(`SELECT coalesce(sum(size), 0) FROM blobs WHERE org_id = ?`, orgID).Scan(&blobs)
	s.r.QueryRow(`SELECT coalesce(sum(length(snap)), 0) FROM docs WHERE org_id = ?`, orgID).Scan(&docs)
	s.r.QueryRow(`SELECT coalesce(sum(length(u.data)), 0) FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.org_id = ?`, orgID).Scan(&log)
	return blobs + docs + log
}

func (s *Server) handleBlobPut(w http.ResponseWriter, r *http.Request, u *User) {
	var plan string
	s.r.QueryRow(`SELECT plan FROM orgs WHERE id = ?`, u.OrgID).Scan(&plan)
	if s.orgUsage(u.OrgID) > int64(planFor(plan).StorageGB)<<30 {
		fail(w, 507, "Your organisation's storage is full.")
		return
	}
	id := newID(20)
	path := filepath.Join(s.cfg.DataDir, "blobs", id)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o640)
	if err != nil {
		fail(w, 500, "storage error")
		return
	}
	n, err := io.Copy(f, http.MaxBytesReader(w, r.Body, 50<<20))
	f.Close()
	if err != nil {
		os.Remove(path)
		fail(w, 413, "That file is too large (50 MB limit).")
		return
	}
	mime := r.Header.Get("Content-Type")
	if mime == "" {
		mime = "application/octet-stream"
	}
	s.w.Exec(`INSERT INTO blobs(id, org_id, owner_id, name, mime, size, created) VALUES(?,?,?,?,?,?,?)`,
		id, u.OrgID, u.ID, r.URL.Query().Get("name"), mime, n, now())
	ok(w, map[string]any{"id": id, "url": "/api/blobs/" + id, "size": n})
}

func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request, u *User) {
	var mime, name string
	if s.r.QueryRow(`SELECT mime, name FROM blobs WHERE id = ? AND org_id = ?`, r.PathValue("id"), u.OrgID).Scan(&mime, &name) != nil {
		http.NotFound(w, r)
		return
	}
	// Uploads are served as data, never as a page on our origin.
	if !strings.HasPrefix(mime, "image/") || strings.Contains(mime, "svg") {
		w.Header().Set("Content-Disposition", "attachment")
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, filepath.Join(s.cfg.DataDir, "blobs", r.PathValue("id")))
}
