package factory

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func testWorkRequest() CreateWorkRequest {
	return CreateWorkRequest{Title: "Repair the build", Objective: "Produce a verified repair without losing earlier work", AcceptanceCriteria: []string{"The build passes", "The repair is verified"}}
}

func createTestWork(t *testing.T, e *Engine) WorkItem {
	t.Helper()
	work, err := e.CreateWork(testWorkRequest(), "")
	if err != nil {
		t.Fatal(err)
	}
	return work
}

func waitWorkRun(t *testing.T, e *Engine, id string) Run {
	t.Helper()
	return waitRun(t, e, id, func(r Run) bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return settled(r) && e.active[id] == nil
	})
}

func TestWorkOutlivesFailedRunsAndRequiresVerifiedCompletion(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	work := createTestWork(t, e)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "command", Command: "printf failed-approach; exit 7", Next: map[string]string{"success": "end"}}
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	first, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "first")
	if err != nil {
		t.Fatal(err)
	}
	first = waitWorkRun(t, e, first.ID)
	if first.Status != "failed" {
		t.Fatal(first.Status)
	}
	work, err = e.GetWork(work.ID)
	if err != nil || work.Status != "open" || work.LatestRunID != first.ID {
		t.Fatalf("failed run ended the work: %+v %v", work, err)
	}
	handoff := WorkHandoff{Progress: "Root cause isolated", FailedApproaches: "The first repair failed validation", Blockers: "Need a corrected implementation", NextAction: "Apply the corrected fix and verify it"}
	work, err = e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: handoff})
	if err != nil {
		t.Fatal(err)
	}
	w.Nodes["work"] = Node{Type: "command", Command: "printf verified", Next: map[string]string{"success": "end"}}
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	second, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "replacement")
	if err != nil {
		t.Fatal(err)
	}
	if second.Work == nil || second.Work.PreviousRun == nil || second.Work.PreviousRun.ID != first.ID || second.Work.PreviousRun.Result.Output != "failed-approach" || second.Work.Handoff != handoff {
		t.Fatalf("replacement lost durable context: %+v", second.Work)
	}
	if second.Work.Objective != work.Objective || !reflect.DeepEqual(second.Work.AcceptanceCriteria, work.AcceptanceCriteria) {
		t.Fatal("replacement did not receive the work contract")
	}
	if _, err := e.Retry(first.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("superseded run could be retried: %v", err)
	}
	work, _ = e.GetWork(work.ID)
	work, err = e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: WorkHandoff{Progress: "Newer operator note"}})
	if err != nil {
		t.Fatal(err)
	}
	second = waitWorkRun(t, e, second.ID)
	if second.Status != "succeeded" || second.Work.Handoff != handoff {
		t.Fatalf("run changed its pinned handoff: %+v", second)
	}
	current, _ := e.GetWork(work.ID)
	if current.Status != "open" || current.Completion != nil {
		t.Fatal("successful run automatically completed work")
	}
	req := CompleteWorkRequest{ExpectedRevision: current.Revision, RunID: second.ID, Summary: "Reviewed the verification output", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: second.Attempts[1].ID}, {Criterion: 2, AttemptID: second.Attempts[1].ID}}}
	if _, err := e.CompleteWork(work.ID, req); err == nil {
		t.Fatal("completion did not require explicit approval")
	}
	req.Approve = true
	req.Evidence[0].AttemptID = second.Attempts[0].ID
	if _, err := e.CompleteWork(work.ID, req); err == nil {
		t.Fatal("start node was accepted as verification")
	}
	req.Evidence[0].AttemptID = first.Attempts[1].ID
	if _, err := e.CompleteWork(work.ID, req); err == nil {
		t.Fatal("evidence from a failed prior run was accepted")
	}
	req.Evidence[0].AttemptID = second.Attempts[1].ID
	work, err = e.CompleteWork(work.ID, req)
	if err != nil || work.Status != "completed" || work.Completion.RunID != second.ID || len(work.Completion.Evidence) != 2 {
		t.Fatalf("verified completion failed: %+v %v", work, err)
	}
	if _, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "after-completion"); !errors.Is(err, ErrConflict) {
		t.Fatalf("completed work accepted a run: %v", err)
	}
	if _, err := e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision}); !errors.Is(err, ErrConflict) {
		t.Fatal("completed work was changed")
	}
	if _, err := e.Cleanup(context.Background(), second.ID); err != nil {
		t.Fatal(err)
	}
	retained, _ := e.GetWork(work.ID)
	if !reflect.DeepEqual(retained.Completion, work.Completion) {
		t.Fatal("workspace cleanup lost completion evidence")
	}
	history, err := e.ListWorkRuns(work.ID, 100, 0)
	if err != nil || len(history) != 2 || history[0].ID != first.ID || history[1].ID != second.ID {
		t.Fatalf("run history lost: %+v %v", history, err)
	}
	events, err := e.WorkEvents(work.ID, 0, 100)
	if err != nil || len(events) != 6 || events[0].Type != "work.created" || events[5].Type != "work.completed" {
		t.Fatalf("work audit trail lost: %+v %v", events, err)
	}
	var recorded struct {
		Revision int         `json:"revision"`
		Handoff  WorkHandoff `json:"handoff"`
	}
	if err := json.Unmarshal(events[2].Data, &recorded); err != nil || recorded.Revision != 3 || recorded.Handoff != handoff {
		t.Fatalf("earlier handoff was not retained in the event log: %+v %v", recorded, err)
	}
	tail, err := e.WorkEvents(work.ID, events[2].ID, 100)
	if err != nil || len(tail) != 3 || tail[0].ID != events[3].ID {
		t.Fatalf("bad work event replay: %+v %v", tail, err)
	}
}

