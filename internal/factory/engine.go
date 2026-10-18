package factory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type Engine struct {
	mu      sync.Mutex
	store   *Store
	exec    *Executor
	workers int
	active  map[string]context.CancelFunc
	wg      sync.WaitGroup
	stop    chan struct{}
	done    chan struct{}
	closing bool
	fault   error
}

func NewEngine(s *Store, x *Executor, workers int) (*Engine, error) {
	if workers < 1 || workers > 64 {
		return nil, errors.New("workers must be between 1 and 64")
	}
	e := &Engine{store: s, exec: x, workers: workers, active: map[string]context.CancelFunc{}, stop: make(chan struct{}), done: make(chan struct{})}
	runs, err := list[Run](s, "run", "running", -1, 0)
	if err != nil {
		return nil, err
	}
	for _, r := range runs {
		event := "run.interrupted"
		r.Status, r.Error = "interrupted", "daemon stopped during an external operation; inspect side effects before retrying"
		if pendingAttempt(r) {
			r.Status, r.Error, event = "queued", "", "run.recovered"
		} else if len(r.Attempts) > 0 {
			a := &r.Attempts[len(r.Attempts)-1]
			if !a.Finalized {
				t := now()
				a.FinishedAt = &t
				a.Result = Result{Outcome: "interrupted", Error: r.Error}
				r.Outputs[a.Node] = a.Result
			}
		}
		if err := e.saveRun(r, event, map[string]string{"reason": r.Error}); err != nil {
			return nil, err
		}
	}
	return e, nil
}
func (e *Engine) Start() {
	go func() {
		defer close(e.done)
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-e.stop:
				return
			case <-t.C:
				e.tick()
			}
		}
	}()
}
func (e *Engine) Close() {
	e.mu.Lock()
	e.closing = true
	for _, cancel := range e.active {
		cancel()
	}
	e.mu.Unlock()
	close(e.stop)
	<-e.done
	e.wg.Wait()
}
func (e *Engine) saveRun(r Run, kind string, data any) error {
	r.UpdatedAt = now()
	err := e.store.commit([]change{{"run", r.ID, r}}, []eventWrite{{r.ID, kind, data}}, nil)
	if err == nil {
		slog.Info("run transition", "run_id", r.ID, "event", kind, "status", r.Status, "node", r.Current)
	}
	return err
}
func (e *Engine) storageFailure(err error) {
	e.fault = err
	slog.Error("execution stopped after persistence failure; restart required", "error", err)
	for _, cancel := range e.active {
		cancel()
	}
}
func (e *Engine) tick() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closing || e.fault != nil {
		return
	}
	if err := e.schedule(now()); err != nil {
		e.storageFailure(err)
		return
	}
	runs, err := list[Run](e.store, "run", "queued", e.workers+len(e.active), 0)
	if err != nil {
		e.storageFailure(err)
		return
	}
	for _, r := range runs {
		if len(e.active) >= e.workers {
			break
		}
		if _, ok := e.active[r.ID]; ok {
			continue
		}
		r.Status = "running"
		if err := e.saveRun(r, "run.running", map[string]string{"node": r.Current}); err != nil {
			e.storageFailure(err)
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		e.active[r.ID] = cancel
		e.wg.Add(1)
		go func(r Run) {
			defer e.wg.Done()
			defer func() { cancel(); e.mu.Lock(); delete(e.active, r.ID); e.mu.Unlock() }()
			e.step(ctx, r)
			e.settleSandbox(r.ID)
		}(r)
	}
}
func (e *Engine) step(ctx context.Context, r Run) {
	lease, err := acquireLease(e.exec.Root, r.ID)
	if err != nil {
		e.mu.Lock()
		defer e.mu.Unlock()
		current, loadErr := get[Run](e.store, "run", r.ID)
		if loadErr != nil {
			e.storageFailure(loadErr)
			return
		}
		if current.Status == "running" {
			current.Status, current.Error = "interrupted", err.Error()
			if err := e.saveRun(current, "run.interrupted", map[string]string{"reason": current.Error}); err != nil {
				e.storageFailure(err)
			}
		}
		return
	}
	defer lease.Close()
	ctx = context.WithValue(ctx, processLeaseKey{}, lease)
	if !r.Prepared {
		prepCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		prepared, err := e.exec.Prepare(prepCtx, r)
		cancel()
		e.mu.Lock()
		defer e.mu.Unlock()
		current, loadErr := get[Run](e.store, "run", r.ID)
		if loadErr != nil {
			e.storageFailure(loadErr)
			return
		}
		// Retain preparation metadata even if cancellation won the race.
		current.Workspace, current.Branch, current.BaseSHA, current.Artifacts, current.Sandbox = prepared.Workspace, prepared.Branch, prepared.BaseSHA, prepared.Artifacts, prepared.Sandbox
		current.Prepared = err == nil
		if current.Status == "canceled" {
			if err := e.saveRun(current, "workspace.prepared", map[string]any{"prepared": current.Prepared}); err != nil {
				e.storageFailure(err)
			}
			return
		}
		if ctx.Err() != nil {
			current.Status, current.Error = "interrupted", "workspace preparation interrupted; retry explicitly"
		} else if err != nil {
			current.Status, current.Error = "failed", err.Error()
		} else {
			current.Status = "queued"
		}
		data := map[string]any{"prepared": current.Prepared, "error": current.Error}
		if current.Sandbox != nil {
			data["sandbox"] = current.Sandbox
		}
		if err := e.saveRun(current, "workspace.prepared", data); err != nil {
			e.storageFailure(err)
		}
		return
	}
	e.mu.Lock()
	current, err := get[Run](e.store, "run", r.ID)
	if err != nil {
		e.storageFailure(err)
		e.mu.Unlock()
		return
	}
	if current.Status != "running" {
		e.mu.Unlock()
		return
	}
	r = current
	if pendingAttempt(r) {
		e.mu.Unlock()
		e.finishAttempt(ctx, r)
		return
	}
	n := r.Workflow.Nodes[r.Current]
	if r.Steps >= r.Workflow.MaxSteps || (n.MaxVisits > 0 && r.Visits[r.Current] >= n.MaxVisits) {
		r.Status, r.Error = "failed", "execution budget exhausted"
		if err := e.saveRun(r, "run.failed", map[string]string{"error": r.Error}); err != nil {
			e.storageFailure(err)
		}
		e.mu.Unlock()
		return
	}
	if n.Type == "changeset" {
		r.Candidate = nil
	}
	r.Steps++
	r.Visits[r.Current]++
	a := Attempt{ID: newID(), Node: r.Current, StartedAt: now(), Result: Result{Outcome: "running"}}
	if n.Type == "agent" {
		a.Transcript = filepath.ToSlash(filepath.Join("agents", r.ID, a.ID, "events.jsonl"))
	}
	r.Attempts = append(r.Attempts, a)
	if n.Type == "human" {
		prompt, err := render(n.Prompt, r)
		if err != nil {
			r.Status, r.Error = "failed", err.Error()
			a := &r.Attempts[len(r.Attempts)-1]
			t := now()
			a.FinishedAt = &t
			a.Result = failed(err)
		} else {
			r.Status = "waiting"
			r.Question = &Question{ID: newID(), Node: r.Current, Prompt: prompt, Choices: n.Choices, CreatedAt: now()}
			if r.Candidate != nil {
				r.Question.CandidateID = r.Candidate.ID
			}
		}
		if err := e.saveRun(r, "human.question", r.Question); err != nil {
			e.storageFailure(err)
			e.mu.Unlock()
			return
		}
		e.mu.Unlock()
		if pendingAttempt(r) {
			e.finishAttempt(ctx, r)
		}
		return
	}
	if err := e.saveRun(r, "node.started", r.Attempts[len(r.Attempts)-1]); err != nil {
		e.storageFailure(err)
		e.mu.Unlock()
		return
	}
	e.mu.Unlock()
	timeout := 15 * time.Minute
	if n.Timeout != "" {
		timeout, _ = time.ParseDuration(n.Timeout)
	}
	nodeCtx, cancel := context.WithTimeout(ctx, timeout)
	result := e.exec.Execute(nodeCtx, r, n)
	cancel()
	e.mu.Lock()
	current, err = get[Run](e.store, "run", r.ID)
	if err != nil {
		e.storageFailure(err)
		e.mu.Unlock()
		return
	}
	last := &current.Attempts[len(current.Attempts)-1]
	t := now()
	last.FinishedAt = &t
	if current.Status == "canceled" {
		result.Outcome = "canceled"
	} else if ctx.Err() != nil {
		current.Status, current.Error = "interrupted", "daemon stopped; inspect the last operation before retrying"
		result.Outcome = "interrupted"
	}
	if n.Type == "changeset" && result.Outcome == "success" {
		current.Candidate = result.Candidate
	}
	last.Result = result
	current.Outputs[r.Current] = result
	if err := e.saveRun(current, "node.executed", last); err != nil {
		e.storageFailure(err)
		e.mu.Unlock()
		return
	}
	e.mu.Unlock()
	e.finishAttempt(ctx, current)
}

