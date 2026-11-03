package factory

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func workAPIRequest() CreateWorkRequest {
	return CreateWorkRequest{Title: "Repair the build", Objective: "Restore a passing build", AcceptanceCriteria: []string{"Build succeeds", "Verification succeeds"}}
}

func waitWorkAPIRun(t *testing.T, e *Engine, id string) Run {
	t.Helper()
	return waitRun(t, e, id, func(r Run) bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return r.Terminal() && e.active[id] == nil
	})
}

func TestWorkAPIAuthenticationAndValidation(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	for _, route := range []struct{ method, path string }{
		{"POST", "/v1/work"}, {"GET", "/v1/work"}, {"GET", "/v1/work/missing"},
		{"PUT", "/v1/work/missing/handoff"}, {"POST", "/v1/work/missing/complete"},
		{"POST", "/v1/work/missing/cancel"}, {"GET", "/v1/work/missing/runs"}, {"GET", "/v1/work/missing/events"},
	} {
		for _, token := range []string{"", "Bearer wrong"} {
			request(t, h, route.method, route.path, nil, map[string]string{"Authorization": token}, http.StatusUnauthorized)
		}
	}
	for _, body := range []any{
		map[string]any{},
		map[string]any{"title": "x", "objective": "x", "acceptance_criteria": []string{}},
		map[string]any{"title": "x", "objective": "x", "acceptance_criteria": []string{""}},
		map[string]any{"title": " ", "objective": "x", "acceptance_criteria": []string{"x"}},
		map[string]any{"title": "x", "objective": "x", "acceptance_criteria": []string{"x"}, "status": "completed"},
	} {
		request(t, h, "POST", "/v1/work", body, nil, 422)
	}
	request(t, h, "POST", "/v1/work", workAPIRequest(), map[string]string{"Idempotency-Key": strings.Repeat("x", 201)}, 422)
	for _, query := range []string{"limit=0", "limit=101", "offset=-1", "offset=1000001", "status=typo"} {
		request(t, h, "GET", "/v1/work?"+query, nil, nil, 422)
	}
	for _, path := range []string{"", "/runs", "/events"} {
		request(t, h, "GET", "/v1/work/missing"+path, nil, nil, 404)
	}
	for _, query := range []string{"limit=0", "limit=101", "offset=-1"} {
		request(t, h, "GET", "/v1/work/missing/runs?"+query, nil, nil, 422)
	}
	for _, query := range []string{"after=-1", "after=bad", "limit=0", "limit=1001"} {
		request(t, h, "GET", "/v1/work/missing/events?"+query, nil, nil, 422)
	}
	request(t, h, "PUT", "/v1/work/missing/handoff", UpdateWorkHandoffRequest{ExpectedRevision: 1}, nil, 404)
	request(t, h, "POST", "/v1/work/missing/cancel", CancelWorkRequest{ExpectedRevision: 1, Reason: "No longer needed"}, nil, 404)
	request(t, h, "POST", "/v1/work/missing/complete", CompleteWorkRequest{ExpectedRevision: 1, RunID: "missing", Approve: true, Summary: "Reviewed", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: "missing"}}}, nil, 404)
	work := decode[WorkItem](t, request(t, h, "POST", "/v1/work", workAPIRequest(), nil, 200))
	duplicateDependencies := workAPIRequest()
	duplicateDependencies.Dependencies = []string{work.ID, work.ID}
	request(t, h, "POST", "/v1/work", duplicateDependencies, nil, 422)
	base := "/v1/work/" + work.ID
	request(t, h, "PUT", base+"/handoff", map[string]any{"handoff": WorkHandoff{}}, nil, 422)
	request(t, h, "PUT", base+"/handoff", map[string]any{"expected_revision": 1, "handoff": WorkHandoff{}, "objective": "Changed"}, nil, 422)
	request(t, h, "PUT", base+"/handoff", UpdateWorkHandoffRequest{ExpectedRevision: 1, Handoff: WorkHandoff{Progress: strings.Repeat("x", 8193)}}, nil, 422)
	request(t, h, "POST", base+"/cancel", CancelWorkRequest{ExpectedRevision: 1}, nil, 422)
	request(t, h, "POST", base+"/complete", map[string]any{"expected_revision": 1, "run_id": "missing", "approve": true, "summary": "Reviewed", "evidence": []WorkEvidenceRef{}}, nil, 422)
	request(t, h, "DELETE", base, nil, nil, 405)
	request(t, h, "PUT", base, workAPIRequest(), nil, 405)
}