func TestWorkCreationValidationAndIdempotency(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	req := testWorkRequest()
	work, err := e.CreateWork(req, "request")
	if err != nil {
		t.Fatal(err)
	}
	same, err := e.CreateWork(req, "request")
	if err != nil || work.ID != same.ID {
		t.Fatal("work creation was not idempotent", err)
	}
	req.Objective = "A different obligation"
	if _, err := e.CreateWork(req, "request"); !errors.Is(err, ErrConflict) {
		t.Fatal("changed payload reused idempotency key", err)
	}
	for _, mutate := range []func(*CreateWorkRequest){
		func(r *CreateWorkRequest) { r.Title = " " },
		func(r *CreateWorkRequest) { r.Objective = "" },
		func(r *CreateWorkRequest) { r.AcceptanceCriteria = nil },
		func(r *CreateWorkRequest) { r.AcceptanceCriteria = []string{" "} },
		func(r *CreateWorkRequest) { r.AcceptanceCriteria = []string{strings.Repeat("x", 2049)} },
		func(r *CreateWorkRequest) { r.Handoff.Progress = strings.Repeat("x", 8193) },
		func(r *CreateWorkRequest) { r.Dependencies = []string{work.ID, work.ID} },
		func(r *CreateWorkRequest) { r.Dependencies = []string{"missing"} },
	} {
		bad := testWorkRequest()
		mutate(&bad)
		if _, err := e.CreateWork(bad, ""); err == nil {
			t.Fatalf("accepted invalid work: %+v", bad)
		}
	}
	updated, err := e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: WorkHandoff{Progress: "one"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: WorkHandoff{Progress: "stale"}}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale handoff overwrote newer progress")
	}
	if _, err := e.CancelWork(work.ID, CancelWorkRequest{ExpectedRevision: updated.Revision, Reason: "No longer needed"}); err != nil {
		t.Fatal(err)
	}
	req.Dependencies = []string{work.ID}
	if _, err := e.CreateWork(req, ""); !errors.Is(err, ErrConflict) {
		t.Fatal("accepted canceled dependency", err)
	}
}

