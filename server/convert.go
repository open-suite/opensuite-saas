package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Word-processor import and export run pandoc as a short-lived native tool:
// nothing stays resident, and --sandbox means a hostile file can read neither
// the disk nor the network. Spreadsheets need no server help at all: the
// engine in the browser reads and writes .xlsx itself.

type conversion struct {
	args []string
	out  string // output extension
	mime string
}

var conversions = map[string]conversion{
	"docx>html": {[]string{"-f", "docx", "-t", "html", "--embed-resources"}, "html", "text/html; charset=utf-8"},
	"odt>html":  {[]string{"-f", "odt", "-t", "html", "--embed-resources"}, "html", "text/html; charset=utf-8"},
	"md>html":   {[]string{"-f", "gfm", "-t", "html"}, "html", "text/html; charset=utf-8"},
	"html>docx": {[]string{"-f", "html", "-t", "docx"}, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
	"html>odt":  {[]string{"-f", "html", "-t", "odt"}, "odt", "application/vnd.oasis.opendocument.text"},
	"html>md":   {[]string{"-f", "html", "-t", "gfm"}, "md", "text/markdown; charset=utf-8"},
}

func (s *Server) handleConvert(w http.ResponseWriter, r *http.Request, u *User) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	c, found := conversions[from+">"+to]
	if !found {
		fail(w, 400, "That conversion isn't supported.")
		return
	}
	if !s.lim.allow("convert:"+u.ID, 30, time.Minute) {
		fail(w, 429, "Too many conversions. Try again in a minute.")
		return
	}
	out, err := runPandoc(r.Context(), c, from, http.MaxBytesReader(w, r.Body, 40<<20))
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	w.Header().Set("Content-Type", c.mime)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}

// runPandoc converts one file in a scratch directory of its own.
func runPandoc(ctx context.Context, c conversion, from string, body io.Reader) ([]byte, error) {
	dir, err := os.MkdirTemp("", "os-convert-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	in, out := filepath.Join(dir, "in."+from), filepath.Join(dir, "out."+c.out)
	f, err := os.Create(in)
	if err != nil {
		return nil, err
	}
	_, err = io.Copy(f, body)
	f.Close()
	if err != nil {
		return nil, engineError("That file is too large (40 MB limit).")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	args := append([]string{"--sandbox"}, c.args...)
	cmd := exec.CommandContext(ctx, env("OS_PANDOC", "pandoc"), append(args, "-o", out, in)...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + dir, "LANG=C.UTF-8"}
	if msg, err := cmd.CombinedOutput(); err != nil {
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, engineError("That file couldn't be converted. " + string(msg))
	}
	return os.ReadFile(out)
}