func TestWorkAPILifecycleAndPinnedRunHistory(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	create := workAPIRequest()
	headers := map[string]string{"Idempotency-Key": "work-create"}
	work := decode[WorkItem](t, request(t, h, "POST", "/v1/work", create, headers, 200))
	same := decode[WorkItem](t, request(t, h, "POST", "/v1/work", create, headers, 200))
	if work.ID != same.ID || work.Status != "open" || work.Revision != 1 {
		t.Fatalf("unexpected creation: %+v / %+v", work, same)
	}
	create.Objective = "Different objective"
	request(t, h, "POST", "/v1/work", create, headers, 409)
	base := "/v1/work/" + work.ID
	handoff := UpdateWorkHandoffRequest{ExpectedRevision: 1, Handoff: WorkHandoff{NextAction: "Run the failing build"}}
	work = decode[WorkItem](t, request(t, h, "PUT", base+"/handoff", handoff, nil, 200))
	if work.Revision != 2 || work.Handoff != handoff.Handoff {
		t.Fatalf("handoff not updated: %+v", work)
	}
	request(t, h, "PUT", base+"/handoff", handoff, nil, 409)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "command", Command: "exit 7", Next: map[string]string{"success": "end"}}
	request(t, h, "POST", "/v1/workflows", map[string]string{"yaml": workflowYAML(t, w)}, nil, 200)
	request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkRevision: 2}, nil, 422)
	request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: work.ID}, nil, 409)
	submit := SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}
	run := decode[Run](t, request(t, h, "POST", "/v1/runs", submit, map[string]string{"Idempotency-Key": "work-run"}, 200))
	replayed := decode[Run](t, request(t, h, "POST", "/v1/runs", submit, map[string]string{"Idempotency-Key": "work-run"}, 200))
	if replayed.ID != run.ID || run.WorkID != work.ID || run.Work == nil || run.Work.Revision != 3 {
		t.Fatalf("linked submission not pinned or deduplicated: %+v / %+v", run, replayed)
	}
	request(t, h, "POST", "/v1/runs", submit, nil, 409)
	request(t, h, "PUT", base+"/handoff", UpdateWorkHandoffRequest{ExpectedRevision: 2}, nil, 409)
	run = waitWorkAPIRun(t, e, run.ID)
	work = decode[WorkItem](t, request(t, h, "GET", base, nil, nil, 200))
	if run.Status != "failed" || work.Status != "open" || work.Revision != 3 || work.LatestRunID != run.ID {
		t.Fatalf("run failure changed work state: %+v / %+v", run, work)
	}
	completion := CompleteWorkRequest{ExpectedRevision: work.Revision, RunID: run.ID, Approve: true, Summary: "Reviewed", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: "missing"}, {Criterion: 2, AttemptID: "missing"}}}
	request(t, h, "POST", base+"/complete", completion, nil, 409)
	handoff = UpdateWorkHandoffRequest{ExpectedRevision: work.Revision, Handoff: WorkHandoff{Progress: "Reproduced", FailedApproaches: "The first build failed", NextAction: "Verify the repair"}}
	work = decode[WorkItem](t, request(t, h, "PUT", base+"/handoff", handoff, nil, 200))
	w.Nodes["work"] = Node{Type: "command", Command: "printf repaired", Next: map[string]string{"success": "verify"}}
	w.Nodes["verify"] = Node{Type: "command", Command: "printf verified", Next: map[string]string{"success": "end"}}
	request(t, h, "POST", "/v1/workflows", map[string]string{"yaml": workflowYAML(t, w)}, nil, 200)
	next := decode[Run](t, request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, nil, 200))
	if next.Work == nil || next.Work.Revision != 5 || next.Work.Handoff != handoff.Handoff || next.Work.PreviousRun == nil || next.Work.PreviousRun.ID != run.ID || next.Work.PreviousRun.Status != "failed" {
		t.Fatalf("missing pinned context: %+v", next.Work)
	}
	work = decode[WorkItem](t, request(t, h, "PUT", base+"/handoff", UpdateWorkHandoffRequest{ExpectedRevision: 5, Handoff: WorkHandoff{Progress: "Ready for review"}}, nil, 200))
	next = waitWorkAPIRun(t, e, next.ID)
	if next.Status != "succeeded" || next.Work.Handoff != handoff.Handoff {
		t.Fatalf("run snapshot changed: %+v", next)
	}
	work = decode[WorkItem](t, request(t, h, "GET", base, nil, nil, 200))
	if work.Status != "open" || work.Completion != nil || work.Revision != 6 {
		t.Fatalf("run success automatically completed work: %+v", work)
	}
	request(t, h, "POST", "/v1/runs/"+run.ID+"/retry", map[string]bool{"acknowledge_side_effects": true}, nil, 409)
	for i, id := range []string{run.ID, next.ID} {
		page := decode[[]RunSummary](t, request(t, h, "GET", fmt.Sprintf("%s/runs?limit=1&offset=%d", base, i), nil, nil, 200))
		if len(page) != 1 || page[0].ID != id || page[0].WorkID != work.ID {
			t.Fatalf("wrong run page: %+v", page)
		}
	}
	if page := string(request(t, h, "GET", base+"/runs?offset=2", nil, nil, 200)); strings.TrimSpace(page) != "[]" {
		t.Fatalf("empty run page is not an array: %s", page)
	}
	allRuns := decode[[]RunSummary](t, request(t, h, "GET", "/v1/runs", nil, nil, 200))
	if len(allRuns) != 2 || allRuns[0].WorkID != work.ID || allRuns[1].WorkID != work.ID {
		t.Fatalf("work IDs missing from summaries: %+v", allRuns)
	}
	completion.ExpectedRevision, completion.RunID = work.Revision, next.ID
	completion.Evidence = nil
	for _, attempt := range next.Attempts {
		if attempt.Node == "work" || attempt.Node == "verify" {
			completion.Evidence = append(completion.Evidence, WorkEvidenceRef{Criterion: len(completion.Evidence) + 1, AttemptID: attempt.ID})
		}
	}
	if len(completion.Evidence) != 2 {
		t.Fatalf("missing command attempts: %+v", next.Attempts)
	}
	completion.Approve = false
	request(t, h, "POST", base+"/complete", completion, nil, 422)
	completion.Approve = true
	completion.ExpectedRevision--
	request(t, h, "POST", base+"/complete", completion, nil, 409)
	completion.ExpectedRevision++
	bad := completion
	bad.Evidence = []WorkEvidenceRef{completion.Evidence[0], completion.Evidence[0]}
	request(t, h, "POST", base+"/complete", bad, nil, 422)
	bad.Evidence = []WorkEvidenceRef{{Criterion: 1, AttemptID: "missing"}, completion.Evidence[1]}
	request(t, h, "POST", base+"/complete", bad, nil, 422)
	work = decode[WorkItem](t, request(t, h, "POST", base+"/complete", completion, nil, 200))
	if work.Status != "completed" || work.Revision != 7 || work.Completion == nil || work.Completion.RunID != next.ID || len(work.Completion.Evidence) != 2 {
		t.Fatalf("completion not retained: %+v", work)
	}
	request(t, h, "POST", base+"/complete", completion, nil, 409)
	request(t, h, "PUT", base+"/handoff", UpdateWorkHandoffRequest{ExpectedRevision: work.Revision}, nil, 409)
	request(t, h, "POST", base+"/cancel", CancelWorkRequest{ExpectedRevision: work.Revision, Reason: "Too late"}, nil, 409)
	request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, nil, 409)
	events := decode[[]WorkEvent](t, request(t, h, "GET", base+"/events", nil, nil, 200))
	wantTypes := []string{"work.created", "work.handoff", "work.run_created", "work.handoff", "work.run_created", "work.handoff", "work.completed"}
	if len(events) != len(wantTypes) {
		t.Fatalf("unexpected work events: %+v", events)
	}
	for i, event := range events {
		if event.Type != wantTypes[i] || event.WorkID != work.ID || (i > 0 && event.ID <= events[i-1].ID) {
			t.Fatalf("unexpected work event: %+v", event)
		}
		page := decode[[]WorkEvent](t, request(t, h, "GET", fmt.Sprintf("%s/events?after=%d&limit=1", base, event.ID-1), nil, nil, 200))
		if len(page) != 1 || page[0].ID != event.ID {
			t.Fatalf("wrong event page: %+v", page)
		}
	}
	tail := decode[[]WorkEvent](t, request(t, h, "GET", fmt.Sprintf("%s/events?after=%d", base, events[len(events)-1].ID), nil, nil, 200))
	if len(tail) != 0 || tail == nil {
		t.Fatalf("unexpected event tail: %+v", tail)
	}
}

