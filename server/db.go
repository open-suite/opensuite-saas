package main

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS orgs(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  pw_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  mx_local TEXT NOT NULL DEFAULT '',
  mx_token TEXT NOT NULL DEFAULT '',
  mail_secret TEXT NOT NULL DEFAULT '',
  mail_ready INTEGER NOT NULL DEFAULT 0,
  mail_id TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS users_org ON users(org_id);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domains(
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  web_ok INTEGER NOT NULL DEFAULT 0,
  mail_ok INTEGER NOT NULL DEFAULT 0,
  dkim TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT 'private',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0,
  snap BLOB,
  snap_seq INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_org ON docs(org_id, updated DESC);
CREATE TABLE IF NOT EXISTS doc_updates(
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY(doc_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS doc_shares(
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'edit',
  PRIMARY KEY(doc_id, user_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meetings(
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blobs(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(
  k TEXT PRIMARY KEY,
  v BLOB NOT NULL
) WITHOUT ROWID;
`

// openDB returns a single-connection write handle and a pooled read handle on
// the same WAL database. One writer means SQLite never returns SQLITE_BUSY to
// us; readers never block behind it.
func openDB(dir string) (w, r *sql.DB, err error) {
	path := filepath.Join(dir, "opensuite.db")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=cache_size(-16000)", path)
	if w, err = sql.Open("sqlite", dsn); err != nil {
		return nil, nil, err
	}
	w.SetMaxOpenConns(1)
	if _, err = w.Exec(schema); err != nil {
		return nil, nil, fmt.Errorf("schema: %w", err)
	}
	if r, err = sql.Open("sqlite", dsn+"&mode=ro"); err != nil {
		return nil, nil, err
	}
	r.SetMaxOpenConns(8)
	return w, r, nil
}
