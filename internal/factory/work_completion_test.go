package factory

import (
	"context"
	"errors"
	"testing"
)

func TestWorkCompletionBindsValidatedCandidateAndRetainsEvidence(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	work := createTestWork(t, e)
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t), Base: "main"}
	w.Nodes["work"] = Node{Type: "command", Command: "printf changed > file.txt", Next: map[string]string{"success": "verify"}}
	n := candidateNode()
	n.Next = map[string]string{"success": "gate"}
	w.Nodes["verify"] = n
	w.Nodes["gate"] = Node{Type: "human", Prompt: "Approve the verified change?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "end", "no": "work"}}
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "")
	if err != nil {
		t.Fatal(err)
	}
	r = waitWorkRun(t, e, r.ID)
	if r.Status != "waiting" || r.Candidate == nil || r.Question.CandidateID != r.Candidate.ID {
		t.Fatalf("work execution bypassed candidate approval: %+v", r)
	}
	work, _ = e.GetWork(work.ID)
	req := CompleteWorkRequest{ExpectedRevision: work.Revision, RunID: r.ID, Approve: true, Summary: "Reviewed the candidate checks", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: r.Attempts[2].ID}, {Criterion: 2, AttemptID: r.Attempts[2].ID}}}
	if _, err := e.CompleteWork(work.ID, req); !errors.Is(err, ErrConflict) {
		t.Fatal("work completion bypassed a pending human gate", err)
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: r.Question.ID, CandidateID: r.Candidate.ID, Choice: "yes"}); err != nil {
		t.Fatal(err)
	}
	r = waitWorkRun(t, e, r.ID)
	if r.Status != "succeeded" {
		t.Fatal(r.Status)
	}
	work, err = e.CompleteWork(work.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	proof := work.Completion.Evidence[0]
	if proof.CheckpointSHA == "" || proof.CheckpointSHA != r.Attempts[2].CheckpointSHA || proof.CandidateID != r.Candidate.ID {
		t.Fatalf("completion lost immutable verification identities: %+v", proof)
	}
	if _, err := e.Cleanup(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := git(context.Background(), e.exec.repoDir(*w.Repository), "cat-file", "-e", proof.CheckpointSHA+"^{commit}"); err != nil {
		t.Fatal("cleanup destroyed completion proof", err)
	}
}

func TestWorkMutationAndAuditEventsCommitTogether(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	fault := func(event string) {
		t.Helper()
		if _, err := e.store.db.Exec("CREATE TRIGGER fail_work_event BEFORE INSERT ON events WHEN NEW.type='" + event + "' BEGIN SELECT RAISE(ABORT, 'work event fault'); END"); err != nil {
			t.Fatal(err)
		}
	}
	repair := func() {
		t.Helper()
		if _, err := e.store.db.Exec("DROP TRIGGER fail_work_event"); err != nil {
			t.Fatal(err)
		}
	}
	fault("work.created")
	if _, err := e.CreateWork(testWorkRequest(), "create"); err == nil {
		t.Fatal("creation ignored event persistence failure")
	}
	items, err := list[WorkItem](e.store, "work", "", 100, 0)
	if err != nil || len(items) != 0 {
		t.Fatal("partial work creation persisted", err)
	}
	repair()
	work, err := e.CreateWork(testWorkRequest(), "create")
	if err != nil {
		t.Fatal("failed creation retained a dedup key", err)
	}
	fault("work.handoff")
	if _, err := e.UpdateWorkHandoff(work.ID, UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: WorkHandoff{Progress: "must roll back"}}); err == nil {
		t.Fatal("handoff ignored event persistence failure")
	}
	got, err := e.GetWork(work.ID)
	if err != nil || got.Revision != work.Revision || got.Handoff.Progress != "" {
		t.Fatal("partial handoff persisted", err)
	}
	repair()
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, "")
	if err != nil {
		t.Fatal(err)
	}
	r = waitWorkRun(t, e, r.ID)
	work, _ = e.GetWork(work.ID)
	req := CompleteWorkRequest{ExpectedRevision: work.Revision, RunID: r.ID, Approve: true, Summary: "Verified", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: r.Attempts[1].ID}, {Criterion: 2, AttemptID: r.Attempts[1].ID}}}
	fault("work.completed")
	if _, err := e.CompleteWork(work.ID, req); err == nil {
		t.Fatal("completion ignored event persistence failure")
	}
	got, err = e.GetWork(work.ID)
	if err != nil || got.Status != "open" || got.Completion != nil || got.Revision != work.Revision {
		t.Fatal("partial completion persisted", err)
	}
	repair()
	if _, err := e.CompleteWork(work.ID, req); err != nil {
		t.Fatal("completion could not be retried after rollback", err)
	}
}
