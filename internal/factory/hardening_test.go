package factory

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestChildLeaseSurvivesParentDescriptorAndBlocksRetry(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	r := makeRun(basicWorkflow(), "rev", "", nil)
	r.Status = "interrupted"
	if err := e.store.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	lease, err := acquireLease(e.exec.Root, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command("sleep", "10")
	child.ExtraFiles = []*os.File{lease}
	if err := child.Start(); err != nil {
		lease.Close()
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Retry(r.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("retry ignored a surviving child: %v", err)
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	if _, err := e.Retry(r.ID); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" {
		t.Fatal(r.Status)
	}
}
func TestLeaseWaitsForTransientInheritedDescriptors(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	first, err := acquireLease(root, "run")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { time.Sleep(25 * time.Millisecond); first.Close(); close(done) }()
	second, err := acquireLease(root, "run")
	<-done
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
}

func TestLargeContextDoesNotExceedExecEnvironmentLimit(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	x := Executor{Root: dir}
	r := makeRun(basicWorkflow(), "rev", "", nil)
	r.Workspace = t.TempDir()
	for _, key := range []string{"one", "two", "three", "four"} {
		r.Outputs[key] = Result{Output: strings.Repeat("x", outputLimit)}
	}
	got := x.Execute(context.Background(), r, Node{Type: "command", Command: "wc -c < \"$KILN_CONTEXT_FILE\""})
	if got.Outcome != "success" {
		t.Fatalf("%+v", got)
	}
	size, err := strconv.Atoi(strings.TrimSpace(got.Output))
	if err != nil || size < 4*outputLimit {
		t.Fatalf("context incomplete: %+v", got)
	}
	files, err := os.ReadDir(filepath.Join(dir, "contexts"))
	if err != nil || len(files) != 0 {
		t.Fatal("temporary context not removed")
	}
	got = x.Execute(context.Background(), r, Node{Type: "command", Command: "true", Env: map[string]string{"HUGE": strings.Repeat("x", outputLimit+1)}})
	if !strings.Contains(got.Error, "KILN_CONTEXT_FILE") {
		t.Fatal("oversized env did not produce an actionable error")
	}
}
func TestPersistenceFailureStopsDispatchAndIsNotValidationError(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	w := basicWorkflow()
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
	_, err := e.store.db.Exec("CREATE TRIGGER fail_updates BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END")
	if err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: w.Name}, "")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		fault := e.fault
		e.mu.Unlock()
		if fault != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("storage failure did not stop dispatch")
		}
		time.Sleep(time.Millisecond)
	}
	got, err := e.GetRun(r.ID)
	if err != nil || got.Status != "queued" || got.Prepared {
		t.Fatal("execution escaped failed checkpoint")
	}
	if _, err := e.Submit(SubmitRequest{WorkflowID: w.Name}, ""); !errors.Is(err, ErrConflict) {
		t.Fatal("unhealthy engine accepted run")
	}
	if _, err := e.Trigger(TriggerRequest{Name: "x"}, ""); !errors.Is(err, ErrConflict) {
		t.Fatal("unhealthy engine accepted event")
	}
	request(t, NewAPI(e, APIConfig{Token: testToken}), "POST", "/v1/workflows", map[string]string{"yaml": workflowYAML(t, w)}, nil, 500)
}
func TestGitCleanupCanFinishAfterCheckpointLoss(t *testing.T) {
	t.Parallel()
	source := seedRepo(t)
	x := Executor{Root: t.TempDir(), AllowLocal: true}
	w := basicWorkflow()
	w.Repository = &Repository{Local: source}
	r, err := x.Prepare(context.Background(), makeRun(w, "rev", "", nil))
	if err != nil {
		t.Fatal(err)
	}
	if err := x.Cleanup(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	// Filesystem removal committed but the run checkpoint did not: replay cleanup.
	if err := x.Cleanup(context.Background(), r); err != nil {
		t.Fatal(err)
	}
}
func TestExistingPRMustBeOpen(t *testing.T) {
	t.Parallel()
	for _, state := range []string{"CLOSED", "MERGED", ""} {
		if _, err := existingPR(`[{"url":"https://github.com/a/b/pull/1","state":"` + state + `"}]`); err == nil {
			t.Fatalf("accepted %q PR", state)
		}
	}
	if url, err := existingPR(`[{"url":"https://github.com/a/b/pull/1","state":"OPEN"}]`); err != nil || url == "" {
		t.Fatalf("%q %v", url, err)
	}
	if url, err := existingPR(`[]`); err != nil || url != "" {
		t.Fatal("empty list was not accepted")
	}
	if _, err := existingPR(`bad-json`); err == nil {
		t.Fatal("malformed response accepted")
	}
}
func TestAllPushURLsAreVerified(t *testing.T) {
	t.Parallel()
	source := seedRepo(t)
	ctx := context.Background()
	for _, args := range [][]string{
		{"remote", "add", "origin", "https://github.com/a/b.git"},
		{"config", "--add", "remote.origin.pushurl", "https://github.com/a/b.git"},
		{"config", "--add", "remote.origin.pushurl", "https://gitea.invalid/a/b.git"},
	} {
		if _, err := git(ctx, source, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := verifyOrigin(ctx, source, "https://github.com/a/b.git"); err == nil {
		t.Fatal("additional push destination bypassed routing policy")
	}
}
func TestProviderURLValidation(t *testing.T) {
	for _, url := range []string{"file:///tmp/socket", "https://token@example.com/v1", "https://example.com/v1?token=secret", "https://example.com/v1#fragment", "relative"} {
		if err := ValidateProviders(map[string]Provider{"bad": {URL: url}}); err == nil {
			t.Fatalf("accepted provider URL %q", url)
		}
	}
	if err := ValidateProviders(map[string]Provider{"ok": {URL: "https://openrouter.ai/api/v1"}}); err != nil {
		t.Fatal(err)
	}
}
