package agent

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var ctx = context.Background()

func TestBackoffSchedule(t *testing.T) {
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 16 * time.Minute, 32 * time.Minute, time.Hour, time.Hour}
	for i, w := range want {
		if got := backoff(i + 1); got != w {
			t.Errorf("backoff(%d) = %s, want %s", i+1, got, w)
		}
	}
}

func TestClaimBatchTakesEveryPendingEventInOrder(t *testing.T) {
	s := newStore(t)
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "one"}, t0)
	s.AddEvent(ctx, Inbound{User: "bob", Source: SourceUser, Text: "other user"}, t0)
	s.AddEvent(ctx, Inbound{User: "ann", Source: "github", Text: "two"}, t0)

	events, dead, err := s.ClaimBatch(ctx, "ann", t0)
	if err != nil || dead != 0 {
		t.Fatalf("claim: dead=%d err=%v", dead, err)
	}
	if len(events) != 2 || events[0].Payload != "one" || events[1].Payload != "two" || events[1].Source != "github" {
		t.Fatalf("batch = %+v", events)
	}
	if events[0].Attempts != 1 {
		t.Fatalf("attempt not counted at claim: %d", events[0].Attempts)
	}
	equal(t, "bob untouched", queryStrings(t, s, `SELECT attempts FROM inbox WHERE user_id = 'bob'`), []string{"0"})
}

func TestCommitIsAllOrNothing(t *testing.T) {
	s := newStore(t)
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "hi"}, t0)
	events, _, _ := s.ClaimBatch(ctx, "ann", t0)
	first := effects{approval: &Approval{Transcript: "[]", ToolCall: "{}"}}
	if err := s.Commit(ctx, "ann", events[0].ID, first, t0); err != nil {
		t.Fatal(err)
	}

	// A second approval for the same user violates the schema, which must
	// take the whole commit down with it.
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "again"}, t0)
	events, _, _ = s.ClaimBatch(ctx, "ann", t0)
	bad := effects{
		out:      []Outbound{{Kind: KindMessage, Body: "must not be sent"}},
		timers:   []Timer{{DueAt: t0.Add(time.Hour), Note: "must not exist"}},
		approval: &Approval{Transcript: "[]", ToolCall: "{}"},
	}
	if err := s.Commit(ctx, "ann", events[0].ID, bad, t0); err == nil {
		t.Fatal("commit with a second approval succeeded")
	}
	equal(t, "outbox", queryStrings(t, s, `SELECT body FROM outbox`), nil)
	equal(t, "timers", queryStrings(t, s, `SELECT note FROM timers`), nil)
	equal(t, "inbox", queryStrings(t, s, `SELECT status FROM inbox ORDER BY id`), []string{"done", "pending"})
}

func TestCommitScopesCancelsAndResolutionToTheUser(t *testing.T) {
	s := newStore(t)
	s.SeedTimer(ctx, "bob", Timer{DueAt: t0.Add(time.Hour), Note: "bob's"})
	if _, err := s.db.Exec(`INSERT INTO pending_approvals (user_id, transcript, tool_call) VALUES ('bob', '[]', '{}')`); err != nil {
		t.Fatal(err)
	}
	var timerID, approvalID int64
	s.db.QueryRow(`SELECT id FROM timers`).Scan(&timerID)
	s.db.QueryRow(`SELECT id FROM pending_approvals`).Scan(&approvalID)

	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "hi"}, t0)
	events, _, _ := s.ClaimBatch(ctx, "ann", t0)
	if err := s.Commit(ctx, "ann", events[0].ID, effects{cancels: []int64{timerID}, resolved: approvalID}, t0); err != nil {
		t.Fatal(err)
	}
	equal(t, "bob's timer survives ann's cancel", queryStrings(t, s, `SELECT note FROM timers`), []string{"bob's"})
	equal(t, "bob's approval survives ann's run", queryStrings(t, s, `SELECT user_id FROM pending_approvals`), []string{"bob"})
}