func (e *Engine) Register(yaml, expectedRevision string) (WorkflowRecord, error) {
	w, err := ParseWorkflow([]byte(yaml))
	if err != nil {
		return WorkflowRecord{}, invalid("%s", err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	old, err := get[WorkflowRecord](e.store, "workflow", w.Name)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return WorkflowRecord{}, err
	}
	if expectedRevision != "" && old.Revision != expectedRevision {
		return WorkflowRecord{}, fmt.Errorf("%w: workflow revision changed", ErrConflict)
	}
	if w.Repository != nil && w.Repository.Local != "" && !e.exec.AllowLocal {
		return WorkflowRecord{}, invalid("local repositories are disabled by server policy")
	}
	if w.Sandbox != nil {
		if _, ok := e.exec.Sandboxes[w.Sandbox.Provider]; !ok {
			return WorkflowRecord{}, invalid("sandbox provider %q is not configured", w.Sandbox.Provider)
		}
	}
	for id, n := range w.Nodes {
		for _, name := range n.MCP {
			server, ok := e.exec.MCP[name]
			if !ok {
				return WorkflowRecord{}, invalid("%s: MCP server %q is not configured", id, name)
			}
			// A stdio server is a daemon-host executable; a remote agent can only
			// reach services over HTTP.
			if w.Sandbox != nil && server.Command != "" {
				return WorkflowRecord{}, invalid("%s: MCP server %q uses a daemon-host command; sandbox workflows require url servers", id, name)
			}
		}
		if n.Type == "llm" || (n.Type == "agent" && n.Provider == "openrouter") {
			if _, ok := e.exec.Providers[n.Provider]; !ok {
				return WorkflowRecord{}, invalid("%s: provider %q is not configured", id, n.Provider)
			}
		}
	}
	record := WorkflowRecord{ID: w.Name, Revision: digest([]byte(yaml)), YAML: yaml, Definition: w, UpdatedAt: now()}
	err = e.store.commit([]change{{"workflow", w.Name, record}}, nil, nil)
	return record, err
}

type SubmitRequest struct {
	WorkflowID string            `json:"workflow_id" minLength:"1"`
	Inputs     map[string]string `json:"inputs,omitempty"`
}

func makeRun(w Workflow, revision, automationID string, inputs map[string]string) Run {
	all := map[string]string{}
	for k, v := range w.Inputs {
		all[k] = v
	}
	for k, v := range inputs {
		all[k] = v
	}
	t := now()
	return Run{ID: newID(), Workflow: w, Revision: revision, AutomationID: automationID, Status: "queued", Current: w.Entry, Inputs: all, Outputs: map[string]Result{}, Visits: map[string]int{}, Attempts: []Attempt{}, CreatedAt: t, UpdatedAt: t}
}
func (e *Engine) Submit(req SubmitRequest, key string) (Run, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var existingID string
	b, _ := json.Marshal(req)
	dedupKey := ""
	if key != "" {
		dedupKey = "submit:" + key
	}
	if found, err := e.store.duplicate(dedupKey, digest(b), &existingID); err != nil {
		return Run{}, err
	} else if found {
		return get[Run](e.store, "run", existingID)
	}
	if e.closing || e.fault != nil {
		return Run{}, fmt.Errorf("%w: engine is not accepting runs", ErrConflict)
	}
	w, err := get[WorkflowRecord](e.store, "workflow", req.WorkflowID)
	if err != nil {
		return Run{}, err
	}
	r := makeRun(w.Definition, w.Revision, "", req.Inputs)
	err = e.store.commit([]change{{"run", r.ID, r}}, []eventWrite{{r.ID, "run.created", map[string]string{"workflow": w.ID, "revision": w.Revision}}}, &dedupWrite{dedupKey, digest(b), r.ID})
	return r, err
}
func (e *Engine) GetRun(id string) (Run, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return get[Run](e.store, "run", id)
}
func (e *Engine) Decide(id string, d Decision) (Run, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, err := get[Run](e.store, "run", id)
	if err != nil {
		return r, err
	}
	if r.Status != "waiting" || r.Question == nil || r.Question.ID != d.QuestionID {
		return r, fmt.Errorf("%w: question is no longer pending", ErrConflict)
	}
	if !slices.Contains(r.Question.Choices, d.Choice) {
		return r, invalid("choice is not one of the question's choices")
	}
	if d.CandidateID != "" && d.CandidateID != r.Question.CandidateID {
		return r, fmt.Errorf("%w: candidate changed", ErrConflict)
	}
	d.CandidateID = r.Question.CandidateID
	r.Decision = &d
	a := &r.Attempts[len(r.Attempts)-1]
	t := now()
	a.FinishedAt = &t
	a.Result = Result{Outcome: d.Choice, Output: d.Comment}
	r.Outputs[r.Current] = a.Result
	r.Status, r.Question = "queued", nil
	return r, e.saveRun(r, "human.answered", d)
}
func (e *Engine) Cancel(id string) (Run, error) {
	e.mu.Lock()
	r, err := get[Run](e.store, "run", id)
	if err != nil {
		e.mu.Unlock()
		return r, err
	}
	if r.Terminal() {
		e.mu.Unlock()
		return r, fmt.Errorf("%w: run is terminal", ErrConflict)
	}
	finalize := r.Status == "waiting" || (e.active[id] == nil && pendingAttempt(r))
	if finalize && len(r.Attempts) > 0 {
		a := &r.Attempts[len(r.Attempts)-1]
		if a.FinishedAt == nil {
			t := now()
			a.FinishedAt = &t
			a.Result = Result{Outcome: "canceled"}
			r.Outputs[a.Node] = a.Result
		}
	}
	r.Status, r.Question = "canceled", nil
	if err := e.saveRun(r, "run.canceled", map[string]string{"node": r.Current}); err != nil {
		e.mu.Unlock()
		return r, err
	}
	active := e.active[id] != nil
	if cancel := e.active[id]; cancel != nil {
		cancel()
	}
	e.mu.Unlock()
	if !active {
		// The owning goroutine settles active runs when it returns.
		defer e.settleSandbox(id)
	}
	if finalize {
		lease, err := acquireLease(e.exec.Root, r.ID)
		if err != nil {
			// The terminal state is durable. Cleanup will reconcile its audit
			// checkpoint once the prior process releases the workspace lease.
			slog.Warn("canceled checkpoint deferred until cleanup", "run_id", r.ID, "error", err)
			return r, nil
		}
		defer lease.Close()
		e.finishAttempt(context.WithValue(context.Background(), processLeaseKey{}, lease), r)
		return e.GetRun(id)
	}
	return r, nil
}

// settleSandbox stops a terminal run's machine so billing ends with the run.
// Waiting and interrupted runs keep theirs; the provider's idle auto-stop
// bounds that cost and the next node resumes it. Stop is an external call and
// runs outside the engine mutex; its outcome is journaled as an event.
func (e *Engine) settleSandbox(id string) {
	r, err := e.GetRun(id)
	if err != nil || r.Sandbox == nil || !r.Terminal() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	err = e.exec.StopSandbox(ctx, r)
	event, data := "sandbox.stopped", map[string]string{"sandbox": r.Sandbox.ID}
	if err != nil {
		event, data["error"] = "sandbox.stop_failed", err.Error()
		slog.Warn("sandbox stop failed; its idle auto-stop still applies", "run_id", id, "sandbox", r.Sandbox.ID, "error", err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	current, loadErr := get[Run](e.store, "run", id)
	if loadErr != nil {
		e.storageFailure(loadErr)
		return
	}
	if err := e.saveRun(current, event, data); err != nil {
		e.storageFailure(err)
	}
}
func (e *Engine) Retry(id string) (Run, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, err := get[Run](e.store, "run", id)
	if err != nil {
		return r, err
	}
	if _, active := e.active[id]; active || r.Cleaned || (r.Status != "failed" && r.Status != "interrupted") {
		return r, fmt.Errorf("%w: retry requires an inactive failed or interrupted run with its workspace retained", ErrConflict)
	}
	lease, err := acquireLease(e.exec.Root, r.ID)
	if err != nil {
		return r, err
	}
	lease.Close()
	r.Status, r.Error = "queued", ""
	return r, e.saveRun(r, "run.retried", map[string]string{"node": r.Current})
}
func (e *Engine) Cleanup(ctx context.Context, id string) (Run, error) {
	// Keep lifecycle operations serialized while removing the worktree.
	e.mu.Lock()
	defer e.mu.Unlock()
	r, err := get[Run](e.store, "run", id)
	if err != nil {
		return r, err
	}
	if _, active := e.active[id]; active || !r.Terminal() {
		return r, fmt.Errorf("%w: cleanup requires an inactive terminal run", ErrConflict)
	}
	if r.Cleaned || r.Workspace == "" {
		return r, nil
	}
	lease, err := acquireLease(e.exec.Root, r.ID)
	if err != nil {
		return r, err
	}
	defer lease.Close()
	// Reconcile canceled/interrupted terminal attempts before removing their tree.
	if len(r.Attempts) > 0 && !r.Attempts[len(r.Attempts)-1].Finalized {
		a := &r.Attempts[len(r.Attempts)-1]
		if a.FinishedAt == nil {
			t := now()
			a.FinishedAt = &t
			a.Result = Result{Outcome: "canceled"}
		}
		sha, err := e.exec.Checkpoint(ctx, r, *a)
		if err != nil {
			return r, err
		}
		a.CheckpointSHA, a.Finalized = sha, true
		if err := e.saveRun(r, "node.finished", a); err != nil {
			return r, err
		}
	}
	data := map[string]string{"workspace": r.Workspace}
	if r.Sandbox != nil {
		if err := e.exec.DeleteSandbox(ctx, r); err != nil {
			return r, fmt.Errorf("delete sandbox %s: %w", r.Sandbox.ID, err)
		}
		data["sandbox"] = r.Sandbox.ID
	}
	if err := e.exec.Cleanup(ctx, r); err != nil {
		return r, err
	}
	r.Cleaned = true
	return r, e.saveRun(r, "workspace.cleaned", data)
}
