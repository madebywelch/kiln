package factory

import (
	"errors"
	"testing"
	"time"
)

func TestAutomationPinningDedupAndOverlap(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "human", Prompt: "continue?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "end", "no": "end"}}
	original, err := e.Register(workflowYAML(t, w), "")
	if err != nil {
		t.Fatal(err)
	}
	a, err := e.PutAutomation("nightly", AutomationRequest{WorkflowID: w.Name, Event: "nightly", Enabled: true, Inputs: map[string]string{"source": "automation"}})
	if err != nil {
		t.Fatal(err)
	}
	w.Description = "new revision"
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	triggered, err := e.Trigger(TriggerRequest{Name: "nightly", Inputs: map[string]string{"source": "event"}}, "delivery")
	if err != nil || len(triggered.RunIDs) != 1 {
		t.Fatalf("%+v %v", triggered, err)
	}
	repeated, err := e.Trigger(TriggerRequest{Name: "nightly", Inputs: map[string]string{"source": "event"}}, "delivery")
	if err != nil || repeated.RunIDs[0] != triggered.RunIDs[0] {
		t.Fatal("event replay created another run")
	}
	r := waitRun(t, e, triggered.RunIDs[0], settled)
	if r.Revision != a.Revision || r.Revision != original.Revision || r.Inputs["source"] != "event" {
		t.Fatalf("wrong pinned run: %+v", r)
	}
	skipped, err := e.Trigger(TriggerRequest{Name: "nightly"}, "other")
	if err != nil || len(skipped.RunIDs) != 0 || len(skipped.Skipped) != 1 {
		t.Fatal("overlap not skipped")
	}
	if _, err := e.Fire(a.ID, "manual"); !errors.Is(err, ErrConflict) {
		t.Fatalf("overlap allowed: %v", err)
	}
	if _, err := e.Cancel(r.ID); err != nil {
		t.Fatal(err)
	}
	fired, err := e.Fire(a.ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := e.Fire(a.ID, "manual")
	if err != nil || repeat.ID != fired.ID {
		t.Fatal("manual fire is not idempotent")
	}
	if _, err := e.PutAutomation("nightly", AutomationRequest{WorkflowID: w.Name, Event: "nightly", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Fire(a.ID, ""); !errors.Is(err, ErrConflict) {
		t.Fatal("disabled automation fired")
	}
}
func TestCronCursorAtomicityAndCoalescing(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	a, err := e.PutAutomation("cron", AutomationRequest{WorkflowID: w.Name, Schedule: "*/5 * * * *", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 9, 12, 31, 0, 0, time.UTC)
	due := at.Add(-24 * time.Hour)
	a.NextAt = &due
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.store.commit([]change{{"automation", a.ID, a}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.schedule(at); err != nil {
		t.Fatal(err)
	}
	updated, err := get[Automation](e.store, "automation", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.NextAt.Equal(time.Date(2026, 10, 9, 12, 35, 0, 0, time.UTC)) {
		t.Fatalf("bad cursor: %v", updated.NextAt)
	}
	if err := e.schedule(at); err != nil {
		t.Fatal(err)
	}
	runs, err := list[Run](e.store, "run", "", 100, 0)
	if err != nil || len(runs) != 1 {
		t.Fatalf("missed ticks did not coalesce: %d %v", len(runs), err)
	}
	// Even a later due tick must skip the existing queued run.
	if err := e.schedule(at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	runs, err = list[Run](e.store, "run", "", 100, 0)
	if err != nil || len(runs) != 1 {
		t.Fatal("cron overlap")
	}
}
func TestInvalidAutomationDefinitions(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	for _, req := range []AutomationRequest{
		{WorkflowID: "x"},
		{WorkflowID: "x", Event: "x", Schedule: "* * * * *"},
		{WorkflowID: "x", Schedule: "@every 1s"},
		{WorkflowID: "x", Schedule: "0 0 31 2 *"},
		{WorkflowID: "x", Event: "github.push"},
		{WorkflowID: "x", Event: "custom", GitHubRepository: "a/b"},
	} {
		if _, err := e.PutAutomation("invalid", req); err == nil {
			t.Fatalf("accepted %+v", req)
		}
	}
}