func TestWorkAPIListCancelAndDependencies(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	first := decode[WorkItem](t, request(t, h, "POST", "/v1/work", workAPIRequest(), nil, 200))
	create := workAPIRequest()
	create.Dependencies = []string{"missing"}
	request(t, h, "POST", "/v1/work", create, nil, 404)
	create.Dependencies = []string{first.ID}
	second := decode[WorkItem](t, request(t, h, "POST", "/v1/work", create, nil, 200))
	w := basicWorkflow()
	request(t, h, "POST", "/v1/workflows", map[string]string{"yaml": workflowYAML(t, w)}, nil, 200)
	request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: second.ID, WorkRevision: second.Revision}, nil, 409)
	for i, want := range []WorkItem{first, second} {
		page := decode[[]WorkItem](t, request(t, h, "GET", fmt.Sprintf("/v1/work?status=open&limit=1&offset=%d", i), nil, nil, 200))
		if len(page) != 1 || page[0].ID != want.ID {
			t.Fatalf("wrong work page: %+v", page)
		}
	}
	base := "/v1/work/" + first.ID
	request(t, h, "POST", base+"/cancel", CancelWorkRequest{ExpectedRevision: 2, Reason: "Obsolete"}, nil, 409)
	canceled := decode[WorkItem](t, request(t, h, "POST", base+"/cancel", CancelWorkRequest{ExpectedRevision: 1, Reason: "Obsolete"}, nil, 200))
	if canceled.Status != "canceled" || canceled.Revision != 2 || canceled.CancelReason != "Obsolete" {
		t.Fatalf("cancellation not retained: %+v", canceled)
	}
	request(t, h, "POST", base+"/cancel", CancelWorkRequest{ExpectedRevision: 2, Reason: "Again"}, nil, 409)
	create.Dependencies = []string{first.ID}
	request(t, h, "POST", "/v1/work", create, nil, 409)
	request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: second.ID, WorkRevision: second.Revision}, nil, 409)
	for status, id := range map[string]string{"open": second.ID, "canceled": first.ID, "completed": ""} {
		page := decode[[]WorkItem](t, request(t, h, "GET", "/v1/work?status="+status, nil, nil, 200))
		if id == "" {
			if len(page) != 0 || page == nil {
				t.Fatalf("unexpected empty work page: %+v", page)
			}
		} else if len(page) != 1 || page[0].ID != id {
			t.Fatalf("wrong status filter: %+v", page)
		}
	}
	events := decode[[]WorkEvent](t, request(t, h, "GET", base+"/events", nil, nil, 200))
	if len(events) != 2 || events[1].Type != "work.canceled" {
		t.Fatalf("missing cancellation event: %+v", events)
	}
}

