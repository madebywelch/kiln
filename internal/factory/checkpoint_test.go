package factory

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckpointEveryAttemptAndRetention(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t), Base: "main"}
	w.Nodes["work"] = Node{Type: "command", Command: "printf broken > file.txt; exit 7", Next: map[string]string{"success": "end", "failure": "repair"}}
	w.Nodes["repair"] = Node{Type: "command", Command: "printf repaired > file.txt", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	for i, a := range r.Attempts {
		if !a.Finalized || a.CheckpointSHA == "" {
			t.Fatalf("attempt lacks checkpoint: %+v", a)
		}
		parent, err := git(context.Background(), r.Workspace, "rev-parse", a.CheckpointSHA+"^")
		if err != nil {
			t.Fatal(err)
		}
		expected := r.BaseSHA
		if i > 0 {
			expected = r.Attempts[i-1].CheckpointSHA
		}
		if parent != expected {
			t.Fatal("broken audit chain")
		}
	}
	failed := r.Attempts[1]
	content, err := git(context.Background(), r.Workspace, "show", failed.CheckpointSHA+":file.txt")
	if err != nil || content != "broken" {
		t.Fatalf("failed changes not retained: %s %v", content, err)
	}
	waitRun(t, e, r.ID, func(r Run) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.active[r.ID] == nil })
	if _, err := e.Cleanup(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	ref := "refs/kiln/checkpoints/" + r.ID + "/" + failed.ID
	got, err := git(context.Background(), e.exec.repoDir(*w.Repository), "rev-parse", ref)
	if err != nil || got != failed.CheckpointSHA {
		t.Fatal("cleanup lost audit ref", err)
	}
}

func TestCheckpointCrashWindowDoesNotRepeatCommand(t *testing.T) {
	t.Parallel()
	for _, commitAlreadyWritten := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-git", true: "after-git"}[commitAlreadyWritten], func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			s, err := OpenStore(root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			x := &Executor{Root: root, AllowLocal: true}
			w := basicWorkflow()
			w.Repository = &Repository{Local: seedRepo(t)}
			w.Nodes["work"] = Node{Type: "command", Command: "printf repeated > repeated.txt", Next: map[string]string{"success": "end"}}
			r := makeRun(w, "rev", "", nil)
			r, err = x.Prepare(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			r.Prepared, r.Status, r.Current = true, "running", "work"
			r.Steps = 1
			r.Visits["work"] = 1
			finished := now()
			r.Attempts = []Attempt{{ID: newID(), Node: "work", StartedAt: finished, FinishedAt: &finished, Result: Result{Outcome: "success", Output: "already executed"}}}
			r.Outputs["work"] = r.Attempts[0].Result
			if err := os.WriteFile(filepath.Join(r.Workspace, "file.txt"), []byte("known result"), 0600); err != nil {
				t.Fatal(err)
			}
			var prior string
			if commitAlreadyWritten {
				prior, err = x.Checkpoint(context.Background(), r, r.Attempts[0])
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := s.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
				t.Fatal(err)
			}
			e, err := NewEngine(s, x, 1)
			if err != nil {
				t.Fatal(err)
			}
			e.Start()
			defer e.Close()
			r = waitRun(t, e, r.ID, settled)
			if r.Status != "succeeded" {
				t.Fatalf("%+v", r)
			}
			if len(r.Attempts) != 2 || r.Visits["work"] != 1 {
				t.Fatal("external operation repeated")
			}
			if _, err := os.Stat(filepath.Join(r.Workspace, "repeated.txt")); !os.IsNotExist(err) {
				t.Fatal("command reran after known completion")
			}
			if prior != "" && r.Attempts[0].CheckpointSHA != prior {
				t.Fatal("checkpoint duplicated after crash")
			}
		})
	}
}

func TestCheckpointRefusesBranchDriftAndReconciles(t *testing.T) {
	t.Parallel()
	x := Executor{Root: t.TempDir(), AllowLocal: true}
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t)}
	r, err := x.Prepare(context.Background(), makeRun(w, "rev", "", nil))
	if err != nil {
		t.Fatal(err)
	}
	finished := now()
	a := Attempt{ID: newID(), Node: "work", FinishedAt: &finished, Result: Result{Outcome: "failure"}}
	sha, err := x.Checkpoint(context.Background(), r, a)
	if err != nil {
		t.Fatal(err)
	}
	same, err := x.Checkpoint(context.Background(), r, a)
	if err != nil || sha != same {
		t.Fatal("not idempotent", err)
	}
	if err := os.WriteFile(filepath.Join(r.Workspace, "file.txt"), []byte("unknown side effect"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Checkpoint(context.Background(), r, a); err == nil || !strings.Contains(err.Error(), "changed after checkpoint") {
		t.Fatal("accepted post-checkpoint mutation", err)
	}
	if _, err := git(context.Background(), r.Workspace, "checkout", "--detach"); err != nil {
		t.Fatal(err)
	}
	a.ID = newID()
	if _, err := x.Checkpoint(context.Background(), r, a); err == nil {
		t.Fatal("checkpointed detached head")
	}
}

func TestCheckpointFailureRetryDoesNotReexecute(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t)}
	w.Nodes["work"] = Node{Type: "command", Command: "printf x >> file.txt; git checkout -b moved", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "interrupted" || !pendingAttempt(r) {
		t.Fatalf("%+v", r)
	}
	waitRun(t, e, r.ID, func(r Run) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.active[r.ID] == nil })
	if _, err := git(context.Background(), r.Workspace, "checkout", r.Branch); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Retry(r.ID); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" || r.Visits["work"] != 1 {
		t.Fatalf("%+v", r)
	}
	b, err := os.ReadFile(filepath.Join(r.Workspace, "file.txt"))
	if err != nil || string(b) != "original\nx" {
		t.Fatalf("stage repeated: %q %v", b, err)
	}
}
func TestRejectLegacyDatabase(t *testing.T) {
	t.Parallel()
	for _, version := range []int{1, 2} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			dir := t.TempDir()
			s, err := OpenStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.Exec("UPDATE meta SET version=?", version); err != nil {
				t.Fatal(err)
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			if s, err := OpenStore(dir); err == nil {
				s.Close()
				t.Fatal("accepted legacy schema")
			}
		})
	}
}
