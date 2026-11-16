package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	// maxRunAttempts bounds how often one inbox event may start a run before it
	// is dead-lettered. With runBackoff this tolerates about an hour of outage.
	maxRunAttempts  = 8
	maxSendAttempts = 8
)

// migrations are applied in order; PRAGMA user_version records how many have
// run. Append, never edit: a deployed database has already run the earlier ones.
//
// Times are unix seconds. pending_approvals.user_id is UNIQUE so that a bare
// "yes" from the user can only ever refer to one call.
var migrations = []string{schemaV1, schemaV2, schemaV3, schemaV4}

const schemaV1 = `
CREATE TABLE IF NOT EXISTS inbox (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  source     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_after  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (user_id, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS timers (
  id               INTEGER PRIMARY KEY,
  user_id          TEXT NOT NULL,
  due_at           INTEGER NOT NULL,
  note             TEXT NOT NULL,
  interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds > 0)
) STRICT;
CREATE INDEX IF NOT EXISTS timers_due ON timers (due_at);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE,
  transcript TEXT NOT NULL,
  tool_call  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  send_after INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (user_id, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_sent ON outbox (user_id, sent_at);
`

// schemaV2 gives events and messages an address, so adapters can route them.
//
//	inbox.origin      where the event came from, as "adapter:..."; replies and reactions point at it
//	inbox.approval    nonce of the approval prompt this event is a click on
//	inbox.dedupe      adapter-unique event id; a redelivery hits the unique index and is dropped
//	outbox.address    where to deliver, as "adapter:..."; empty means the user's default route
//	outbox.options    JSON Options: threading, approval nonce, adapter-specific properties
//	outbox.remote_id  address of the delivered message, as reported by the adapter
const schemaV2 = `
ALTER TABLE inbox ADD COLUMN origin TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN approval TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox ADD COLUMN dedupe TEXT;
CREATE UNIQUE INDEX inbox_dedupe ON inbox (dedupe);

ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'reaction'));
ALTER TABLE outbox ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE outbox ADD COLUMN remote_id TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX outbox_remote ON outbox (user_id, remote_id) WHERE remote_id != '';

ALTER TABLE pending_approvals ADD COLUMN nonce TEXT NOT NULL DEFAULT '';
`

// schemaV3 records who spoke, for conversations with more than one person, and
// where a timer was set, so that what it produces returns to that conversation.
const schemaV3 = `
ALTER TABLE inbox ADD COLUMN sender TEXT NOT NULL DEFAULT '';
ALTER TABLE timers ADD COLUMN origin TEXT NOT NULL DEFAULT '';
`

// schemaV4 adds durable work. A task is a piece of work the agent has taken
// on. It is written the moment the agent says so, outside the run's
// transaction, so it outlives a run that fails, is cut off, or dies with the
// process. An open task always has a wake_at: when it passes, the scheduler
// writes an inbox event and the agent is woken to carry on from its notes.
const schemaV4 = `
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'dropped')),
  notes      TEXT NOT NULL DEFAULT '',
  origin     TEXT NOT NULL DEFAULT '',
  wake_at    INTEGER NOT NULL,
  idle_wakes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_open ON tasks (user_id, id) WHERE state = 'open';
CREATE INDEX tasks_wake ON tasks (wake_at) WHERE state = 'open';
`

// Event is one inbox row.
type Event struct {
	ID        int64
	Source    string
	Payload   string
	From      string // who spoke, as the adapter names them; empty when there is only the user
	Origin    string // address of the message the event is, empty if it has none
	Approval  string // nonce of the approval prompt the event is a click on
	Attempts  int
	CreatedAt time.Time
}

// Timer is one timers row. Interval is zero for a one-off. Origin is the
// conversation the timer was set in; its event carries it when it fires.
type Timer struct {
	ID       int64
	UserID   string
	DueAt    time.Time
	Note     string
	Interval time.Duration
	Origin   string
}

