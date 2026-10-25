package factory

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("conflict")

type Store struct {
	db   *sql.DB
	lock *os.File
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("data directory is already in use by another daemon")
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "state.db"))
	if err != nil {
		lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, lock: lock}
	_, err = db.Exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta (version INTEGER NOT NULL);
INSERT INTO meta SELECT 3 WHERE NOT EXISTS (SELECT 1 FROM meta);
CREATE TABLE IF NOT EXISTS documents (
 kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY (kind,id)
);
-- Both list orders and the status probes walk an index, so a page or a
-- count touches only the documents it returns.
DROP INDEX IF EXISTS runs_status;
CREATE INDEX IF NOT EXISTS documents_created ON documents(kind, json_extract(data,'$.created_at'), id);
CREATE INDEX IF NOT EXISTS documents_status_created ON documents(kind, json_extract(data,'$.status'), json_extract(data,'$.created_at'), id);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL,
 time TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
CREATE TABLE IF NOT EXISTS dedup (
 key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL
);
`)
	if err != nil {
		s.Close()
		return nil, err
	}
	var version int
	if err = db.QueryRow("SELECT version FROM meta").Scan(&version); err != nil || version != 3 {
		s.Close()
		return nil, fmt.Errorf("unsupported database schema version %d", version)
	}
	return s, nil
}
func (s *Store) Close() error {
	err := s.db.Close()
	_ = unix.Flock(int(s.lock.Fd()), unix.LOCK_UN)
	_ = s.lock.Close()
	return err
}

type change struct {
	kind, id string
	value    any
}
type eventWrite struct {
	runID, kind string
	value       any
}
type dedupWrite struct {
	key, fingerprint string
	value            any
}

func (s *Store) commit(changes []change, events []eventWrite, dedup *dedupWrite) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, c := range changes {
		if c.value == nil {
			_, err = tx.Exec("DELETE FROM documents WHERE kind=? AND id=?", c.kind, c.id)
		} else {
			var b []byte
			b, err = json.Marshal(c.value)
			if err == nil {
				_, err = tx.Exec("INSERT INTO documents(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", c.kind, c.id, string(b))
			}
		}
		if err != nil {
			return err
		}
	}
	for _, e := range events {
		b, err := json.Marshal(e.value)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO events(run_id,type,time,data) VALUES(?,?,?,?)", e.runID, e.kind, now().Format("2006-01-02T15:04:05.999999999Z07:00"), string(b)); err != nil {
			return err
		}
	}
	if dedup != nil && dedup.key != "" {
		b, err := json.Marshal(dedup.value)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO dedup(key,fingerprint,result) VALUES(?,?,?)", dedup.key, dedup.fingerprint, string(b)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func get[T any](s *Store, kind, id string) (T, error) {
	var v T
	var b string
	err := s.db.QueryRow("SELECT data FROM documents WHERE kind=? AND id=?", kind, id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(b), &v)
	return v, err
}
func list[T any](s *Store, kind, status string, limit, offset int) ([]T, error) {
	query := "SELECT data FROM documents WHERE kind=?"
	args := []any{kind}
	if status != "" {
		query += " AND json_extract(data,'$.status')=?"
		args = append(args, status)
	}
	query += " ORDER BY json_extract(data,'$.created_at'), id LIMIT ? OFFSET ?"
	args = append(args, limit, offset)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []T{}
	for rows.Next() {
		var b string
		var v T
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(b), &v); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}
func (s *Store) duplicate(key, fingerprint string, result any) (bool, error) {
	if key == "" {
		return false, nil
	}
	var fp, b string
	err := s.db.QueryRow("SELECT fingerprint,result FROM dedup WHERE key=?", key).Scan(&fp, &b)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if fp != fingerprint {
		return false, fmt.Errorf("%w: idempotency key reused with a different payload", ErrConflict)
	}
	return true, json.Unmarshal([]byte(b), result)
}
func (s *Store) Events(runID string, after int64, limit int) ([]Event, error) {
	rows, err := s.db.Query("SELECT id,run_id,type,time,data FROM events WHERE run_id=? AND id>? ORDER BY id LIMIT ?", runID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Event{}
	for rows.Next() {
		var e Event
		var timestamp string
		var data string
		if err := rows.Scan(&e.ID, &e.RunID, &e.Type, &timestamp, &data); err != nil {
			return nil, err
		}
		if err := e.Time.UnmarshalText([]byte(timestamp)); err != nil {
			return nil, err
		}
		e.Data = json.RawMessage(data)
		result = append(result, e)
	}
	return result, rows.Err()
}