func TestFailedBatchBacksOffUntilDueOrANewEventArrives(t *testing.T) {
	s := newStore(t)
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "one"}, t0)
	events, _, _ := s.ClaimBatch(ctx, "ann", t0)
	if err := s.Backoff(ctx, "ann", events[0].ID, t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if users, _ := s.RunnableUsers(ctx, t0.Add(30*time.Second)); len(users) != 0 {
		t.Fatalf("user runnable during backoff: %v", users)
	}
	if users, _ := s.RunnableUsers(ctx, t0.Add(time.Minute)); len(users) != 1 {
		t.Fatalf("user not runnable after backoff: %v", users)
	}

	// A new event makes the user runnable at once, and the batch still
	// carries the older event first.
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "two"}, t0.Add(10*time.Second))
	if users, _ := s.RunnableUsers(ctx, t0.Add(10*time.Second)); len(users) != 1 {
		t.Fatalf("new event did not make user runnable: %v", users)
	}
	events, _, _ = s.ClaimBatch(ctx, "ann", t0)
	if len(events) != 2 || events[0].Payload != "one" || events[0].Attempts != 2 || events[1].Attempts != 1 {
		t.Fatalf("batch = %+v", events)
	}
}

func TestEventOutOfAttemptsIsDeadLetteredAndReported(t *testing.T) {
	s := newStore(t)
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "poison"}, t0)
	for i := 0; i < maxRunAttempts; i++ {
		events, dead, err := s.ClaimBatch(ctx, "ann", t0)
		if err != nil || dead != 0 || len(events) != 1 {
			t.Fatalf("claim %d: events=%d dead=%d err=%v", i, len(events), dead, err)
		}
	}
	s.AddEvent(ctx, Inbound{User: "ann", Source: SourceUser, Text: "fresh"}, t0)
	events, dead, err := s.ClaimBatch(ctx, "ann", t0)
	if err != nil || dead != 1 {
		t.Fatalf("dead=%d err=%v", dead, err)
	}
	if len(events) != 1 || events[0].Payload != "fresh" {
		t.Fatalf("batch after dead-letter = %+v", events)
	}
	equal(t, "statuses", queryStrings(t, s, `SELECT status FROM inbox ORDER BY id`), []string{"failed", "pending"})
	if notices := queryStrings(t, s, `SELECT body FROM outbox`); len(notices) != 1 {
		t.Fatalf("want one dead-letter notice, got %q", notices)
	}
}

func TestFireTimers(t *testing.T) {
	s := newStore(t)
	s.SeedTimer(ctx, "ann", Timer{DueAt: t0.Add(time.Minute), Note: "one-off"})
	s.SeedTimer(ctx, "ann", Timer{DueAt: t0.Add(time.Minute), Note: "hourly", Interval: time.Hour})
	s.SeedTimer(ctx, "ann", Timer{DueAt: t0.Add(24 * time.Hour), Note: "not yet"})

	if fired, err := s.FireTimers(ctx, t0); err != nil || fired != 0 {
		t.Fatalf("fired early: %d %v", fired, err)
	}

	// The process was down for 3h10m past the due time. Each due timer fires
	// once, and the recurring one lands on its next future slot.
	now := t0.Add(time.Minute + 3*time.Hour + 10*time.Minute)
	fired, err := s.FireTimers(ctx, now)
	if err != nil || fired != 2 {
		t.Fatalf("fired=%d err=%v", fired, err)
	}
	equal(t, "inbox", queryStrings(t, s, `SELECT source || ':' || payload FROM inbox ORDER BY id`), []string{"timer:one-off", "timer:hourly"})
	timers, _ := s.Timers(ctx, "ann")
	if len(timers) != 2 || timers[0].Note != "hourly" || !timers[0].DueAt.Equal(t0.Add(time.Minute+4*time.Hour)) || timers[0].Interval != time.Hour {
		t.Fatalf("timers after firing = %+v", timers)
	}
	if fired, _ := s.FireTimers(ctx, now); fired != 0 {
		t.Fatalf("timers fired twice: %d", fired)
	}
}

func TestSeedTimerIsIdempotent(t *testing.T) {
	s := newStore(t)
	for i := 0; i < 2; i++ {
		if err := s.SeedTimer(ctx, "ann", Timer{DueAt: t0, Note: "dream", Interval: time.Hour}); err != nil {
			t.Fatal(err)
		}
	}
	equal(t, "timers", queryStrings(t, s, `SELECT note FROM timers`), []string{"dream"})
}