// Task is one tasks row: work in flight, with the notes to resume it from.
type Task struct {
	ID        int64
	Title     string
	Notes     string
	Origin    string // the conversation it was taken on in; its wake-ups return there
	WakeAt    time.Time
	IdleWakes int // wake-ups since the agent last recorded progress
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Approval is a run parked on a tool call that needs the user's decision.
// Nonce ties a click on the approval prompt to this approval and no other.
type Approval struct {
	ID         int64
	Transcript string
	ToolCall   string
	Nonce      string
}

// Exchange is one past message between the user and the agent. Where is the
// address it was said at, when it has one.
type Exchange struct {
	At    time.Time
	From  string // the speaker as the adapter named them, "user", or "you"
	Text  string
	Where string
}

// effects is everything a run wants written to the database. It is applied in
// one transaction together with marking the run's events done, so a run that
// fails or is retried leaves no partial trace.
type effects struct {
	out      []Outbound
	timers   []Timer
	cancels  []int64
	resolved int64     // approval consumed by this run, 0 if none
	approval *Approval // set when the run parked on a new approval
}

type Store struct{ db *sql.DB }

func OpenStore(path string) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// synchronous=FULL: an acknowledged inbox event must survive power loss.
	dsn := url.URL{Scheme: "file", Path: abs, RawQuery: "_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	// One connection: every transaction is short, and writers never contend.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version > len(migrations) {
		return fmt.Errorf("database is at schema %d, this binary knows %d: it was written by a newer kiln", version, len(migrations))
	}
	for ; version < len(migrations); version++ {
		err := s.tx(context.Background(), func(tx *sql.Tx) error {
			if _, err := tx.Exec(migrations[version]); err != nil {
				return err
			}
			_, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, version+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("migrate to schema %d: %w", version+1, err)
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// backoff is the delay before retry number attempt (1-based): 30s doubling, capped at 1h.
func backoff(attempt int) time.Duration {
	d := 30 * time.Second
	for i := 1; i < attempt && d < time.Hour; i++ {
		d *= 2
	}
	return min(d, time.Hour)
}

// AddEvent records that something happened. It is the only thing ingestion
// does. An event whose Dedupe key is already recorded is a redelivery: it is
// dropped and reported as a duplicate.
func (s *Store) AddEvent(ctx context.Context, in Inbound, now time.Time) (id int64, duplicate bool, err error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO inbox (user_id, source, payload, sender, origin, approval, dedupe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (dedupe) DO NOTHING`,
		in.User, in.Source, in.Text, in.From, in.Origin, in.Approval, sql.NullString{String: in.Dedupe, Valid: in.Dedupe != ""}, now.Unix())
	if err != nil {
		return 0, false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return 0, err == nil, err
	}
	id, err = res.LastInsertId()
	return id, false, err
}

// EventOrigin returns the origin of one of the user's events, old or new.
func (s *Store) EventOrigin(ctx context.Context, user string, id int64) (origin string, found bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT origin FROM inbox WHERE id = ? AND user_id = ?`, id, user).Scan(&origin)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return origin, err == nil, err
}

// RunnableUsers lists users with at least one pending event that is not
// backing off, oldest event first.
func (s *Store) RunnableUsers(ctx context.Context, now time.Time) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT user_id FROM inbox WHERE status = 'pending' AND run_after <= ?
		 GROUP BY user_id ORDER BY MIN(id)`, now.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// ClaimBatch returns every pending event for the user, in order, and counts
// the attempt up front so that a crash mid-run still consumes one. Events out
// of attempts are marked failed and reported to the user instead.
func (s *Store) ClaimBatch(ctx context.Context, user string, now time.Time) (events []Event, dead int64, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE inbox SET status = 'failed' WHERE user_id = ? AND status = 'pending' AND attempts >= ?`,
			user, maxRunAttempts)
		if err != nil {
			return err
		}
		if dead, err = res.RowsAffected(); err != nil {
			return err
		}
		if dead > 0 {
			notice := fmt.Sprintf("Gave up on %d event(s) after %d failed runs each. They are marked failed in the inbox; the kiln log has the errors.", dead, maxRunAttempts)
			if _, err := tx.ExecContext(ctx, `INSERT INTO outbox (user_id, body, created_at) VALUES (?, ?, ?)`, user, notice, now.Unix()); err != nil {
				return err
			}
		}
		rows, err := tx.QueryContext(ctx,
			`UPDATE inbox SET attempts = attempts + 1 WHERE user_id = ? AND status = 'pending'
			 RETURNING id, source, payload, sender, origin, approval, attempts, created_at`, user)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e Event
			var created int64
			if err := rows.Scan(&e.ID, &e.Source, &e.Payload, &e.From, &e.Origin, &e.Approval, &e.Attempts, &created); err != nil {
				return err
			}
			e.CreatedAt = time.Unix(created, 0)
			events = append(events, e)
		}
		return rows.Err()
	})
	sort.Slice(events, func(i, j int) bool { return events[i].ID < events[j].ID })
	return events, dead, err
}

