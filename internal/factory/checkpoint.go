package factory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Every finished repository stage gets an audit commit, including failures and
// unchanged trees. The run branch and immutable audit ref move atomically.
// This is an audit trail, not a declaration that the contents passed checks.
func (x *Executor) Checkpoint(ctx context.Context, r Run, a Attempt) (string, error) {
	if r.Workflow.Repository == nil {
		return "", nil
	}
	x.gitMu.Lock()
	defer x.gitMu.Unlock()
	if a.FinishedAt == nil {
		return "", errors.New("cannot checkpoint an unfinished attempt")
	}
	branch, err := git(ctx, r.Workspace, "symbolic-ref", "HEAD")
	if err != nil {
		return "", err
	}
	if r.Branch != "kiln/"+r.ID || branch != "refs/heads/"+r.Branch {
		return "", errors.New("workspace branch changed; refusing checkpoint")
	}
	ref := "refs/kiln/checkpoints/" + r.ID + "/" + a.ID
	if sha, err := git(ctx, r.Workspace, "show-ref", "--verify", "--hash", ref); err == nil {
		head, err := git(ctx, r.Workspace, "rev-parse", "HEAD")
		if err != nil {
			return "", err
		}
		dirty, err := git(ctx, r.Workspace, "status", "--porcelain")
		if err != nil {
			return "", err
		}
		if head != sha || dirty != "" {
			return "", errors.New("workspace changed after checkpoint; inspect before retrying")
		}
		return sha, nil
	}
	parent, err := git(ctx, r.Workspace, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if _, err := git(ctx, r.Workspace, "add", "-A", "--", "."); err != nil {
		return "", err
	}
	tree, err := git(ctx, r.Workspace, "write-tree")
	if err != nil {
		return "", err
	}
	message := fmt.Sprintf("chore(kiln): checkpoint %s (%s)\n\nRun: %s\nAttempt: %s\nFinished: %s", a.Node, a.Result.Outcome, r.ID, a.ID, a.FinishedAt.UTC().Format(time.RFC3339Nano))
	sha, err := git(ctx, r.Workspace, "commit-tree", tree, "-p", parent, "-m", message)
	if err != nil {
		return "", err
	}
	transaction := fmt.Sprintf("start\ncreate %s %s\nupdate %s %s %s\nprepare\ncommit\n", ref, sha, branch, sha, parent)
	if _, err := gitInput(ctx, r.Workspace, transaction, "update-ref", "--stdin"); err != nil {
		return "", err
	}
	return sha, nil
}

func pendingAttempt(r Run) bool {
	return len(r.Attempts) > 0 && !r.Attempts[len(r.Attempts)-1].Finalized && r.Attempts[len(r.Attempts)-1].FinishedAt != nil
}

// The external result is already durable here. A crash may replay checkpoint
// reconciliation, but never the command/model/PR operation that produced it.
// Caller holds the run's filesystem execution lease, not the engine mutex.
func (e *Engine) finishAttempt(ctx context.Context, r Run) {
	a := r.Attempts[len(r.Attempts)-1]
	checkpointCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	sha, checkpointErr := e.exec.Checkpoint(checkpointCtx, r, a)
	cancel()
	e.mu.Lock()
	defer e.mu.Unlock()
	current, err := get[Run](e.store, "run", r.ID)
	if err != nil {
		e.storageFailure(err)
		return
	}
	if checkpointErr != nil {
		if current.Status != "canceled" {
			current.Status = "interrupted"
		}
		current.Error = "checkpoint failed; retry reconciles without rerunning the stage: " + checkpointErr.Error()
		if err := e.saveRun(current, "checkpoint.failed", map[string]string{"error": current.Error}); err != nil {
			e.storageFailure(err)
		}
		return
	}
	last := &current.Attempts[len(current.Attempts)-1]
	if last.ID != a.ID || last.Finalized {
		e.storageFailure(errors.New("attempt changed during checkpoint"))
		return
	}
	last.CheckpointSHA, last.Finalized = sha, true
	n := current.Workflow.Nodes[last.Node]
	if current.Status == "running" || current.Status == "queued" {
		if last.Result.Outcome == "interrupted" {
			current.Status, current.Error = "queued", ""
		} else if n.Type == "end" {
			current.Status, current.Error = "succeeded", ""
		} else if next := n.Next[last.Result.Outcome]; next != "" {
			current.Status, current.Current, current.Error = "queued", next, ""
		} else {
			current.Status, current.Error = "failed", last.Result.Error
			if strings.TrimSpace(current.Error) == "" {
				current.Error = "node failed without a matching edge"
			}
		}
	}
	if err := e.saveRun(current, "node.finished", map[string]any{"attempt": last, "status": current.Status, "next": current.Current}); err != nil {
		e.storageFailure(err)
	}
}