func TestOutboxDeliversInOrderWithPacingAndRetry(t *testing.T) {
	s := newStore(t)
	for _, row := range [][2]string{{"ann", "a1"}, {"ann", "a2"}, {"bob", "b1"}} {
		if _, err := s.db.Exec(`INSERT INTO outbox (user_id, body) VALUES (?, ?)`, row[0], row[1]); err != nil {
			t.Fatal(err)
		}
	}
	pace := 10 * time.Second
	bodies := func(now time.Time) []string {
		t.Helper()
		msgs, err := s.DueOutbox(ctx, now, pace)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, m := range msgs {
			out = append(out, m.Body)
		}
		return out
	}
	due := func(now time.Time, body string) Outbound {
		t.Helper()
		msgs, _ := s.DueOutbox(ctx, now, pace)
		for _, m := range msgs {
			if m.Body == body {
				return m
			}
		}
		t.Fatalf("%s not due at %s", body, now)
		return Outbound{}
	}

	// Only the head of each user's queue is offered.
	equal(t, "initial", bodies(t0), []string{"a1", "b1"})

	// a1 fails: ann's queue is blocked behind it, so a2 cannot overtake.
	if abandoned, err := s.MarkUnsent(ctx, due(t0, "a1"), t0); err != nil || abandoned {
		t.Fatalf("abandoned=%v err=%v", abandoned, err)
	}
	s.MarkSent(ctx, due(t0, "b1").ID, "", t0)
	equal(t, "during a1 backoff", bodies(t0.Add(10*time.Second)), nil)

	// After the backoff a1 is offered again; once sent, a2 waits out the pace.
	at := t0.Add(30 * time.Second)
	equal(t, "after backoff", bodies(at), []string{"a1"})
	s.MarkSent(ctx, due(at, "a1").ID, "", at)
	equal(t, "inside pace", bodies(at.Add(5*time.Second)), nil)
	equal(t, "after pace", bodies(at.Add(10*time.Second)), []string{"a2"})
}

func TestOutboxGivesUpAfterMaxAttempts(t *testing.T) {
	s := newStore(t)
	s.db.Exec(`INSERT INTO outbox (user_id, body) VALUES ('ann', 'undeliverable'), ('ann', 'next')`)
	now := t0
	for i := 1; i <= maxSendAttempts; i++ {
		msgs, err := s.DueOutbox(ctx, now, 0)
		if err != nil || len(msgs) != 1 || msgs[0].Body != "undeliverable" {
			t.Fatalf("attempt %d: %+v %v", i, msgs, err)
		}
		abandoned, err := s.MarkUnsent(ctx, msgs[0], now)
		if err != nil || abandoned != (i == maxSendAttempts) {
			t.Fatalf("attempt %d: abandoned=%v err=%v", i, abandoned, err)
		}
		now = now.Add(time.Hour)
	}
	// The abandoned message no longer blocks the queue.
	msgs, _ := s.DueOutbox(ctx, now, 0)
	if len(msgs) != 1 || msgs[0].Body != "next" {
		t.Fatalf("queue after abandon = %+v", msgs)
	}
	equal(t, "statuses", queryStrings(t, s, `SELECT status FROM outbox ORDER BY id`), []string{"failed", "pending"})
}

func TestMigrationUpgradesAnExistingDatabaseInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiln.db")
	// A database written by the first schema, before adapters existed.
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(schemaV1 + `
		INSERT INTO inbox (user_id, source, payload, created_at) VALUES ('ann', 'user', 'old event', 1);
		INSERT INTO outbox (user_id, body) VALUES ('ann', 'old message');
		INSERT INTO pending_approvals (user_id, transcript, tool_call) VALUES ('ann', '[]', '{}');`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	for pass := 0; pass < 2; pass++ { // the second open must find nothing to do
		s, err := OpenStore(path)
		if err != nil {
			t.Fatalf("open %d: %v", pass, err)
		}
		equal(t, "schema version", queryStrings(t, s, `PRAGMA user_version`), []string{fmt.Sprint(len(migrations))})
		equal(t, "old event", queryStrings(t, s, `SELECT payload || '|' || origin || '|' || approval || '|' || sender || '|' || COALESCE(dedupe, 'null') FROM inbox`), []string{"old event||||null"})
		equal(t, "old message", queryStrings(t, s, `SELECT body || '|' || kind || '|' || address || '|' || options FROM outbox`), []string{"old message|message||{}"})
		due, err := s.DueOutbox(ctx, t0, 0)
		if err != nil || len(due) != 1 || due[0].Kind != KindMessage {
			t.Fatalf("old message not deliverable: %+v %v", due, err)
		}
		if a, err := s.PendingApproval(ctx, "ann"); err != nil || a == nil || a.Nonce != "" {
			t.Fatalf("old approval: %+v %v", a, err)
		}
		s.Close()
	}

	newer, _ := sql.Open("sqlite", "file:"+path)
	newer.Exec(`PRAGMA user_version = 99`)
	newer.Close()
	if _, err := OpenStore(path); err == nil || !strings.Contains(err.Error(), "newer kiln") {
		t.Fatalf("a database from a newer kiln must be refused, got %v", err)
	}
}