// Backoff delays the next run of a failed batch. throughID is the batch's last
// event id; inbox ids only grow, so "pending and <= throughID" is the batch.
func (s *Store) Backoff(ctx context.Context, user string, throughID int64, until time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE inbox SET run_after = ? WHERE user_id = ? AND status = 'pending' AND id <= ?`,
		until.Unix(), user, throughID)
	return err
}

// Commit applies a run's effects and marks its batch done, atomically.
func (s *Store) Commit(ctx context.Context, user string, throughID int64, e effects, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, m := range e.out {
			options, err := json.Marshal(m.Options)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO outbox (user_id, kind, address, body, options, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
				user, m.Kind, m.Address, m.Body, string(options), now.Unix()); err != nil {
				return err
			}
		}
		for _, t := range e.timers {
			if err := insertTimer(ctx, tx, user, t); err != nil {
				return err
			}
		}
		for _, id := range e.cancels {
			if _, err := tx.ExecContext(ctx, `DELETE FROM timers WHERE id = ? AND user_id = ?`, id, user); err != nil {
				return err
			}
		}
		if e.resolved != 0 {
			if _, err := tx.ExecContext(ctx, `DELETE FROM pending_approvals WHERE id = ? AND user_id = ?`, e.resolved, user); err != nil {
				return err
			}
		}
		if e.approval != nil {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO pending_approvals (user_id, transcript, tool_call, nonce) VALUES (?, ?, ?, ?)`,
				user, e.approval.Transcript, e.approval.ToolCall, e.approval.Nonce); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx,
			`UPDATE inbox SET status = 'done' WHERE user_id = ? AND status = 'pending' AND id <= ?`,
			user, throughID)
		return err
	})
}

func insertTimer(ctx context.Context, tx *sql.Tx, user string, t Timer) error {
	var interval any
	if t.Interval > 0 {
		interval = int64(t.Interval / time.Second)
	}
	_, err := tx.ExecContext(ctx,
		`INSERT INTO timers (user_id, due_at, note, interval_seconds, origin) VALUES (?, ?, ?, ?, ?)`,
		user, t.DueAt.Unix(), t.Note, interval, t.Origin)
	return err
}

// SeedTimer adds a timer unless the user already has one with the same note.
func (s *Store) SeedTimer(ctx context.Context, user string, t Timer) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM timers WHERE user_id = ? AND note = ?`, user, t.Note).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		return insertTimer(ctx, tx, user, t)
	})
}

func (s *Store) Timers(ctx context.Context, user string) ([]Timer, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, due_at, note, interval_seconds, origin FROM timers WHERE user_id = ? ORDER BY due_at, id`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var timers []Timer
	for rows.Next() {
		t := Timer{UserID: user}
		var due int64
		var interval sql.NullInt64
		if err := rows.Scan(&t.ID, &due, &t.Note, &interval, &t.Origin); err != nil {
			return nil, err
		}
		t.DueAt = time.Unix(due, 0)
		t.Interval = time.Duration(interval.Int64) * time.Second
		timers = append(timers, t)
	}
	return timers, rows.Err()
}

