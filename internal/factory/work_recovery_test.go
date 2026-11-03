package factory

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkAndHandoffSurviveInterruptedWorkerRestart(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	x := &Executor{Root: root}
	e, err := NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	work := createTestWork(t, e)
	handoff := WorkHandoff{Progress: "Accepted design", FailedApproaches: "Earlier approach was rejected", NextAction: "Finish verification"}
	work, err = e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: handoff})
	if err != nil {
		t.Fatal(err)
	}
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "durable-claim")
	if err != nil {
		t.Fatal(err)
	}
	r, err = x.Prepare(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	r.Prepared, r.Status, r.Current = true, "running", "work"
	r.Attempts = []Attempt{{ID: newID(), Node: "work", StartedAt: now(), Result: Result{Outcome: "running"}}}
	if err := e.saveRun(r, "node.started", r.Attempts[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, err = NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	defer e.Close()
	work, err = e.GetWork(work.ID)
	if err != nil || work.Handoff != handoff || work.Status != "open" || work.LatestRunID != r.ID {
		t.Fatalf("restart lost the durable obligation: %+v %v", work, err)
	}
	recovered, err := e.GetRun(r.ID)
	if err != nil || recovered.Status != "interrupted" || !reflect.DeepEqual(recovered.Work, r.Work) {
		t.Fatalf("restart lost pinned worker context: %+v %v", recovered, err)
	}
	if _, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "replacement"); !errors.Is(err, ErrConflict) {
		t.Fatal("restart allowed a replacement to bypass an uncertain outcome", err)
	}
	if _, err := e.Retry(r.ID); err != nil {
		t.Fatal(err)
	}
	recovered = waitWorkRun(t, e, r.ID)
	if recovered.Status != "succeeded" {
		t.Fatal(recovered.Status)
	}
	work, _ = e.GetWork(work.ID)
	if work.Status != "open" {
		t.Fatal("worker success incorrectly completed the obligation")
	}
}

func TestWorkSchemaMigrationPreservesExistingState(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	r := makeRun(basicWorkflow(), "legacy-revision", "", map[string]string{"goal": "retained"})
	if err := s.commit([]change{{"run", r.ID, r}}, []eventWrite{{r.ID, "run.created", r.ID}}, &dedupWrite{"legacy-key", "fingerprint", r.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE meta SET version=3; DROP INDEX runs_work_created;"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var version int
	if err := s.db.QueryRow("SELECT version FROM meta").Scan(&version); err != nil || version != 4 {
		t.Fatalf("migration did not mark the new state format: %d %v", version, err)
	}
	got, err := get[Run](s, "run", r.ID)
	if err != nil || got.Inputs["goal"] != "retained" || got.Revision != r.Revision || got.Work != nil || got.WorkID != "" {
		t.Fatalf("legacy run was changed: %+v %v", got, err)
	}
	events, err := s.Events(r.ID, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatal("migration lost events", err)
	}
	var id string
	if found, err := s.duplicate("legacy-key", "fingerprint", &id); err != nil || !found || id != r.ID {
		t.Fatal("migration lost idempotency", err)
	}
}

func TestWorkSchemaMigrationRollsBackOnFailure(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE meta SET version=3; DROP INDEX runs_work_created; CREATE TRIGGER reject_migration BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'migration fault'); END"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := OpenStore(root); err == nil {
		reopened.Close()
		t.Fatal("migration ignored its transaction failure")
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version, indexes int
	if err := db.QueryRow("SELECT version FROM meta").Scan(&version); err != nil || version != 3 {
		t.Fatalf("failed migration changed the schema version: %d %v", version, err)
	}
	if err := db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE name='runs_work_created'").Scan(&indexes); err != nil || indexes != 0 {
		t.Fatalf("failed migration retained partial DDL: %d %v", indexes, err)
	}
	if _, err := db.Exec("DROP TRIGGER reject_migration"); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal("migration retry failed or leaked its lock", err)
	}
	reopened.Close()
}