func TestTaskWakeUpsBackOffUntilProgress(t *testing.T) {
	s := newStore(t)
	id, existed, err := s.OpenTask(ctx, "ann", "Migrate the database", "Plan: dump, restore, verify.", "chat:ops:m1", t0)
	if err != nil || existed || id != 1 {
		t.Fatalf("open: id=%d existed=%v err=%v", id, existed, err)
	}
	if again, existed, _ := s.OpenTask(ctx, "ann", "Migrate the database", "second plan", "", t0); again != id || !existed {
		t.Fatalf("reopening by title: id=%d existed=%v", again, existed)
	}
	if other, existed, _ := s.OpenTask(ctx, "bob", "Migrate the database", "", "", t0); other == id || existed {
		t.Fatalf("another user's task with the same title collided: id=%d existed=%v", other, existed)
	}

	// Not due before its first wake time.
	if fired, _ := s.FireTasks(ctx, t0.Add(taskWake-time.Second)); fired != 0 {
		t.Fatalf("fired early: %d", fired)
	}
	// Each wake-up that finds no progress doubles the wait: 10m, 20m, 40m...
	now := t0.Add(taskWake)
	for _, wait := range []time.Duration{10 * time.Minute, 20 * time.Minute, 40 * time.Minute} {
		fired, err := s.FireTasks(ctx, now)
		if err != nil || fired != 2 { // ann's and bob's
			t.Fatalf("at %s: fired=%d err=%v", now, fired, err)
		}
		if fired, _ := s.FireTasks(ctx, now.Add(wait-time.Second)); fired != 0 {
			t.Fatalf("fired again before %s had passed", wait)
		}
		now = now.Add(wait)
	}
	equal(t, "wake-up events", queryStrings(t, s, `SELECT source || '|' || origin || '|' || payload FROM inbox WHERE user_id = 'ann'`), []string{
		"task|chat:ops:m1|Task 1 is still open: Migrate the database",
		"task|chat:ops:m1|Task 1 is still open: Migrate the database",
		"task|chat:ops:m1|Task 1 is still open: Migrate the database",
	})

	// Progress resets the backoff and sets the next wake.
	if err := s.UpdateTask(ctx, "ann", id, "Dump finished.", "open", now.Add(time.Hour), now); err != nil {
		t.Fatal(err)
	}
	tasks, _ := s.OpenTasks(ctx, "ann")
	if len(tasks) != 1 || tasks[0].IdleWakes != 0 || !tasks[0].WakeAt.Equal(now.Add(time.Hour)) || !strings.Contains(tasks[0].Notes, "Plan: dump") || !strings.Contains(tasks[0].Notes, "Dump finished.") {
		t.Fatalf("task after progress = %+v", tasks)
	}

	// A user cannot touch another user's task, and a closed task cannot be updated.
	if err := s.UpdateTask(ctx, "bob", id, "hijack", "done", now, now); err == nil {
		t.Fatal("bob updated ann's task")
	}
	if err := s.UpdateTask(ctx, "ann", id, "Verified.", "done", now, now); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(ctx, "ann", id, "more", "open", now, now); err == nil {
		t.Fatal("a closed task was reopened")
	}
	if tasks, _ := s.OpenTasks(ctx, "ann"); len(tasks) != 0 {
		t.Fatalf("closed task still listed: %+v", tasks)
	}
}

func TestTaskLimitsAndNoteTrimming(t *testing.T) {
	s := newStore(t)
	for i := 0; i < maxOpenTasks; i++ {
		if _, _, err := s.OpenTask(ctx, "ann", fmt.Sprintf("task %d", i), "", "", t0); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.OpenTask(ctx, "ann", "one too many", "", "", t0); err == nil {
		t.Fatal("open-task limit not enforced")
	}
	for i := 0; i < 40; i++ {
		if err := s.UpdateTask(ctx, "ann", 1, fmt.Sprintf("step %02d %s", i, strings.Repeat("x", 300)), "open", t0, t0); err != nil {
			t.Fatal(err)
		}
	}
	notes := queryStrings(t, s, `SELECT notes FROM tasks WHERE id = 1`)[0]
	if len(notes) > maxTaskNotes || !strings.Contains(notes, "step 39") || strings.Contains(notes, "step 00") || !strings.HasPrefix(notes, "[") {
		t.Fatalf("notes not trimmed from the oldest end on a line boundary: %d bytes, starts %q", len(notes), notes[:40])
	}
	if got := taskBackoff(50); got != 24*time.Hour {
		t.Fatalf("backoff is not capped at a day: %s", got)
	}
}