func TestWorkAPIRejectsAgentSelfReportEvidence(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	work := decode[WorkItem](t, request(t, h, "POST", "/v1/work", CreateWorkRequest{Title: "Repair", Objective: "Fix the build", AcceptanceCriteria: []string{"Build passes"}}, nil, 200))
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "agent", Provider: "test", Model: "test", Prompt: "Claim success", Next: map[string]string{"success": "end"}}
	r := makeRun(w, "fixture", "", nil)
	r.Status, r.WorkID = "succeeded", work.ID
	finished := now()
	r.Attempts = []Attempt{{ID: newID(), Node: "work", Finalized: true, StartedAt: finished, FinishedAt: &finished, Result: Result{Outcome: "success", Output: "Everything passes"}}}
	work.LatestRunID = r.ID
	for _, tc := range []struct {
		name, nodeType, outcome string
		finalized, finished     bool
	}{
		{"agent self-report", "agent", "success", true, true},
		{"failed verification", "command", "failure", true, true},
		{"unfinalized verification", "command", "success", false, true},
		{"unfinished verification", "command", "success", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node := r.Workflow.Nodes["work"]
			node.Type = tc.nodeType
			r.Workflow.Nodes["work"] = node
			r.Attempts[0].Result.Outcome = tc.outcome
			r.Attempts[0].Finalized = tc.finalized
			r.Attempts[0].FinishedAt = nil
			if tc.finished {
				r.Attempts[0].FinishedAt = &finished
			}
			e.mu.Lock()
			err := e.store.commit([]change{{"work", work.ID, work}, {"run", r.ID, r}}, nil, nil)
			e.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			request(t, h, "POST", "/v1/work/"+work.ID+"/complete", CompleteWorkRequest{ExpectedRevision: work.Revision, RunID: r.ID, Approve: true, Summary: "Reviewed", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: r.Attempts[0].ID}}}, nil, 422)
		})
	}
	got := decode[WorkItem](t, request(t, h, "GET", "/v1/work/"+work.ID, nil, nil, 200))
	if got.Status != "open" || got.Completion != nil {
		t.Fatalf("self-report completed work: %+v", got)
	}
}

