package factory

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func agent37Engine(t *testing.T, f *fakeAgent37, configure func(*Executor)) *Engine {
	t.Helper()
	return testEngine(t, func(x *Executor) {
		x.Sandboxes = f.provider()
		if configure != nil {
			configure(x)
		}
	})
}
func agent37Workflow(t *testing.T) Workflow {
	t.Helper()
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t), Base: "main"}
	w.Sandbox = &Sandbox{Provider: "agent37", Type: "default", Resources: &SandboxResources{CPU: 2, Memory: 4, Disk: 6}, Region: "us"}
	return w
}

func TestAgent37RunExecutesRemotelyAndSyncsCheckpoints(t *testing.T) {
	t.Setenv("KILN_TEST_SECRET", "daemon-only")
	f := newFakeAgent37(t)
	e := agent37Engine(t, f, nil)
	w := agent37Workflow(t)
	big := strings.Repeat("x", 3*agent37Chunk+17)
	w.Nodes["work"] = Node{Type: "command", Env: map[string]string{"GOAL": "{{ .inputs.goal }}"}, Command: strings.Join([]string{
		`test -z "${KILN_TEST_SECRET-}"`,
		`test -z "${AGENT37_INSTANCE_ID-}"`,
		`test "$GOAL" = 'literal $(echo wrong)'`,
		`test "$HOME" = ` + shQuote(f.home),
		`test "$PWD" = "$KILN_WORKSPACE"`,
		`printf changed > file.txt`,
		`printf new > added.txt`,
		`printf report > "$KILN_ARTIFACT_DIR/report.md"`,
		`printf 'noise\n' >&2`,
		`printf '%s' "$(cat "$KILN_ARTIFACT_DIR/big.txt")"`,
	}, " && "), Next: map[string]string{"success": "verify"}}
	w.Nodes["verify"] = Node{Type: "command", Command: `test "$(cat file.txt)" = changed && test "$(cat added.txt)" = new && test "$(cat "$KILN_ARTIFACT_DIR/report.md")" = report && rm added.txt && exit 3`, Next: map[string]string{"success": "end", "failure": "end"}}
	w.Inputs = map[string]string{"goal": "literal $(echo wrong)"}
	record, err := e.Register(workflowYAML(t, w), "")
	if err != nil {
		t.Fatal(err)
	}
	r, err := e.Submit(SubmitRequest{WorkflowID: record.ID}, "")
	if err != nil {
		t.Fatal(err)
	}
	// An artifact larger than one poll chunk proves chunked output delivery.
	r = waitRun(t, e, r.ID, func(r Run) bool { return r.Artifacts != "" })
	if err := os.WriteFile(filepath.Join(r.Artifacts, "big.txt"), []byte(big), 0600); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" {
		t.Fatalf("%s %s %+v", r.Status, r.Error, r.Outputs)
	}
	if r.Sandbox == nil || r.Sandbox.Provider != "agent37" || r.Sandbox.Home != f.home || r.Sandbox.URL == "" || r.Sandbox.Type != "agent37-pi" {
		t.Fatalf("sandbox not recorded: %+v", r.Sandbox)
	}
	work, verify := r.Outputs["work"], r.Outputs["verify"]
	// Command output crosses several poll chunks and is then bounded as on the host.
	if work.Outcome != "success" || !work.Truncated || len(work.Output) != outputLimit || work.Sandbox != r.Sandbox.ID {
		t.Fatalf("output not delivered: outcome=%s len=%d truncated=%v sandbox=%s", work.Outcome, len(work.Output), work.Truncated, work.Sandbox)
	}
	if verify.Outcome != "failure" || verify.ExitCode != 3 {
		t.Fatalf("%+v", verify)
	}
	if b, err := os.ReadFile(filepath.Join(r.Workspace, "file.txt")); err != nil || string(b) != "changed" {
		t.Fatalf("worktree not synchronized: %s %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(r.Workspace, "added.txt")); !os.IsNotExist(err) {
		t.Fatal("remote deletion not synchronized")
	}
	for _, a := range r.Attempts {
		if !a.Finalized || a.CheckpointSHA == "" {
			t.Fatalf("attempt lacks checkpoint: %+v", a)
		}
	}
	waitEvent(t, e, r.ID, "sandbox.stopped")
	f.mu.Lock()
	create, stops := f.creates[0], f.stops
	f.mu.Unlock()
	if create["template"] != "agent37-pi" || create["auto_sleep"] != true || create["idle_timeout_seconds"] != float64(600) || create["type"] != "default" || create["region"] != "us" {
		t.Fatalf("unexpected create request: %v", create)
	}
	if res, _ := create["resources"].(map[string]any); res["cpu"] != float64(2) || res["memory"] != float64(4) || res["disk"] != float64(6) {
		t.Fatalf("resources not forwarded: %v", create)
	}
	if env, _ := create["env"].(map[string]any); env["KILN_RUN_ID"] != r.ID {
		t.Fatalf("instance not tagged with the run: %v", create)
	}
	if stops != 1 || f.status() != "stopped" {
		t.Fatalf("terminal run did not stop its instance: stops=%d status=%s", stops, f.status())
	}
	attempts, _ := os.ReadDir(filepath.Join(f.home, "kiln", r.ID, "attempts"))
	for _, entry := range attempts {
		if strings.HasSuffix(entry.Name(), ".env") || strings.HasSuffix(entry.Name(), ".stdin") || strings.HasSuffix(entry.Name(), ".out") || strings.HasSuffix(entry.Name(), ".status") {
			t.Fatalf("attempt file retained in instance: %s", entry.Name())
		}
	}
	waitRun(t, e, r.ID, func(r Run) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.active[r.ID] == nil })
	if _, err := e.Cleanup(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	deleted := f.deleted
	f.mu.Unlock()
	if len(deleted) != 1 || deleted[0] != r.Sandbox.ID {
		t.Fatalf("cleanup did not delete the instance: %v", deleted)
	}
	// Billing refusals are not retried and name the provider's reason.
	refused := newFakeAgent37(t)
	refused.createRefusal = "insufficient_balance"
	e2 := agent37Engine(t, refused, nil)
	r2 := submitWorkflow(t, e2, agent37Workflow(t))
	r2 = waitRun(t, e2, r2.ID, settled)
	if r2.Status != "failed" || !strings.Contains(r2.Error, "insufficient_balance") || r2.Sandbox != nil {
		t.Fatalf("%s %s %+v", r2.Status, r2.Error, r2.Sandbox)
	}
}

