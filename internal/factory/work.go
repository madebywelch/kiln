package factory

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type WorkHandoff struct {
	Progress         string `json:"progress,omitempty" maxLength:"8192"`
	FailedApproaches string `json:"failed_approaches,omitempty" maxLength:"8192"`
	Blockers         string `json:"blockers,omitempty" maxLength:"8192"`
	NextAction       string `json:"next_action,omitempty" maxLength:"8192"`
}

type WorkItem struct {
	ID                 string          `json:"id"`
	Title              string          `json:"title"`
	Objective          string          `json:"objective"`
	AcceptanceCriteria []string        `json:"acceptance_criteria"`
	Dependencies       []string        `json:"dependencies"`
	Status             string          `json:"status" enum:"open,completed,canceled"`
	Revision           int             `json:"revision"`
	Handoff            WorkHandoff     `json:"handoff"`
	LatestRunID        string          `json:"latest_run_id,omitempty"`
	Completion         *WorkCompletion `json:"completion,omitempty"`
	CancelReason       string          `json:"cancel_reason,omitempty"`
	CreatedAt          time.Time       `json:"created_at"`
	UpdatedAt          time.Time       `json:"updated_at"`
}

type CreateWorkRequest struct {
	Title              string      `json:"title" minLength:"1" maxLength:"200"`
	Objective          string      `json:"objective" minLength:"1" maxLength:"16384"`
	AcceptanceCriteria []string    `json:"acceptance_criteria" minItems:"1" maxItems:"32"`
	Dependencies       []string    `json:"dependencies,omitempty" maxItems:"32"`
	Handoff            WorkHandoff `json:"handoff,omitempty"`
}

type UpdateWorkHandoffRequest struct {
	ExpectedRevision int         `json:"expected_revision" minimum:"1"`
	Handoff          WorkHandoff `json:"handoff"`
}

type WorkEvidenceRef struct {
	Criterion int    `json:"criterion" minimum:"1" maximum:"32"`
	AttemptID string `json:"attempt_id" minLength:"1"`
}

type CompleteWorkRequest struct {
	ExpectedRevision int               `json:"expected_revision" minimum:"1"`
	RunID            string            `json:"run_id" minLength:"1"`
	Approve          bool              `json:"approve"`
	Summary          string            `json:"summary" minLength:"1" maxLength:"8192"`
	Evidence         []WorkEvidenceRef `json:"evidence" minItems:"1" maxItems:"32"`
}

type WorkEvidence struct {
	Criterion     int    `json:"criterion"`
	AttemptID     string `json:"attempt_id"`
	Node          string `json:"node"`
	CheckpointSHA string `json:"checkpoint_sha,omitempty"`
	CandidateID   string `json:"candidate_id,omitempty"`
}

type WorkCompletion struct {
	RunID       string         `json:"run_id"`
	Summary     string         `json:"summary"`
	Evidence    []WorkEvidence `json:"evidence"`
	CompletedAt time.Time      `json:"completed_at"`
}

type CancelWorkRequest struct {
	ExpectedRevision int    `json:"expected_revision" minimum:"1"`
	Reason           string `json:"reason" minLength:"1" maxLength:"8192"`
}

type WorkRunEvidence struct {
	ID              string     `json:"id"`
	Status          string     `json:"status"`
	Current         string     `json:"current"`
	Error           string     `json:"error,omitempty"`
	CheckpointSHA   string     `json:"checkpoint_sha,omitempty"`
	ResultNode      string     `json:"result_node,omitempty"`
	ResultAttemptID string     `json:"result_attempt_id,omitempty"`
	Result          *Result    `json:"result,omitempty"`
	Candidate       *Candidate `json:"candidate,omitempty"`
}

type WorkContext struct {
	ID                 string           `json:"id"`
	Revision           int              `json:"revision"`
	Title              string           `json:"title"`
	Objective          string           `json:"objective"`
	AcceptanceCriteria []string         `json:"acceptance_criteria"`
	Dependencies       []string         `json:"dependencies"`
	Handoff            WorkHandoff      `json:"handoff"`
	PreviousRun        *WorkRunEvidence `json:"previous_run,omitempty"`
}

type WorkEvent struct {
	ID     int64           `json:"id"`
	WorkID string          `json:"work_id"`
	Type   string          `json:"type"`
	Time   time.Time       `json:"time"`
	Data   json.RawMessage `json:"data"`
}

func validateHandoff(h WorkHandoff) error {
	for _, value := range []string{h.Progress, h.FailedApproaches, h.Blockers, h.NextAction} {
		if len(value) > 8192 {
			return invalid("handoff fields must be at most 8192 bytes")
		}
	}
	return nil
}