func TestWorkAPIRequiresExplicitInterruptedRunResolution(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	e, err := NewEngine(store, &Executor{Root: dir, AllowLocal: true}, 1)
	if err != nil {
		t.Fatal(err)
	}
	h := NewAPI(e, APIConfig{Token: testToken})
	work := decode[WorkItem](t, request(t, h, "POST", "/v1/work", workAPIRequest(), nil, 200))
	w := basicWorkflow()
	request(t, h, "POST", "/v1/workflows", map[string]string{"yaml": workflowYAML(t, w)}, nil, 200)
	r := makeRun(w, "fixture", "", nil)
	r.WorkID, work.LatestRunID = work.ID, r.ID
	for _, status := range []string{"queued", "running", "waiting", "interrupted"} {
		r.Status = status
		if err := store.commit([]change{{"work", work.ID, work}, {"run", r.ID, r}}, nil, nil); err != nil {
			t.Fatal(err)
		}
		request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, nil, 409)
		request(t, h, "POST", "/v1/work/"+work.ID+"/cancel", CancelWorkRequest{ExpectedRevision: work.Revision, Reason: "Stop"}, nil, 409)
		request(t, h, "POST", "/v1/work/"+work.ID+"/complete", CompleteWorkRequest{ExpectedRevision: work.Revision, RunID: r.ID, Approve: true, Summary: "Reviewed", Evidence: []WorkEvidenceRef{{Criterion: 1, AttemptID: "missing"}, {Criterion: 2, AttemptID: "missing"}}}, nil, 409)
	}
	request(t, h, "POST", "/v1/runs/"+r.ID+"/retry", map[string]bool{"acknowledge_side_effects": false}, nil, 422)
	retried := decode[Run](t, request(t, h, "POST", "/v1/runs/"+r.ID+"/retry", map[string]bool{"acknowledge_side_effects": true}, nil, 200))
	if retried.ID != r.ID || retried.Status != "queued" {
		t.Fatalf("interrupted retry did not retain the run: %+v", retried)
	}
	request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, nil, 409)
	r.Status = "interrupted"
	if err := store.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	request(t, h, "POST", "/v1/runs/"+r.ID+"/cancel", nil, nil, 200)
	replacement := decode[Run](t, request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name, WorkID: work.ID, WorkRevision: work.Revision}, nil, 200))
	if replacement.ID == r.ID || replacement.Work == nil || replacement.Work.PreviousRun == nil || replacement.Work.PreviousRun.Status != "canceled" {
		t.Fatalf("missing explicit resolution evidence: %+v", replacement)
	}
}