func TestAgent37TimeoutTerminatesProcessGroupAndWakesSleepers(t *testing.T) {
	f := newFakeAgent37(t)
	e := agent37Engine(t, f, nil)
	w := agent37Workflow(t)
	w.Nodes["work"] = Node{Type: "command", Command: `echo started; ps -o pgid= -p $$ | tr -d ' ' > "$KILN_ARTIFACT_DIR/pgid"; (sleep 30 &) ; sleep 30`, Timeout: "2500ms", Next: map[string]string{"success": "end", "failure": "gate"}}
	w.Nodes["gate"] = Node{Type: "human", Prompt: "Continue?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "verify", "no": "end"}}
	w.Nodes["verify"] = Node{Type: "command", Command: "printf resumed", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "waiting" || !strings.Contains(r.Outputs["work"].Error, "deadline") || !strings.Contains(r.Outputs["work"].Output, "started") {
		t.Fatalf("%s %+v", r.Status, r.Outputs["work"])
	}
	// The wrapper's process group, including the backgrounded child, is gone.
	raw, err := os.ReadFile(filepath.Join(r.Artifacts, "pgid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 1 {
		t.Fatalf("process group not recorded: %q", raw)
	}
	deadline := time.Now().Add(10 * time.Second)
	for syscall.Kill(-pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatal("remote process group survived the node timeout")
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Sleeping instances wake on exec; stopped ones need an explicit start.
	f.setStatus("sleeping")
	if _, err := e.Decide(r.ID, Decision{QuestionID: r.Question.ID, Choice: "yes"}); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, func(r Run) bool { return r.Terminal() })
	if r.Status != "succeeded" || r.Outputs["verify"].Output != "resumed" {
		t.Fatalf("%s %+v", r.Status, r.Outputs["verify"])
	}
	f.mu.Lock()
	starts := f.starts
	f.mu.Unlock()
	if starts != 0 {
		t.Fatalf("a sleeping instance was started explicitly %d times", starts)
	}
	g := newFakeAgent37(t)
	e2 := agent37Engine(t, g, nil)
	w2 := agent37Workflow(t)
	w2.Nodes["work"] = Node{Type: "command", Command: "printf first", Next: map[string]string{"success": "gate"}}
	w2.Nodes["gate"] = Node{Type: "human", Prompt: "Continue?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "verify", "no": "end"}}
	w2.Nodes["verify"] = Node{Type: "command", Command: "printf second", Next: map[string]string{"success": "end"}}
	r2 := submitWorkflow(t, e2, w2)
	r2 = waitRun(t, e2, r2.ID, settled)
	g.setStatus("stopped")
	if _, err := e2.Decide(r2.ID, Decision{QuestionID: r2.Question.ID, Choice: "yes"}); err != nil {
		t.Fatal(err)
	}
	r2 = waitRun(t, e2, r2.ID, func(r Run) bool { return r.Terminal() })
	g.mu.Lock()
	starts = g.starts
	g.mu.Unlock()
	if r2.Status != "succeeded" || r2.Outputs["verify"].Output != "second" || starts != 1 {
		t.Fatalf("%s %+v starts=%d", r2.Status, r2.Outputs["verify"], starts)
	}
}

func TestAgent37AgentRunsPiRemotely(t *testing.T) {
	t.Setenv("KILN_TEST_KEY", "synthetic-inference-secret")
	f := newFakeAgent37(t)
	// A JSONL record larger than one poll chunk must arrive byte-exact in the transcript.
	filler := `{"type":"filler","data":"` + strings.Repeat("y", 2*agent37Chunk+33) + `"}`
	script := "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$@\" > \"$KILN_ARTIFACT_DIR/args\"\ncat > \"$KILN_ARTIFACT_DIR/prompt\"\nprintf edited > edited.txt\nprintf '%s\\n' '" + filler + "' '" + piAnswer + "' '{\"type\":\"agent_settled\"}'\n"
	if err := os.WriteFile(filepath.Join(f.bin, "pi"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	e := agent37Engine(t, f, func(x *Executor) {
		x.Providers = map[string]Provider{"openrouter": {URL: "https://openrouter.ai/api/v1", KeyEnv: "KILN_TEST_KEY"}}
	})
	w := agent37Workflow(t)
	w.Sandbox.Template = "my-pinned-pi@3"
	w.Nodes["work"] = Node{Type: "agent", Provider: "openrouter", Model: "exact-model", Prompt: "fix it", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	got := r.Outputs["work"]
	if r.Status != "succeeded" || got.Output != "done" || got.Harness != "pi" || got.Sandbox != r.Sandbox.ID || got.RequestID != "response-1" {
		t.Fatalf("%s %+v", r.Status, got)
	}
	args, _ := os.ReadFile(filepath.Join(r.Artifacts, "args"))
	root := f.home + "/kiln/" + r.ID
	if !strings.Contains(string(args), "--session\n"+root+"/agents/") || strings.Contains(string(args), e.exec.Root) {
		t.Fatalf("remote arguments: %s", args)
	}
	prompt, _ := os.ReadFile(filepath.Join(r.Artifacts, "prompt"))
	if !strings.HasSuffix(string(prompt), "fix it") {
		t.Fatalf("prompt: %s", prompt)
	}
	if b, err := os.ReadFile(filepath.Join(r.Workspace, "edited.txt")); err != nil || string(b) != "edited" {
		t.Fatalf("agent edit not synchronized: %s %v", b, err)
	}
	var attempt Attempt
	for _, a := range r.Attempts {
		if a.Node == "work" {
			attempt = a
		}
	}
	transcript, err := os.ReadFile(filepath.Join(e.exec.Root, attempt.Transcript))
	if err != nil || !strings.HasPrefix(string(transcript), filler+"\n") || !strings.Contains(string(transcript), "agent_settled") {
		t.Fatalf("transcript not delivered intact: len=%d err=%v", len(transcript), err)
	}
	instance := f.only()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.creates[0]["template"] != "my-pinned-pi@3" || instance.template != "my-pinned-pi@3" {
		t.Fatalf("template pin not forwarded: %v", f.creates[0])
	}
}

func TestAgent37WorkflowValidation(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		mutate func(*Workflow)
		want   string
	}{
		{"type", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "agent37", Type: "large"} }, "for agent37"},
		{"template", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "agent37", Template: "Bad Name"} }, "sandbox.template"},
		{"region", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "agent37", Region: "mars"} }, "sandbox.region"},
		{"resources", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "agent37", Resources: &SandboxResources{CPU: -1}} }, "sandbox.resources"},
		{"snapshot on agent37", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "agent37", Snapshot: "x"} }, "applies to boat only"},
		{"template on boat", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "boat", Template: "x"} }, "agent37 only"},
	} {
		w := basicWorkflow()
		tc.mutate(&w)
		if err := w.Validate(); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: want %q, got %v", tc.name, tc.want, err)
		}
	}
	w := basicWorkflow()
	w.Sandbox = &Sandbox{Provider: "agent37", Type: "vm", Template: "agent37-ubuntu@2026.10.01a", Resources: &SandboxResources{CPU: 4, Memory: 8, Disk: 20}, Region: "eu"}
	if _, err := ParseWorkflow([]byte(workflowYAML(t, w))); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSandboxes(map[string]SandboxProvider{"boat": {ExecURL: "https://x.example"}}); err == nil {
		t.Fatal("exec_url accepted for boat")
	}
	if err := ValidateSandboxes(map[string]SandboxProvider{"agent37": {URL: "https://api.agent37.com/v1", ExecURL: "https://sandbox.agent37.app", IdleTimeout: "15m"}}); err != nil {
		t.Fatal(err)
	}
}
