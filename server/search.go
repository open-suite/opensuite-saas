package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"unicode"
)

// Search over what the server holds: the titles and text of documents and
// spreadsheets. (Mail and chat are searched in their own engines, straight
// from the browser.)
//
// The server never reads a document's content: it is an opaque snapshot and
// log. So a client that may edit a document sends its plain text over the
// sync connection (message type 10) a few seconds after it changes, and that
// text is what gets indexed. doc_text holds one row per document; doc_fts is
// the full-text index over it. Triggers keep both in step with the docs
// table, so no other code has to remember search exists.
const searchSchema = `
CREATE TABLE IF NOT EXISTS doc_text(
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL UNIQUE,
  org TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  title, body, org,
  content='doc_text', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS doc_text_ai AFTER INSERT ON doc_text BEGIN
  INSERT INTO doc_fts(rowid, title, body, org) VALUES (new.id, new.title, new.body, new.org);
END;
CREATE TRIGGER IF NOT EXISTS doc_text_ad AFTER DELETE ON doc_text BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, title, body, org) VALUES ('delete', old.id, old.title, old.body, old.org);
END;
CREATE TRIGGER IF NOT EXISTS doc_text_au AFTER UPDATE OF title, body ON doc_text BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, title, body, org) VALUES ('delete', old.id, old.title, old.body, old.org);
  INSERT INTO doc_fts(rowid, title, body, org) VALUES (new.id, new.title, new.body, new.org);
END;
CREATE TRIGGER IF NOT EXISTS docs_search_ai AFTER INSERT ON docs BEGIN
  INSERT OR IGNORE INTO doc_text(doc_id, org, title) VALUES (new.id, new.org_id, new.title);
END;
CREATE TRIGGER IF NOT EXISTS docs_search_au AFTER UPDATE OF title ON docs BEGIN
  UPDATE doc_text SET title = new.title WHERE doc_id = new.id AND title IS NOT new.title;
END;
CREATE TRIGGER IF NOT EXISTS docs_search_ad AFTER DELETE ON docs BEGIN
  DELETE FROM doc_text WHERE doc_id = old.id;
END;
INSERT OR IGNORE INTO doc_text(doc_id, org, title) SELECT id, org_id, title FROM docs;
`

// msgText is the sync message (client to server) that carries a document's
// plain text. It sits beside the message types in docs.go.
const msgText = 10

// The most text kept per document. Past this a document is still found by
// what comes first in it.
const maxIndexText = 1 << 20

// indexText stores the plain text a client extracted from a document and
// notes the sequence number it reflects.
func (s *Server) indexText(rm *room, text []byte) {
	if len(text) > maxIndexText {
		text = text[:maxIndexText]
	}
	body := strings.ToValidUTF8(string(text), "")
	rm.mu.Lock()
	seq := rm.seq
	rm.mu.Unlock()
	// Unchanged text is not rewritten, so the index is not rebuilt for it.
	s.w.Exec(`UPDATE doc_text SET body = ?1 WHERE doc_id = ?2 AND body IS NOT ?1`, body, rm.id)
	s.w.Exec(`UPDATE doc_text SET seq = ? WHERE doc_id = ?`, seq, rm.id)
}

// textFresh reports (as the byte sent in the hello message) whether the index
// already reflects the document at sequence seq. When it does not (a document
// from before search existed, or an editor that closed mid-sentence) the next
// client that may edit sends the text again.
func (s *Server) textFresh(id string, seq int64) byte {
	at := int64(-1)
	s.r.QueryRow(`SELECT seq FROM doc_text WHERE doc_id = ?`, id).Scan(&at)
	if at >= seq {
		return 1
	}
	return 0
}

// ftsQuery turns what someone typed into a full-text query: every word must
// be present, each matched as a prefix so results follow the typing. Only
// letters and digits survive, so nothing typed can reach the query syntax.
func ftsQuery(q string) string {
	var terms []string
	for _, f := range strings.FieldsFunc(q, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len(terms) == 8 {
			break
		}
		terms = append(terms, `"`+f+`"*`)
	}
	return strings.Join(terms, " ")
}

// DocHit is a document as the document list describes it (so the app can open
// one it had not heard of yet), plus where it matched.
type DocHit struct {
	Doc
	// Snippet is text around the match; the matched words sit between the
	// control characters \x02 and \x03.
	Snippet string `json:"snippet"`
	URL     string `json:"url,omitempty"` // filled in by the API, which names where it opens
}

// searchDocs finds documents the user may open whose title or text matches.
// The organisation is part of the full-text query itself, and the usual
// permission rule (owner, shared with the organisation, shared by name) is
// applied on top; trashed documents are left out.
func (s *Server) searchDocs(u *User, q string, limit int) []DocHit {
	out := []DocHit{}
	match := ftsQuery(q)
	if match == "" || strings.Trim(u.OrgID, idAlphabet) != "" {
		return out
	}
	match = `{title body} : (` + match + `) AND org : "` + u.OrgID + `"`
	rows, err := s.r.Query(`SELECT d.id, d.kind, d.title, d.access, d.owner_id, d.created, d.updated, coalesce(sh.role, ''),
			snippet(doc_fts, 1, char(2), char(3), '…', 18)
		FROM doc_fts
		JOIN doc_text t ON t.id = doc_fts.rowid
		JOIN docs d ON d.id = t.doc_id
		LEFT JOIN doc_shares sh ON sh.doc_id = d.id AND sh.user_id = ?1
		WHERE doc_fts MATCH ?2 AND d.org_id = ?3 AND d.trashed = 0
			AND (d.owner_id = ?1 OR d.access = 'org' OR sh.user_id IS NOT NULL)
		ORDER BY bm25(doc_fts, 10.0, 1.0, 0.0), d.updated DESC LIMIT ?4`, u.ID, match, u.OrgID, limit)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var h DocHit
		var share string
		var snip sql.NullString
		if rows.Scan(&h.ID, &h.Kind, &h.Title, &h.Access, &h.Owner, &h.Created, &h.Updated, &share, &snip) == nil {
			h.Role = roleOf(u, h.Owner, h.Access, share)
			h.Shares = []Share{}
			h.Snippet = strings.Join(strings.Fields(snip.String), " ")
			out = append(out, h)
		}
	}
	return out
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request, u *User) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 200 {
		q = q[:200]
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 50 {
		limit = 20
	}
	w.Header().Set("Cache-Control", "no-store")
	ok(w, map[string]any{"docs": s.searchDocs(u, q, limit)})
}