func (e *Engine) CreateWork(req CreateWorkRequest, key string) (WorkItem, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	b, err := json.Marshal(req)
	if err != nil {
		return WorkItem{}, err
	}
	dedupKey := ""
	if key != "" {
		dedupKey = "work:create:" + key
	}
	var id string
	if found, err := e.store.duplicate(dedupKey, digest(b), &id); err != nil {
		return WorkItem{}, err
	} else if found {
		return get[WorkItem](e.store, "work", id)
	}
	if e.closing || e.fault != nil {
		return WorkItem{}, fmt.Errorf("%w: engine is not accepting work", ErrConflict)
	}
	if strings.TrimSpace(req.Title) == "" || len(req.Title) > 200 || strings.TrimSpace(req.Objective) == "" || len(req.Objective) > 16384 {
		return WorkItem{}, invalid("work requires a title of at most 200 bytes and an objective of at most 16384 bytes")
	}
	if len(req.AcceptanceCriteria) < 1 || len(req.AcceptanceCriteria) > 32 || len(req.Dependencies) > 32 {
		return WorkItem{}, invalid("work requires 1-32 acceptance criteria and at most 32 dependencies")
	}
	for _, criterion := range req.AcceptanceCriteria {
		if strings.TrimSpace(criterion) == "" || len(criterion) > 2048 {
			return WorkItem{}, invalid("each acceptance criterion must be nonempty and at most 2048 bytes")
		}
	}
	if err := validateHandoff(req.Handoff); err != nil {
		return WorkItem{}, err
	}
	seen := map[string]bool{}
	for _, dependency := range req.Dependencies {
		if dependency == "" || seen[dependency] {
			return WorkItem{}, invalid("dependencies must be distinct existing work IDs")
		}
		seen[dependency] = true
		blocker, err := get[WorkItem](e.store, "work", dependency)
		if err != nil {
			return WorkItem{}, err
		}
		if blocker.Status == "canceled" {
			return WorkItem{}, fmt.Errorf("%w: dependency %s is canceled", ErrConflict, dependency)
		}
	}
	t := now()
	work := WorkItem{ID: newID(), Title: req.Title, Objective: req.Objective, AcceptanceCriteria: append([]string{}, req.AcceptanceCriteria...), Dependencies: append([]string{}, req.Dependencies...), Status: "open", Revision: 1, Handoff: req.Handoff, CreatedAt: t, UpdatedAt: t}
	err = e.store.commit([]change{{"work", work.ID, work}}, []eventWrite{{"work:" + work.ID, "work.created", work}}, &dedupWrite{dedupKey, digest(b), work.ID})
	return work, err
}

func (e *Engine) GetWork(id string) (WorkItem, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return get[WorkItem](e.store, "work", id)
}

func (e *Engine) openWork(id string, revision int) (WorkItem, error) {
	work, err := get[WorkItem](e.store, "work", id)
	if err != nil {
		return work, err
	}
	if work.Status != "open" || work.Revision != revision {
		return work, fmt.Errorf("%w: work is closed or its revision changed", ErrConflict)
	}
	if e.closing || e.fault != nil {
		return work, fmt.Errorf("%w: engine is not accepting work changes", ErrConflict)
	}
	return work, nil
}

func (e *Engine) workReady(work WorkItem) error {
	for _, id := range work.Dependencies {
		dependency, err := get[WorkItem](e.store, "work", id)
		if err != nil {
			return err
		}
		if dependency.Status != "completed" {
			return fmt.Errorf("%w: dependency %s is not completed", ErrConflict, id)
		}
	}
	return nil
}

func (e *Engine) inactiveWorkRun(work WorkItem) (*Run, error) {
	if work.LatestRunID == "" {
		return nil, nil
	}
	r, err := get[Run](e.store, "run", work.LatestRunID)
	if err != nil {
		return nil, err
	}
	if r.WorkID != work.ID {
		return nil, fmt.Errorf("%w: latest run is not linked to this work", ErrConflict)
	}
	if e.active[r.ID] != nil || !r.Terminal() {
		return nil, fmt.Errorf("%w: work already has an active, waiting, or interrupted run", ErrConflict)
	}
	lease, err := acquireLease(e.exec.Root, r.ID)
	if err != nil {
		return nil, err
	}
	lease.Close()
	return &r, nil
}

func (e *Engine) UpdateWorkHandoff(id string, req UpdateWorkHandoffRequest) (WorkItem, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	work, err := e.openWork(id, req.ExpectedRevision)
	if err != nil {
		return work, err
	}
	if err := validateHandoff(req.Handoff); err != nil {
		return work, err
	}
	work.Handoff, work.UpdatedAt = req.Handoff, now()
	work.Revision++
	return work, e.store.commit([]change{{"work", id, work}}, []eventWrite{{"work:" + id, "work.handoff", map[string]any{"revision": work.Revision, "handoff": work.Handoff}}}, nil)
}