// FireTimers turns every due timer into an inbox event. One-offs are deleted;
// recurring timers advance to their next slot after now, so downtime produces
// one catch-up event rather than one per missed interval.
func (s *Store) FireTimers(ctx context.Context, now time.Time) (fired int, err error) {
	type due struct {
		id       int64
		user     string
		dueAt    int64
		note     string
		interval sql.NullInt64
		origin   string
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT id, user_id, due_at, note, interval_seconds, origin FROM timers WHERE due_at <= ? ORDER BY due_at, id`, now.Unix())
		if err != nil {
			return err
		}
		var dues []due
		for rows.Next() {
			var d due
			if err := rows.Scan(&d.id, &d.user, &d.dueAt, &d.note, &d.interval, &d.origin); err != nil {
				rows.Close()
				return err
			}
			dues = append(dues, d)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, d := range dues {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO inbox (user_id, source, payload, origin, created_at) VALUES (?, ?, ?, ?, ?)`,
				d.user, SourceTimer, d.note, d.origin, now.Unix()); err != nil {
				return err
			}
			if !d.interval.Valid {
				_, err = tx.ExecContext(ctx, `DELETE FROM timers WHERE id = ?`, d.id)
			} else {
				next := d.dueAt + d.interval.Int64*((now.Unix()-d.dueAt)/d.interval.Int64+1)
				_, err = tx.ExecContext(ctx, `UPDATE timers SET due_at = ? WHERE id = ?`, next, d.id)
			}
			if err != nil {
				return err
			}
		}
		fired = len(dues)
		return nil
	})
	return fired, err
}