func TestWorkAPISchema(t *testing.T) {
	t.Parallel()
	h := NewAPI(testEngine(t, nil), APIConfig{Token: testToken})
	doc := decode[map[string]any](t, request(t, h, "GET", "/openapi.json", nil, nil, 200))
	paths := doc["paths"].(map[string]any)
	for path, methods := range map[string][]string{
		"/v1/work": {"post", "get"}, "/v1/work/{id}": {"get"},
		"/v1/work/{id}/handoff": {"put"}, "/v1/work/{id}/complete": {"post"},
		"/v1/work/{id}/cancel": {"post"}, "/v1/work/{id}/runs": {"get"}, "/v1/work/{id}/events": {"get"},
	} {
		item, ok := paths[path].(map[string]any)
		if !ok {
			t.Fatalf("missing work route %s", path)
		}
		for _, method := range methods {
			if item[method] == nil {
				t.Fatalf("missing work operation %s %s", method, path)
			}
		}
		if len(item) != len(methods) {
			t.Fatalf("unexpected work operations: %s %+v", path, item)
		}
	}
	security := doc["security"].([]any)
	if len(security) != 1 || security[0].(map[string]any)["bearer"] == nil {
		t.Fatalf("work routes lack inherited bearer security: %+v", security)
	}
	schemas := doc["components"].(map[string]any)["schemas"].(map[string]any)
	for name, fields := range map[string][]string{
		"CreateWorkRequest":        {"title", "objective", "acceptance_criteria", "dependencies", "handoff"},
		"WorkItem":                 {"status", "revision", "latest_run_id", "completion"},
		"UpdateWorkHandoffRequest": {"expected_revision", "handoff"},
		"CompleteWorkRequest":      {"expected_revision", "run_id", "approve", "summary", "evidence"},
		"CancelWorkRequest":        {"expected_revision", "reason"},
		"WorkEvidenceRef":          {"criterion", "attempt_id"},
		"WorkEvent":                {"id", "work_id", "type", "time", "data"},
		"RunSummary":               {"work_id"}, "SubmitRequest": {"work_id", "work_revision"}, "Run": {"work_id", "work"},
	} {
		schema, ok := schemas[name].(map[string]any)
		if !ok {
			t.Fatalf("missing work schema %s", name)
		}
		props := schema["properties"].(map[string]any)
		for _, field := range fields {
			if props[field] == nil {
				t.Fatalf("missing %s.%s", name, field)
			}
		}
	}
	workStatus := schemas["WorkItem"].(map[string]any)["properties"].(map[string]any)["status"].(map[string]any)["enum"]
	if !reflect.DeepEqual(workStatus, []any{"open", "completed", "canceled"}) {
		t.Fatalf("unexpected work status schema: %+v", workStatus)
	}
}