func TestWorkExecutionClaimIsAtomicAndBlocksOverlap(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	work := createTestWork(t, e)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "human", Prompt: "Proceed?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "end", "no": "end"}}
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "")
			if err == nil {
				ids <- r.ID
			} else if !errors.Is(err, ErrConflict) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	close(ids)
	if len(ids) != 1 {
		t.Fatalf("expected exactly one current execution, got %d", len(ids))
	}
	r := waitWorkRun(t, e, <-ids)
	work, _ = e.GetWork(work.ID)
	if _, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "new-key"); !errors.Is(err, ErrConflict) {
		t.Fatal("waiting work accepted a replacement", err)
	}
	if _, err := e.CancelWork(work.ID, CancelWorkRequest{ExpectedRevision: work.Revision, Reason: "Stop"}); !errors.Is(err, ErrConflict) {
		t.Fatal("work canceled while its run was live", err)
	}
	if _, err := e.Cancel(r.ID); err != nil {
		t.Fatal(err)
	}
	work, err := e.CancelWork(work.ID, CancelWorkRequest{ExpectedRevision: work.Revision, Reason: "Stopped the execution first"})
	if err != nil || work.Status != "canceled" {
		t.Fatal("could not explicitly abandon inactive work", err)
	}
}

func TestWorkClaimRollsBackRunEventsAndDedupTogether(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	work := createTestWork(t, e)
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.db.Exec("CREATE TRIGGER reject_work_claim BEFORE INSERT ON events WHEN NEW.type='work.run_created' BEGIN SELECT RAISE(ABORT, 'claim fault'); END"); err != nil {
		t.Fatal(err)
	}
	req := SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}
	if _, err := e.Submit(req, "claim"); err == nil {
		t.Fatal("claim ignored storage fault")
	}
	unchanged, err := e.GetWork(work.ID)
	if err != nil || unchanged.LatestRunID != "" || unchanged.Revision != work.Revision {
		t.Fatalf("partial work claim persisted: %+v %v", unchanged, err)
	}
	runs, err := e.ListWorkRuns(work.ID, 100, 0)
	if err != nil || len(runs) != 0 {
		t.Fatal("orphan run survived failed claim", err)
	}
	if _, err := e.store.db.Exec("DROP TRIGGER reject_work_claim"); err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(req, "claim")
	if err != nil {
		t.Fatal("rolled-back dedup key could not be reused", err)
	}
	same, err := e.Submit(req, "claim")
	if err != nil || same.ID != r.ID {
		t.Fatal("linked run idempotency failed", err)
	}
}

func TestWorkDependenciesRequireCompletionNotRunSuccess(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	dependency := createTestWork(t, e)
	req := testWorkRequest()
	req.Dependencies = []string{dependency.ID}
	work, err := e.CreateWork(req, "")
	if err != nil {
		t.Fatal(err)
	}
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	request := SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}
	if _, err := e.Submit(request, "blocked"); !errors.Is(err, ErrConflict) {
		t.Fatal("blocked work started", err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: dependency.ID, WorkRevision: dependency.Revision}, "dependency")
	if err != nil {
		t.Fatal(err)
	}
	r = waitWorkRun(t, e, r.ID)
	if _, err := e.Submit(request, "blocked"); !errors.Is(err, ErrConflict) {
		t.Fatal("run success incorrectly satisfied a work dependency", err)
	}
	dependency, _ = e.GetWork(dependency.ID)
	if _, err := e.CompleteWork(dependency.ID, CompleteWorkRequest{ExpectedRevision: dependency.Revision, RunID: r.ID, Approve: true, Summary: "Verified", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: r.Attempts[1].ID}, {Criterion: 2, AttemptID: r.Attempts[1].ID}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Submit(request, "blocked"); err != nil {
		t.Fatal("completed dependency did not release work", err)
	}
}

func TestWorkReplacementReceivesExecutableEvidenceRatherThanEndNode(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	work := createTestWork(t, e)
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	first, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "")
	if err != nil {
		t.Fatal(err)
	}
	first = waitWorkRun(t, e, first.ID)
	work, _ = e.GetWork(work.ID)
	second, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "")
	if err != nil {
		t.Fatal(err)
	}
	previous := second.Work.PreviousRun
	if previous.ResultNode != "work" || previous.ResultAttemptID != first.Attempts[1].ID || previous.Result.Output != "done" || previous.Current != "end" {
		t.Fatalf("replacement received orchestration output instead of useful evidence: %+v", previous)
	}
}