func (s *Store) PendingApproval(ctx context.Context, user string) (*Approval, error) {
	var a Approval
	err := s.db.QueryRowContext(ctx,
		`SELECT id, transcript, tool_call, nonce FROM pending_approvals WHERE user_id = ?`, user).
		Scan(&a.ID, &a.Transcript, &a.ToolCall, &a.Nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// SaveApprovalProgress rewrites a parked transcript once its approved call has
// executed, so a retry of the resuming run does not execute it a second time.
func (s *Store) SaveApprovalProgress(ctx context.Context, id int64, transcript string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE pending_approvals SET transcript = ? WHERE id = ?`, transcript, id)
	return err
}

// DueOutbox returns, per user, the oldest pending entry if it is due and the
// user has not been sent anything within pace. Taking only the head of each
// user's queue keeps delivery in order across retries.
func (s *Store) DueOutbox(ctx context.Context, now time.Time, pace time.Duration) ([]Outbound, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT o.id, o.user_id, o.kind, o.address, o.body, o.options, o.attempts FROM outbox o
		 WHERE o.status = 'pending'
		   AND o.id = (SELECT MIN(id) FROM outbox WHERE user_id = o.user_id AND status = 'pending')
		   AND o.send_after <= ?
		   AND COALESCE((SELECT MAX(sent_at) FROM outbox WHERE user_id = o.user_id), 0) <= ?
		 ORDER BY o.id`,
		now.Unix(), now.Add(-pace).Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Outbound
	for rows.Next() {
		var m Outbound
		var options string
		if err := rows.Scan(&m.ID, &m.UserID, &m.Kind, &m.Address, &m.Body, &options, &m.Attempts); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(options), &m.Options); err != nil {
			return nil, fmt.Errorf("outbox %d options: %w", m.ID, err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MarkSent records a delivery and the address the adapter gave the result.
func (s *Store) MarkSent(ctx context.Context, id int64, remote string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE outbox SET status = 'sent', sent_at = ?, remote_id = ? WHERE id = ?`, now.Unix(), remote, id)
	return err
}

// MarkUnsent records a failed delivery: retry later, or give up after
// maxSendAttempts. It reports whether the entry was abandoned.
func (s *Store) MarkUnsent(ctx context.Context, m Outbound, now time.Time) (abandoned bool, err error) {
	attempts := m.Attempts + 1
	status := "pending"
	if attempts >= maxSendAttempts {
		status, abandoned = "failed", true
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE outbox SET status = ?, attempts = ?, send_after = ? WHERE id = ?`,
		status, attempts, now.Add(backoff(attempts)).Unix(), m.ID)
	return abandoned, err
}

// MarkFailed abandons an entry that can never be delivered.
func (s *Store) MarkFailed(ctx context.Context, m Outbound) error {
	_, err := s.db.ExecContext(ctx, `UPDATE outbox SET status = 'failed', attempts = ? WHERE id = ?`, m.Attempts+1, m.ID)
	return err
}

// SentBody returns the text of the message the agent delivered at remote, so
// an event that points at it (a reaction, say) can show what it is about.
func (s *Store) SentBody(ctx context.Context, user, remote string) (body string, found bool, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT body FROM outbox WHERE user_id = ? AND remote_id = ? AND kind = 'message' LIMIT 1`, user, remote).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return body, err == nil, err
}

// Recent returns the last limit messages exchanged with the user before event
// beforeID, oldest first, from every conversation: what the user said to the
// agent or within its hearing, and what the agent said. Every run is a fresh
// session; this is the continuity it would otherwise lack.
func (s *Store) Recent(ctx context.Context, user string, beforeID int64, limit int) ([]Exchange, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT at, who, text, place FROM (
		   SELECT created_at AS at, 0 AS turn, id, CASE sender WHEN '' THEN 'user' ELSE sender END AS who, payload AS text, origin AS place FROM inbox
		    WHERE user_id = ? AND source IN ('user', 'ambient') AND approval = '' AND id < ?
		   UNION ALL
		   SELECT created_at, 1, id, 'you', body, CASE remote_id WHEN '' THEN address ELSE remote_id END FROM outbox
		    WHERE user_id = ? AND kind = 'message'
		 ) ORDER BY at DESC, turn DESC, id DESC LIMIT ?`,
		user, beforeID, user, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var recent []Exchange
	for rows.Next() {
		var x Exchange
		var at int64
		if err := rows.Scan(&at, &x.From, &x.Text, &x.Where); err != nil {
			return nil, err
		}
		x.At = time.Unix(at, 0)
		recent = append(recent, x)
	}
	slices.Reverse(recent)
	return recent, rows.Err()
}

const (
	// taskWake is how soon an open task wakes the agent after its last
	// progress, unless the agent says otherwise.
	taskWake = 5 * time.Minute
	// maxTaskNotes bounds a task's notes; older lines are dropped first.
	maxTaskNotes = 8000
	maxOpenTasks = 20
)

// taskBackoff is the delay after a wake-up that found no progress: it doubles
// from taskWake to a day, so a stalled task costs little and is never forgotten.
func taskBackoff(idleWakes int) time.Duration {
	d := taskWake
	for i := 0; i < idleWakes && d < 24*time.Hour; i++ {
		d *= 2
	}
	return min(d, 24*time.Hour)
}

// OpenTask records work the agent has taken on. Opening a task whose title
// matches one already open returns that one: a retried run must not fork it.
func (s *Store) OpenTask(ctx context.Context, user, title, note, origin string, now time.Time) (id int64, existed bool, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT id FROM tasks WHERE user_id = ? AND state = 'open' AND title = ?`, user, title).Scan(&id)
		if err == nil {
			existed = true
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var open int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tasks WHERE user_id = ? AND state = 'open'`, user).Scan(&open); err != nil {
			return err
		}
		if open >= maxOpenTasks {
			return fmt.Errorf("limit of %d open tasks reached; close some first", maxOpenTasks)
		}
		res, err := tx.ExecContext(ctx,
			`INSERT INTO tasks (user_id, title, notes, origin, wake_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			user, title, taskNote("", note, now), origin, now.Add(taskWake).Unix(), now.Unix(), now.Unix())
		if err != nil {
			return err
		}
		id, err = res.LastInsertId()
		return err
	})
	return id, existed, err
}

// taskNote appends a dated line to a task's notes, dropping the oldest lines
// once the notes outgrow maxTaskNotes.
func taskNote(notes, note string, now time.Time) string {
	if note != "" {
		notes += fmt.Sprintf("[%s] %s\n", now.UTC().Format("2006-01-02 15:04Z"), note)
	}
	for len(notes) > maxTaskNotes {
		_, rest, ok := strings.Cut(notes, "\n")
		if !ok {
			return notes[len(notes)-maxTaskNotes:]
		}
		notes = rest
	}
	return notes
}

// UpdateTask records progress on an open task and sets when it next wakes the
// agent. state may be "open", "done" or "dropped".
func (s *Store) UpdateTask(ctx context.Context, user string, id int64, note, state string, wake time.Time, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var notes string
		err := tx.QueryRowContext(ctx, `SELECT notes FROM tasks WHERE id = ? AND user_id = ? AND state = 'open'`, id, user).Scan(&notes)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("no open task with id %d", id)
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx,
			`UPDATE tasks SET notes = ?, state = ?, wake_at = ?, idle_wakes = 0, updated_at = ? WHERE id = ?`,
			taskNote(notes, note, now), state, wake.Unix(), now.Unix(), id)
		return err
	})
}

// WakeTasks makes the given open tasks due at once. A run that is cut off
// uses it so the work continues without waiting out the wake interval.
func (s *Store) WakeTasks(ctx context.Context, user string, ids []int64, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, id := range ids {
			if _, err := tx.ExecContext(ctx, `UPDATE tasks SET wake_at = ? WHERE id = ? AND user_id = ? AND state = 'open'`, now.Unix(), id, user); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) OpenTasks(ctx context.Context, user string) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, title, notes, origin, wake_at, idle_wakes, created_at, updated_at FROM tasks
		 WHERE user_id = ? AND state = 'open' ORDER BY id`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tasks []Task
	for rows.Next() {
		var t Task
		var wake, created, updated int64
		if err := rows.Scan(&t.ID, &t.Title, &t.Notes, &t.Origin, &wake, &t.IdleWakes, &created, &updated); err != nil {
			return nil, err
		}
		t.WakeAt, t.CreatedAt, t.UpdatedAt = time.Unix(wake, 0), time.Unix(created, 0), time.Unix(updated, 0)
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

// FireTasks wakes the agent for every open task whose wake time has passed:
// one inbox event each, addressed to the conversation the task began in. The
// next wake is pushed out by taskBackoff until the agent records progress.
func (s *Store) FireTasks(ctx context.Context, now time.Time) (fired int, err error) {
	type due struct {
		id        int64
		user      string
		title     string
		origin    string
		idleWakes int
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT id, user_id, title, origin, idle_wakes FROM tasks WHERE state = 'open' AND wake_at <= ? ORDER BY wake_at, id`, now.Unix())
		if err != nil {
			return err
		}
		var dues []due
		for rows.Next() {
			var d due
			if err := rows.Scan(&d.id, &d.user, &d.title, &d.origin, &d.idleWakes); err != nil {
				rows.Close()
				return err
			}
			dues = append(dues, d)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, d := range dues {
			text := fmt.Sprintf("Task %d is still open: %s", d.id, d.title)
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO inbox (user_id, source, payload, origin, created_at) VALUES (?, ?, ?, ?, ?)`,
				d.user, SourceTask, text, d.origin, now.Unix()); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE tasks SET idle_wakes = idle_wakes + 1, wake_at = ? WHERE id = ?`,
				now.Add(taskBackoff(d.idleWakes+1)).Unix(), d.id); err != nil {
				return err
			}
		}
		fired = len(dues)
		return nil
	})
	return fired, err
}
