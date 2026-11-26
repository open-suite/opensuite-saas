package main

// Profile pictures. A member may set one; everyone in their organisation sees
// it wherever their initials would otherwise be. The browser shrinks a chosen
// picture to a small square before sending it, so the server only stores the
// bytes it is given, after checking they are a picture.

import (
	"bytes"
	"database/sql"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"time"
)

func init() {
	migrations = append(migrations, func(w *sql.DB) error {
		// photo is a version (the time it was set), so the browser can cache
		// a picture for good and still see a new one at once; 0 for none.
		if err := ensureColumn(w, "users", "photo", "INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
		return ensureColumn(w, "users", "photo_type", "TEXT NOT NULL DEFAULT ''")
	})
}

const maxPhoto = 1 << 20

var photoTypes = []string{"image/png", "image/jpeg", "image/webp"}

func (s *Server) photoPath(userID string) string {
	return filepath.Join(s.cfg.DataDir, "photos", userID)
}

// setPhoto stores a member's picture; body nil removes it.
func (s *Server) setPhoto(userID string, body []byte) error {
	if body == nil {
		os.Remove(s.photoPath(userID))
		_, err := s.w.Exec(`UPDATE users SET photo = 0, photo_type = '' WHERE id = ?`, userID)
		return err
	}
	kind := http.DetectContentType(body)
	if !slices.Contains(photoTypes, kind) {
		return errf("not a picture")
	}
	if err := os.MkdirAll(filepath.Dir(s.photoPath(userID)), 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(s.photoPath(userID), body, 0o640); err != nil {
		return err
	}
	_, err := s.w.Exec(`UPDATE users SET photo = ?, photo_type = ? WHERE id = ?`, time.Now().UnixMilli(), kind, userID)
	return err
}

// dropPhoto deletes the picture of someone who was removed.
func (s *Server) dropPhoto(userID string) { os.Remove(s.photoPath(userID)) }

func (s *Server) photoOps() []*apiOp {
	return []*apiOp{
		{Method: "GET", Path: "/api/v1/people/{id}/photo", ID: "get_person_photo", Tag: "People", Summary: "Get a person's profile picture",
			Desc:   "The picture's bytes (PNG, JPEG or WebP). 404 if they have none; `photo` in Person is 0 then.",
			Params: []apiParam{pathParam("id", "Member id, or their mail address.")}, File: true, H: s.handlePhotoGet},
		{Method: "PUT", Path: "/api/v1/me/photo", ID: "set_my_photo", Tag: "Account", Summary: "Set my profile picture", Write: true,
			Desc: "Send a PNG, JPEG or WebP picture of up to 1 MB as the body. A small square works best; it is shown in a circle.",
			Raw:  "The picture's bytes.", Result: okResult, H: s.handlePhotoPut},
		{Method: "DELETE", Path: "/api/v1/me/photo", ID: "remove_my_photo", Tag: "Account", Summary: "Remove my profile picture", Write: true,
			Result: okResult, H: s.handlePhotoDelete},
	}
}

func (s *Server) handlePhotoGet(w http.ResponseWriter, r *http.Request, u *User) {
	p := s.personIn(u.OrgID, r.PathValue("id"))
	if p == nil {
		fail(w, 404, "No such person.")
		return
	}
	var kind string
	s.r.QueryRow(`SELECT photo_type FROM users WHERE id = ?`, p.ID).Scan(&kind)
	body, err := os.ReadFile(s.photoPath(p.ID))
	if kind == "" || err != nil {
		fail(w, 404, "No picture.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", kind)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	// The app asks with ?v=<version>, so a new picture is a new address.
	if r.URL.Query().Get("v") != "" {
		h.Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	w.Write(body)
}

func (s *Server) handlePhotoPut(w http.ResponseWriter, r *http.Request, u *User) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPhoto+1))
	if err != nil || len(body) == 0 {
		fail(w, 400, "Send the picture as the request body.")
		return
	}
	if len(body) > maxPhoto {
		fail(w, 413, "Pictures can be up to 1 MB.")
		return
	}
	if err := s.setPhoto(u.ID, bytes.Clone(body)); err != nil {
		fail(w, 400, "That is not a PNG, JPEG or WebP picture.")
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) handlePhotoDelete(w http.ResponseWriter, r *http.Request, u *User) {
	s.setPhoto(u.ID, nil)
	ok(w, map[string]bool{"ok": true})
}
