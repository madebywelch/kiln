package factory

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type AutomationRequest struct {
	WorkflowID       string            `json:"workflow_id" minLength:"1"`
	Schedule         string            `json:"schedule,omitempty"`
	Event            string            `json:"event,omitempty"`
	GitHubRepository string            `json:"github_repository,omitempty"`
	Enabled          bool              `json:"enabled"`
	Inputs           map[string]string `json:"inputs,omitempty"`
}

func parseSchedule(spec string) (cron.Schedule, error) {
	if len(strings.Fields(spec)) != 5 {
		return nil, errors.New("schedule must be a five-field UTC cron expression")
	}
	return cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(spec)
}
func (e *Engine) PutAutomation(id string, req AutomationRequest) (Automation, error) {
	if !namePattern.MatchString(id) {
		return Automation{}, invalid("invalid automation ID")
	}
	if (req.Schedule == "") == (req.Event == "") {
		return Automation{}, invalid("exactly one of schedule or event is required")
	}
	if strings.HasPrefix(req.Event, "github.") && !repoPattern.MatchString(req.GitHubRepository) {
		return Automation{}, invalid("GitHub event automations require github_repository (owner/repo)")
	}
	if req.GitHubRepository != "" && !strings.HasPrefix(req.Event, "github.") {
		return Automation{}, invalid("github_repository applies only to github.* events")
	}
	var next *time.Time
	if req.Schedule != "" {
		s, err := parseSchedule(req.Schedule)
		if err != nil {
			return Automation{}, invalid("%s", err)
		}
		t := s.Next(now())
		if t.IsZero() {
			return Automation{}, invalid("cron expression has no next occurrence")
		}
		next = &t
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	w, err := get[WorkflowRecord](e.store, "workflow", req.WorkflowID)
	if err != nil {
		return Automation{}, err
	}
	a := Automation{ID: id, WorkflowID: w.ID, Revision: w.Revision, Workflow: w.Definition, Schedule: req.Schedule, Event: req.Event, GitHubRepository: req.GitHubRepository, Enabled: req.Enabled, Inputs: req.Inputs, NextAt: next, CreatedAt: now(), UpdatedAt: now()}
	old, err := get[Automation](e.store, "automation", id)
	if err == nil {
		a.CreatedAt = old.CreatedAt
		a.LastRunID, a.LastFiredAt, a.LastSkippedAt = old.LastRunID, old.LastFiredAt, old.LastSkippedAt
	} else if !errors.Is(err, ErrNotFound) {
		return a, err
	}
	return a, e.store.commit([]change{{"automation", id, a}}, nil, nil)
}
func (e *Engine) automationBusy(id string) (bool, error) {
	var count int
	err := e.store.db.QueryRow("SELECT count(*) FROM documents WHERE kind='run' AND json_extract(data,'$.automation_id')=? AND json_extract(data,'$.status') NOT IN ('succeeded','failed','canceled')", id).Scan(&count)
	return count > 0, err
}
func (e *Engine) schedule(at time.Time) error {
	as, err := list[Automation](e.store, "automation", "", -1, 0)
	if err != nil {
		return err
	}
	for _, a := range as {
		if !a.Enabled || a.NextAt == nil || a.NextAt.After(at) {
			continue
		}
		s, err := parseSchedule(a.Schedule)
		if err != nil {
			return err
		}
		next := s.Next(at)
		a.NextAt, a.UpdatedAt = &next, at
		changes := []change{}
		events := []eventWrite{}
		busy, err := e.automationBusy(a.ID)
		if err != nil {
			return err
		}
		if !busy {
			r := makeRun(a.Workflow, a.Revision, a.ID, a.Inputs)
			a.LastRunID, a.LastFiredAt = r.ID, &at
			changes = append(changes, change{"run", r.ID, r})
			events = append(events, eventWrite{r.ID, "run.created", map[string]string{"automation": a.ID, "trigger": "schedule"}})
		}
		if busy {
			a.LastSkippedAt = &at
		}
		changes = append(changes, change{"automation", a.ID, a})
		// Advance the cursor atomically with run creation. Missed ticks coalesce.
		if err := e.store.commit(changes, events, nil); err != nil {
			return err
		}
	}
	return nil
}
func (e *Engine) Fire(id, key string) (Run, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closing || e.fault != nil {
		return Run{}, fmt.Errorf("%w: engine is not accepting runs", ErrConflict)
	}
	dk := ""
	if key != "" {
		dk = "fire:" + id + ":" + key
	}
	var old string
	if found, err := e.store.duplicate(dk, id, &old); err != nil {
		return Run{}, err
	} else if found {
		return get[Run](e.store, "run", old)
	}
	a, err := get[Automation](e.store, "automation", id)
	if err != nil {
		return Run{}, err
	}
	if !a.Enabled {
		return Run{}, fmt.Errorf("%w: automation is disabled", ErrConflict)
	}
	if busy, err := e.automationBusy(id); err != nil {
		return Run{}, err
	} else if busy {
		return Run{}, fmt.Errorf("%w: automation already has an active run", ErrConflict)
	}
	r := makeRun(a.Workflow, a.Revision, id, a.Inputs)
	t := now()
	a.LastRunID, a.LastFiredAt, a.UpdatedAt = r.ID, &t, t
	err = e.store.commit([]change{{"run", r.ID, r}, {"automation", a.ID, a}}, []eventWrite{{r.ID, "run.created", map[string]string{"automation": id, "trigger": "manual"}}}, &dedupWrite{dk, id, r.ID})
	return r, err
}

type TriggerRequest struct {
	Name       string            `json:"name" minLength:"1"`
	Inputs     map[string]string `json:"inputs,omitempty"`
	Repository string            `json:"repository,omitempty"`
}
type TriggerResult struct {
	RunIDs  []string `json:"run_ids"`
	Skipped []string `json:"skipped"`
}

func (e *Engine) Trigger(req TriggerRequest, key string) (TriggerResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	result := TriggerResult{RunIDs: []string{}, Skipped: []string{}}
	if e.closing || e.fault != nil {
		return result, fmt.Errorf("%w: engine is not accepting events", ErrConflict)
	}
	b, _ := json.Marshal(req)
	fingerprint := digest(b)
	dk := ""
	if key != "" {
		dk = "event:" + key
	}
	if found, err := e.store.duplicate(dk, fingerprint, &result); err != nil || found {
		return result, err
	}
	as, err := list[Automation](e.store, "automation", "", -1, 0)
	if err != nil {
		return result, err
	}
	changes := []change{}
	events := []eventWrite{}
	for _, a := range as {
		if !a.Enabled || a.Event != req.Name || (a.GitHubRepository != "" && !strings.EqualFold(a.GitHubRepository, req.Repository)) {
			continue
		}
		if busy, err := e.automationBusy(a.ID); err != nil {
			return result, err
		} else if busy {
			result.Skipped = append(result.Skipped, a.ID)
			t := now()
			a.LastSkippedAt, a.UpdatedAt = &t, t
			changes = append(changes, change{"automation", a.ID, a})
			continue
		}
		inputs := map[string]string{}
		for k, v := range a.Inputs {
			inputs[k] = v
		}
		for k, v := range req.Inputs {
			inputs[k] = v
		}
		r := makeRun(a.Workflow, a.Revision, a.ID, inputs)
		result.RunIDs = append(result.RunIDs, r.ID)
		t := now()
		a.LastRunID, a.LastFiredAt, a.UpdatedAt = r.ID, &t, t
		changes = append(changes, change{"run", r.ID, r}, change{"automation", a.ID, a})
		events = append(events, eventWrite{r.ID, "run.created", map[string]string{"automation": a.ID, "trigger": req.Name}})
	}
	err = e.store.commit(changes, events, &dedupWrite{dk, fingerprint, result})
	return result, err
}