func (e *Engine) CompleteWork(id string, req CompleteWorkRequest) (WorkItem, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	work, err := e.openWork(id, req.ExpectedRevision)
	if err != nil {
		return work, err
	}
	if !req.Approve || strings.TrimSpace(req.Summary) == "" || len(req.Summary) > 8192 || len(req.Evidence) != len(work.AcceptanceCriteria) {
		return work, invalid("completion requires explicit approval, a summary, and evidence for every acceptance criterion")
	}
	if err := e.workReady(work); err != nil {
		return work, err
	}
	r, err := e.inactiveWorkRun(work)
	if err != nil {
		return work, err
	}
	if r == nil || r.ID != req.RunID || r.WorkID != work.ID || r.Status != "succeeded" {
		return work, fmt.Errorf("%w: completion requires the latest linked run to have succeeded", ErrConflict)
	}
	evidence := make([]WorkEvidence, len(work.AcceptanceCriteria))
	for _, ref := range req.Evidence {
		if ref.Criterion < 1 || ref.Criterion > len(evidence) || evidence[ref.Criterion-1].AttemptID != "" {
			return work, invalid("evidence must reference each acceptance criterion exactly once")
		}
		var attempt *Attempt
		for i := range r.Attempts {
			if r.Attempts[i].ID == ref.AttemptID {
				attempt = &r.Attempts[i]
				break
			}
		}
		if attempt == nil || !attempt.Finalized || attempt.FinishedAt == nil || attempt.Result.Outcome != "success" {
			return work, invalid("evidence must reference a successful finalized verification attempt in the completion run")
		}
		node := r.Workflow.Nodes[attempt.Node]
		if node.Type != "command" && node.Type != "changeset" {
			return work, invalid("completion evidence must come from command or changeset verification, not an agent's self-report")
		}
		item := WorkEvidence{Criterion: ref.Criterion, AttemptID: attempt.ID, Node: attempt.Node, CheckpointSHA: attempt.CheckpointSHA}
		if node.Type == "changeset" {
			if attempt.Result.Candidate == nil || r.Candidate == nil || attempt.Result.Candidate.ID != r.Candidate.ID {
				return work, fmt.Errorf("%w: verification candidate is no longer current", ErrConflict)
			}
			item.CandidateID = r.Candidate.ID
		}
		evidence[ref.Criterion-1] = item
	}
	work.Status, work.UpdatedAt = "completed", now()
	work.Revision++
	work.Completion = &WorkCompletion{RunID: r.ID, Summary: req.Summary, Evidence: evidence, CompletedAt: work.UpdatedAt}
	return work, e.store.commit([]change{{"work", id, work}}, []eventWrite{{"work:" + id, "work.completed", work.Completion}}, nil)
}

func (e *Engine) CancelWork(id string, req CancelWorkRequest) (WorkItem, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	work, err := e.openWork(id, req.ExpectedRevision)
	if err != nil {
		return work, err
	}
	if strings.TrimSpace(req.Reason) == "" || len(req.Reason) > 8192 {
		return work, invalid("canceling work requires a reason of at most 8192 bytes")
	}
	if _, err := e.inactiveWorkRun(work); err != nil {
		return work, err
	}
	work.Status, work.CancelReason, work.UpdatedAt = "canceled", req.Reason, now()
	work.Revision++
	return work, e.store.commit([]change{{"work", id, work}}, []eventWrite{{"work:" + id, "work.canceled", map[string]string{"reason": req.Reason}}}, nil)
}

func (e *Engine) ListWorkRuns(id string, limit, offset int) ([]Run, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, err := get[WorkItem](e.store, "work", id); err != nil {
		return nil, err
	}
	rows, err := e.store.db.Query("SELECT data FROM documents WHERE kind='run' AND json_extract(data,'$.work_id')=? ORDER BY json_extract(data,'$.created_at'),id LIMIT ? OFFSET ?", id, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []Run{}
	for rows.Next() {
		var data string
		var r Run
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(data), &r); err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, rows.Err()
}

func (e *Engine) WorkEvents(id string, after int64, limit int) ([]WorkEvent, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, err := get[WorkItem](e.store, "work", id); err != nil {
		return nil, err
	}
	events, err := e.store.Events("work:"+id, after, limit)
	if err != nil {
		return nil, err
	}
	result := make([]WorkEvent, 0, len(events))
	for _, event := range events {
		result = append(result, WorkEvent{ID: event.ID, WorkID: id, Type: event.Type, Time: event.Time, Data: event.Data})
	}
	return result, nil
}
