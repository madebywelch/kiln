package factory

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testEngine(t *testing.T, configure func(*Executor)) *Engine {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	x := &Executor{Root: dir, AllowLocal: true}
	if configure != nil {
		configure(x)
	}
	e, err := NewEngine(store, x, 4)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	t.Cleanup(func() {
		e.Close()
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	return e
}
func submitWorkflow(t *testing.T, e *Engine, w Workflow) Run {
	t.Helper()
	record, err := e.Register(workflowYAML(t, w), "")
	if err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: record.ID}, "")
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func waitRun(t *testing.T, e *Engine, id string, condition func(Run) bool) Run {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		r, err := e.GetRun(id)
		if err != nil {
			t.Fatal(err)
		}
		if condition(r) {
			return r
		}
		time.Sleep(10 * time.Millisecond)
	}
	r, _ := e.GetRun(id)
	t.Fatalf("run did not reach expected state: status=%s current=%s error=%s attempts=%+v", r.Status, r.Current, r.Error, r.Attempts)
	return Run{}
}
func settled(r Run) bool { return r.Terminal() || r.Status == "waiting" || r.Status == "interrupted" }

func TestFailureRoutesThroughRepairAndHumanGate(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "command", Command: "test -f fixed || { echo broken; exit 7; }; echo passed", MaxVisits: 3, Next: map[string]string{"success": "review", "failure": "repair"}}
	w.Nodes["repair"] = Node{Type: "command", Command: "touch fixed", Next: map[string]string{"success": "work"}}
	w.Nodes["review"] = Node{Type: "human", Prompt: "Build: {{ .outputs.work.output }}", Choices: []string{"approve", "revise"}, Next: map[string]string{"approve": "end", "revise": "repair"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "waiting" || r.Visits["work"] != 2 || r.Outputs["work"].Outcome != "success" {
		t.Fatalf("wrong run: %+v", r)
	}
	if r.Attempts[1].Result.ExitCode != 7 {
		t.Fatalf("missing failure evidence: %+v", r.Attempts)
	}
	question := r.Question.ID
	if _, err := e.Decide(r.ID, Decision{QuestionID: "stale", Choice: "approve"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale answer accepted: %v", err)
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: question, Choice: "bad"}); err == nil {
		t.Fatal("invalid choice accepted")
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: question, Choice: "approve", Comment: "reviewed"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: question, Choice: "approve"}); !errors.Is(err, ErrConflict) {
		t.Fatal("duplicate answer accepted")
	}
	r = waitRun(t, e, r.ID, func(r Run) bool { return r.Terminal() })
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	events, err := e.store.Events(r.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(events); i++ {
		if events[i].ID <= events[i-1].ID {
			t.Fatal("events not ordered")
		}
	}
	tail, err := e.store.Events(r.ID, events[2].ID, 100)
	if err != nil || len(tail) != len(events)-3 {
		t.Fatalf("bad replay: %v", err)
	}
}
func TestBudgetsAndTimeout(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, command, timeout string
		visits, steps          int
	}{
		{"node budget", "exit 1", "", 2, 30},
		{"run budget", "exit 1", "", 0, 4},
		{"timeout", "sleep 10", "30ms", 1, 30},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := testEngine(t, nil)
			w := basicWorkflow()
			w.MaxSteps = tc.steps
			w.Nodes["work"] = Node{Type: "command", Command: tc.command, Timeout: tc.timeout, MaxVisits: tc.visits, Next: map[string]string{"success": "end", "failure": "work"}}
			r := submitWorkflow(t, e, w)
			r = waitRun(t, e, r.ID, settled)
			if r.Status != "failed" || r.Error != "execution budget exhausted" {
				t.Fatalf("%+v", r)
			}
			if tc.timeout != "" && !strings.Contains(r.Attempts[1].Result.Error, "deadline") {
				t.Fatalf("%+v", r.Attempts)
			}
		})
	}
}
func TestCancellationKillsProcessGroup(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "command", Command: "touch started; (sleep 2; touch escaped) & wait", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, func(r Run) bool {
		_, err := os.Stat(filepath.Join(r.Workspace, "started"))
		return r.Prepared && err == nil
	})
	if _, err := e.Cancel(r.ID); err != nil {
		t.Fatal(err)
	}
	waitRun(t, e, r.ID, func(r Run) bool { return len(r.Attempts) > 1 && r.Attempts[1].FinishedAt != nil })
	time.Sleep(2100 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(r.Workspace, "escaped")); !os.IsNotExist(err) {
		t.Fatalf("child escaped cancellation: %v", err)
	}
}
func TestIdempotencyAndPinnedWorkflow(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	record, err := e.Register(workflowYAML(t, w), "")
	if err != nil {
		t.Fatal(err)
	}
	req := SubmitRequest{WorkflowID: w.Name, Inputs: map[string]string{"goal": "one"}}
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := e.Submit(req, "same")
			if err != nil {
				t.Error(err)
			}
			ids <- r.ID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for got := range ids {
		if id != "" && id != got {
			t.Fatal("duplicate runs")
		}
		id = got
	}
	req.Inputs["goal"] = "two"
	if _, err := e.Submit(req, "same"); !errors.Is(err, ErrConflict) {
		t.Fatal("key reuse accepted")
	}
	n := w.Nodes["work"]
	n.Command = "printf changed"
	w.Nodes["work"] = n
	if _, err := e.Register(workflowYAML(t, w), "incorrect"); !errors.Is(err, ErrConflict) {
		t.Fatal("revision conflict ignored")
	}
	if _, err := e.Register(workflowYAML(t, w), record.Revision); err != nil {
		t.Fatal(err)
	}
	r := waitRun(t, e, id, settled)
	if r.Revision != record.Revision || r.Outputs["work"].Output != "done" {
		t.Fatalf("run definition changed: %+v", r)
	}
}
func TestRecoveryPreservesQuestionAndInterruptsRunning(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	e, err := NewEngine(s, &Executor{Root: dir}, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "human", Prompt: "Approve?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "end", "no": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	question := r.Question.ID
	e.Close()
	interrupted := makeRun(basicWorkflow(), "rev", "", nil)
	interrupted.Status = "running"
	if err := s.commit([]change{{"run", interrupted.ID, interrupted}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, err = NewEngine(s, &Executor{Root: dir}, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	defer e.Close()
	got, err := e.GetRun(interrupted.ID)
	if err != nil || got.Status != "interrupted" {
		t.Fatalf("%+v %v", got, err)
	}
	got, _ = e.GetRun(r.ID)
	if got.Question.ID != question || got.Status != "waiting" {
		t.Fatal("lost question")
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: question, Choice: "yes"}); err != nil {
		t.Fatal(err)
	}
	if r = waitRun(t, e, r.ID, settled); r.Status != "succeeded" {
		t.Fatal(r.Status)
	}
	if _, err := e.Retry(interrupted.ID); err != nil {
		t.Fatal(err)
	}
	if r = waitRun(t, e, interrupted.ID, settled); r.Status != "succeeded" {
		t.Fatal(r.Status)
	}
}
func TestStoreExclusiveLockAndAtomicity(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if second, err := OpenStore(dir); err == nil {
		second.Close()
		t.Fatal("second daemon acquired lock")
	}
	if err := s.commit(nil, nil, &dedupWrite{"key", "fp", "id"}); err != nil {
		t.Fatal(err)
	}
	err = s.commit([]change{{"run", "rolled-back", basicWorkflow()}}, []eventWrite{{"rolled-back", "bad", "bad"}}, &dedupWrite{"key", "fp", "id"})
	if err == nil {
		t.Fatal("duplicate dedup key accepted")
	}
	if _, err := get[Workflow](s, "run", "rolled-back"); !errors.Is(err, ErrNotFound) {
		t.Fatal("partial transaction committed")
	}
	events, err := s.Events("rolled-back", 0, 10)
	if err != nil || len(events) != 0 {
		t.Fatal("event escaped rollback")
	}
}
func TestCommandInputsAreNotShellSource(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	n := w.Nodes["work"]
	n.Command = "printf '%s' \"$GOAL\""
	n.Env = map[string]string{"GOAL": "{{ .inputs.goal }}"}
	w.Nodes["work"] = n
	w.Inputs = map[string]string{"goal": "$(touch INJECTED); `echo nope`"}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Outputs["work"].Output != w.Inputs["goal"] {
		t.Fatal("input was evaluated")
	}
	if _, err := os.Stat(filepath.Join(r.Workspace, "INJECTED")); !os.IsNotExist(err) {
		t.Fatal("shell injection")
	}
}
func TestCleanupRetainsHistory(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	r := submitWorkflow(t, e, basicWorkflow())
	r = waitRun(t, e, r.ID, settled)
	deadline := time.Now().Add(time.Second)
	for {
		_, err := e.Cleanup(context.Background(), r.ID)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stat(r.Workspace); !os.IsNotExist(err) {
		t.Fatal("workspace not removed")
	}
	r, _ = e.GetRun(r.ID)
	if !r.Cleaned || len(r.Attempts) == 0 {
		t.Fatal("history was lost")
	}
	if _, err := e.Retry(r.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("cleaned run retried")
	}
}
