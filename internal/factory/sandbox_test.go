package factory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func sandboxEngine(t *testing.T, f *fakeBoat, configure func(*Executor)) *Engine {
	t.Helper()
	return testEngine(t, func(x *Executor) {
		x.Sandboxes = f.provider()
		if configure != nil {
			configure(x)
		}
	})
}
func sandboxWorkflow(t *testing.T) Workflow {
	t.Helper()
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t), Base: "main"}
	w.Sandbox = &Sandbox{Provider: "boat", Type: "small", Snapshot: "kiln-base"}
	return w
}
func sandboxEvents(t *testing.T, e *Engine, id string) []string {
	t.Helper()
	events, err := e.store.Events(id, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, ev := range events {
		types = append(types, ev.Type)
	}
	return types
}

func TestSandboxRunExecutesRemotelyAndSyncsCheckpoints(t *testing.T) {
	t.Setenv("KILN_TEST_SECRET", "daemon-only")
	t.Setenv("KILN_TEST_PASSED", "forwarded")
	f := newFakeBoat(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"r1","model":"m","choices":[{"finish_reason":"stop","message":{"content":"the plan"}}]}`))
	}))
	defer provider.Close()
	e := sandboxEngine(t, f, func(x *Executor) { x.Providers = map[string]Provider{"planner": {URL: provider.URL}} })
	w := sandboxWorkflow(t)
	w.Nodes["start"] = Node{Type: "start", Next: map[string]string{"success": "work"}}
	w.Nodes["work"] = Node{Type: "command", PassEnv: []string{"KILN_TEST_PASSED"}, Env: map[string]string{"GOAL": "{{ .inputs.goal }}"}, Command: strings.Join([]string{
		`test -z "${KILN_TEST_SECRET-}"`,
		`test -z "${BOAT_ID-}"`,
		`test "$KILN_TEST_PASSED" = forwarded`,
		`test "$GOAL" = 'literal $(echo wrong)'`,
		`test "$HOME" = ` + shQuote(f.home),
		`test "$PWD" = "$KILN_WORKSPACE"`,
		`test "$(cat file.txt)" = original`,
		`python3 -c 'import json,os; c=json.load(open(os.environ["KILN_CONTEXT_FILE"])); assert c["run_id"] == os.environ["KILN_RUN_ID"]'`,
		`printf changed > file.txt`,
		`mkdir -p nested && printf new > nested/added.txt`,
		`printf cache > ignored.tmp`,
		`printf report > "$KILN_ARTIFACT_DIR/report.md"`,
		`printf 'work output'`,
	}, " && "), Next: map[string]string{"success": "plan"}}
	w.Nodes["plan"] = Node{Type: "llm", Provider: "planner", Model: "m", Prompt: "plan", ArtifactFile: "plan.md", Next: map[string]string{"success": "verify"}}
	w.Nodes["verify"] = Node{Type: "command", Command: strings.Join([]string{
		`test "$(cat file.txt)" = changed`,
		`test "$(cat nested/added.txt)" = new`,
		`test "$(cat ignored.tmp)" = cache`,
		`test "$(cat "$KILN_ARTIFACT_DIR/plan.md")" = "the plan"`,
		`test "$(cat "$KILN_ARTIFACT_DIR/report.md")" = report`,
		`rm nested/added.txt`,
		`exit 3`,
	}, " && "), Next: map[string]string{"success": "end", "failure": "end"}}
	w.Inputs = map[string]string{"goal": "literal $(echo wrong)"}
	if err := os.WriteFile(filepath.Join(w.Repository.Local, ".gitignore"), []byte("*.tmp\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", ".gitignore"}, {"commit", "--no-gpg-sign", "-qm", "test: ignore"}} {
		if _, err := git(context.Background(), w.Repository.Local, args...); err != nil {
			t.Fatal(err)
		}
	}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	if r.Sandbox == nil || r.Sandbox.Provider != "boat" || r.Sandbox.Home != f.home || r.Sandbox.Type != "small" {
		t.Fatalf("sandbox not recorded: %+v", r.Sandbox)
	}
	work, verify := r.Outputs["work"], r.Outputs["verify"]
	if work.Outcome != "success" || work.Output != "work output" || work.Sandbox != r.Sandbox.ID {
		t.Fatalf("%+v", work)
	}
	if verify.Outcome != "failure" || verify.ExitCode != 3 || verify.Sandbox != r.Sandbox.ID {
		t.Fatalf("%+v", verify)
	}
	// Host checkout and checkpoints reflect the remote working tree, including the failed attempt.
	if b, err := os.ReadFile(filepath.Join(r.Workspace, "file.txt")); err != nil || string(b) != "changed" {
		t.Fatalf("worktree not synchronized: %s %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(r.Workspace, "nested", "added.txt")); !os.IsNotExist(err) {
		t.Fatal("remote deletion not synchronized")
	}
	if _, err := os.Stat(filepath.Join(r.Workspace, "ignored.tmp")); !os.IsNotExist(err) {
		t.Fatal("ignored remote files must stay remote")
	}
	var workAttempt, verifyAttempt Attempt
	for _, a := range r.Attempts {
		if !a.Finalized || a.CheckpointSHA == "" {
			t.Fatalf("attempt lacks checkpoint: %+v", a)
		}
		switch a.Node {
		case "work":
			workAttempt = a
		case "verify":
			verifyAttempt = a
		}
	}
	if content, err := git(context.Background(), r.Workspace, "show", workAttempt.CheckpointSHA+":nested/added.txt"); err != nil || content != "new" {
		t.Fatalf("checkpoint lacks remote file: %s %v", content, err)
	}
	if _, err := git(context.Background(), r.Workspace, "show", verifyAttempt.CheckpointSHA+":nested/added.txt"); err == nil {
		t.Fatal("checkpoint retained a remotely deleted file")
	}
	if b, err := os.ReadFile(filepath.Join(r.Artifacts, "report.md")); err != nil || string(b) != "report" {
		t.Fatalf("remote artifact not collected: %s %v", b, err)
	}
	// Provider contract: dedicated no-env machine, no monitoring, idempotent create, extended auto-stop.
	f.mu.Lock()
	create, headers := f.creates[0], f.createHeaders[0]
	ttls, stops := append([]int(nil), f.ttls...), f.stops
	f.mu.Unlock()
	if create["noEnv"] != true || create["monitoring"] != false || create["type"] != "small" || create["from"] != "kiln-base" || create["ttlSeconds"] != float64(1800) {
		t.Fatalf("unexpected create request: %v", create)
	}
	if env, _ := create["env"].(map[string]any); env["KILN_RUN_ID"] != r.ID {
		t.Fatalf("sandbox not tagged with the run: %v", create)
	}
	if headers.Get("Idempotency-Key") != "kiln-run-"+r.ID {
		t.Fatalf("missing idempotency key: %v", headers)
	}
	if len(ttls) == 0 || ttls[0] <= 1800 {
		t.Fatalf("auto-stop not extended past the node: %v", ttls)
	}
	if stops != 1 || f.only().state != "archived" {
		t.Fatalf("terminal run did not stop its sandbox: stops=%d state=%s", stops, f.only().state)
	}
	events := sandboxEvents(t, e, r.ID)
	if !strings.Contains(strings.Join(events, ","), "sandbox.stopped") {
		t.Fatalf("missing sandbox event: %v", events)
	}
	// Secrets and prompts leave no file behind on the remote disk.
	attempts, _ := os.ReadDir(filepath.Join(f.home, "kiln", r.ID, "attempts"))
	for _, entry := range attempts {
		if strings.HasSuffix(entry.Name(), ".env") || strings.HasSuffix(entry.Name(), ".stdin") || strings.HasSuffix(entry.Name(), ".sh") {
			t.Fatalf("attempt file retained in sandbox: %s", entry.Name())
		}
	}
	if _, err := os.Stat(filepath.Join(f.home, "kiln", r.ID, "lease.pid")); !os.IsNotExist(err) {
		t.Fatal("remote lease not released")
	}
	h := NewAPI(e, APIConfig{Token: testToken})
	diff := decode[DiffResult](t, request(t, h, "GET", "/v1/runs/"+r.ID+"/diff", nil, nil, 200))
	if !strings.Contains(diff.Diff, "+changed") {
		t.Fatalf("API diff lacks remote change: %s", diff.Diff)
	}
	request(t, h, "GET", "/v1/runs/"+r.ID+"/artifacts/report.md", nil, nil, 200)
	waitRun(t, e, r.ID, func(r Run) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.active[r.ID] == nil })
	if _, err := e.Cleanup(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	deletes := f.deletes
	f.mu.Unlock()
	if len(deletes) != 1 || deletes[0].Get("X-Ascii-Confirm-Delete") != r.Sandbox.ID || !f.only().deleted {
		t.Fatalf("cleanup did not delete the sandbox: %v", deletes)
	}
	// A second cleanup is idempotent after the provider forgot the sandbox.
	r, _ = e.GetRun(r.ID)
	if !r.Cleaned {
		t.Fatal("run not marked clean")
	}
	events = sandboxEvents(t, e, r.ID)
	if !strings.Contains(strings.Join(events, ","), "workspace.cleaned") {
		t.Fatalf("%v", events)
	}
}

func TestSandboxCreateRetriesTransientFailure(t *testing.T) {
	f := newFakeBoat(t)
	f.createFailures = 1
	e := sandboxEngine(t, f, nil)
	w := sandboxWorkflow(t)
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	f.mu.Lock()
	creates, sandboxes := len(f.creates), len(f.sandboxes)
	f.mu.Unlock()
	if creates != 2 || sandboxes != 1 {
		t.Fatalf("retry created %d sandboxes over %d requests", sandboxes, creates)
	}
	// A billing refusal is not transient: preparation fails once, with the provider's message.
	refused := newFakeBoat(t)
	refused.createRefusal = "billing_required"
	e2 := sandboxEngine(t, refused, nil)
	r = submitWorkflow(t, e2, sandboxWorkflow(t))
	r = waitRun(t, e2, r.ID, settled)
	if r.Status != "failed" || !strings.Contains(r.Error, "billing_required") || !strings.Contains(r.Error, "$20/month") || r.Sandbox != nil {
		t.Fatalf("%s %s %+v", r.Status, r.Error, r.Sandbox)
	}
	refused.mu.Lock()
	defer refused.mu.Unlock()
	if len(refused.creates) != 1 {
		t.Fatalf("billing refusal was retried %d times", len(refused.creates))
	}
}

func TestSandboxTimeoutAndShutdownTerminateRemoteProcess(t *testing.T) {
	f := newFakeBoat(t)
	e := sandboxEngine(t, f, nil)
	w := sandboxWorkflow(t)
	w.Nodes["work"] = Node{Type: "command", Command: "echo started; sleep 30", Timeout: "1500ms", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "failed" || !strings.Contains(r.Outputs["work"].Error, "deadline") || !strings.Contains(r.Outputs["work"].Output, "started") {
		t.Fatalf("%+v", r.Outputs["work"])
	}
	f.mu.Lock()
	var procs []*fakeProcess
	for _, p := range f.procs {
		procs = append(procs, p)
	}
	f.mu.Unlock()
	if len(procs) == 0 {
		t.Fatal("no remote process started")
	}
	for _, p := range procs {
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			t.Fatal("remote process survived the node timeout")
		}
	}
	// Collection still ran: the checkpoint of the failed attempt exists.
	last := r.Attempts[len(r.Attempts)-1]
	if last.Node != "work" || !last.Finalized || last.CheckpointSHA == "" {
		t.Fatalf("%+v", last)
	}

	// Daemon shutdown during a remote node kills the process group and leaves the run interrupted.
	f2 := newFakeBoat(t)
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	e2, err := NewEngine(s, &Executor{Root: dir, AllowLocal: true, Sandboxes: f2.provider()}, 1)
	if err != nil {
		t.Fatal(err)
	}
	e2.Start()
	w2 := sandboxWorkflow(t)
	w2.Nodes["work"] = Node{Type: "command", Command: "echo started; sleep 30", Next: map[string]string{"success": "end"}}
	r2 := submitWorkflow(t, e2, w2)
	waitRun(t, e2, r2.ID, func(r Run) bool {
		f2.mu.Lock()
		defer f2.mu.Unlock()
		for _, p := range f2.procs {
			if b, _ := os.ReadFile(p.stdout); strings.Contains(string(b), "started") {
				return true
			}
		}
		return false
	})
	e2.Close()
	f2.mu.Lock()
	procs = nil
	for _, p := range f2.procs {
		procs = append(procs, p)
	}
	f2.mu.Unlock()
	for _, p := range procs {
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			t.Fatal("remote process survived daemon shutdown")
		}
	}
	got, err := get[Run](s, "run", r2.ID)
	if err != nil || got.Status != "interrupted" {
		t.Fatalf("%+v %v", got.Status, err)
	}
	if f2.only().state != "ready" {
		t.Fatal("interrupted runs keep their sandbox for retry")
	}
	s.Close()
}

func TestSandboxResumesArchivedMachineAndRefusesStaleProcess(t *testing.T) {
	f := newFakeBoat(t)
	e := sandboxEngine(t, f, nil)
	w := sandboxWorkflow(t)
	w.Nodes["work"] = Node{Type: "command", Command: "printf changed > file.txt", Next: map[string]string{"success": "gate"}}
	w.Nodes["gate"] = Node{Type: "human", Prompt: "Continue?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "verify", "no": "end"}}
	w.Nodes["verify"] = Node{Type: "command", Command: `test "$(cat file.txt)" = changed && printf verified`, Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "waiting" {
		t.Fatalf("%+v", r)
	}
	if f.only().state != "ready" {
		t.Fatal("waiting runs rely on the provider's idle auto-stop, not an explicit stop")
	}
	// A surviving process from a crashed daemon blocks the next attempt.
	stale := exec.Command("sleep", "30")
	stale.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := stale.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Kill(-stale.Process.Pid, syscall.SIGKILL); _ = stale.Wait() }()
	root := filepath.Join(f.home, "kiln", r.ID)
	if err := os.WriteFile(filepath.Join(root, "lease.pid"), []byte(strconv.Itoa(stale.Process.Pid)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "lease.pid.attempt"), []byte("previous\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: r.Question.ID, Choice: "yes"}); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, func(r Run) bool { return r.Terminal() })
	if r.Status != "failed" || !strings.Contains(r.Outputs["verify"].Error, "still running") || r.Outputs["verify"].ExitCode != remoteLeaseExit {
		t.Fatalf("%+v", r.Outputs["verify"])
	}
	// The failed run stopped its machine; the provider later expires the idle disk snapshot's machine too.
	if f.only().state != "archived" {
		t.Fatal("failed run did not stop its sandbox")
	}
	_ = syscall.Kill(-stale.Process.Pid, syscall.SIGKILL)
	_ = stale.Wait()
	waitRun(t, e, r.ID, func(r Run) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.active[r.ID] == nil })
	if _, err := e.Retry(r.ID); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, func(r Run) bool { return r.Terminal() })
	if r.Status != "succeeded" || r.Outputs["verify"].Output != "verified" {
		t.Fatalf("%+v", r.Outputs["verify"])
	}
	f.mu.Lock()
	resumes, creates := f.resumes, len(f.creates)
	f.mu.Unlock()
	if resumes != 1 || creates != 1 {
		t.Fatalf("resumes=%d creates=%d", resumes, creates)
	}
	if r.Visits["verify"] != 2 {
		t.Fatalf("retry did not revisit the node: %+v", r.Visits)
	}
}

func TestSandboxAgentRunsPiRemotely(t *testing.T) {
	t.Setenv("KILN_TEST_KEY", "synthetic-inference-secret")
	t.Setenv("MCP_TEST_TOKEN", "synthetic-mcp-secret")
	f := newFakeBoat(t)
	script := "#!/bin/sh\nset -eu\nif [ \"${1-}\" = mcp ]; then printf '[]'; exit 0; fi\nprintf '%s\\n' \"$@\" > \"$KILN_ARTIFACT_DIR/args\"\ncat > \"$KILN_ARTIFACT_DIR/prompt\"\nprintf '%s' \"$KILN_INFERENCE_KEY\" > \"$KILN_ARTIFACT_DIR/key\"\nprintf '%s|%s' \"$PI_CODING_AGENT_DIR\" \"$PWD\" > \"$KILN_ARTIFACT_DIR/dirs\"\nprintf edited > edited.txt\nprintf 'noise\\n' >&2\nprintf '%s\\n' '" + piAnswer + "' '{\"type\":\"agent_settled\"}'\n"
	if err := os.WriteFile(filepath.Join(f.bin, "pi"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	e := sandboxEngine(t, f, func(x *Executor) {
		x.Providers = map[string]Provider{"openrouter": {URL: "https://openrouter.ai/api/v1", KeyEnv: "KILN_TEST_KEY"}}
		x.MCP = map[string]MCPServer{"docs": {URL: "https://docs.invalid/mcp", Headers: map[string]string{"Authorization": "Bearer ${MCP_TEST_TOKEN}"}}}
	})
	w := sandboxWorkflow(t)
	writeTestSkill(t, w.Repository.Local, "chosen")
	if err := os.WriteFile(filepath.Join(w.Repository.Local, "AGENTS.md"), []byte("Repository instruction"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "."}, {"commit", "--no-gpg-sign", "-qm", "test: resources"}} {
		if _, err := git(context.Background(), w.Repository.Local, args...); err != nil {
			t.Fatal(err)
		}
	}
	w.Inputs = map[string]string{"goal": "literal $(echo wrong)"}
	w.Nodes["work"] = Node{Type: "agent", Provider: "openrouter", Model: "exact-model", Prompt: "{{ .inputs.goal }}", Skills: []string{"chosen"}, MCP: []string{"docs"}, Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	got := r.Outputs["work"]
	if r.Status != "succeeded" || got.Output != "done" || got.Harness != "pi" || got.Sandbox != r.Sandbox.ID || got.RequestID != "response-1" {
		t.Fatalf("%+v %+v", r.Status, got)
	}
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(r.Artifacts, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	root := f.home + "/kiln/" + r.ID
	var attempt Attempt
	for _, a := range r.Attempts {
		if a.Node == "work" {
			attempt = a
		}
	}
	args := read("args")
	for _, flag := range []string{"--no-approve", "--no-skills", "read,bash,edit,write,mcp__docs__*", "builtin:mcp", "--skill\n" + root + "/work/.agents/skills/chosen/SKILL.md", "--session\n" + root + "/agents/" + attempt.ID + "/session.jsonl", "--append-system-prompt\n" + root + "/agents/" + attempt.ID + "/instructions.md"} {
		if !strings.Contains(args, flag) {
			t.Fatalf("missing %q in remote arguments: %s", flag, args)
		}
	}
	if strings.Contains(args, e.exec.Root) || strings.Contains(args, "secret") {
		t.Fatalf("host paths or credentials in remote arguments: %s", args)
	}
	if prompt := read("prompt"); !strings.HasPrefix(prompt, agentPreamble) || !strings.Contains(prompt, r.Inputs["goal"]) {
		t.Fatalf("prompt not passed literally: %s", prompt)
	}
	if read("key") != "synthetic-inference-secret" {
		t.Fatal("inference credential did not reach the remote harness")
	}
	if read("dirs") != root+"/agents/"+attempt.ID+"/pi|"+root+"/work" {
		t.Fatalf("remote layout: %s", read("dirs"))
	}
	for _, file := range []string{"pi/models.json", "pi/settings.json", "pi/mcp.json", "instructions.md"} {
		b, err := os.ReadFile(filepath.Join(f.home, "kiln", r.ID, "agents", attempt.ID, file))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "synthetic-") {
			t.Fatalf("configuration leaks credentials: %s", b)
		}
	}
	// Host keeps the transcript and stderr; the worktree change came back.
	transcript, err := os.ReadFile(filepath.Join(e.exec.Root, attempt.Transcript))
	if err != nil || !strings.Contains(string(transcript), "agent_settled") {
		t.Fatal("transcript not retained", err)
	}
	stderr, _ := os.ReadFile(filepath.Join(e.exec.Root, "agents", r.ID, attempt.ID, "stderr.log"))
	if !strings.Contains(string(stderr), "noise") {
		t.Fatalf("stderr not captured: %q", stderr)
	}
	if b, err := os.ReadFile(filepath.Join(r.Workspace, "edited.txt")); err != nil || string(b) != "edited" {
		t.Fatalf("agent edit not synchronized: %s %v", b, err)
	}
	h := NewAPI(e, APIConfig{Token: testToken})
	request(t, h, "GET", "/v1/runs/"+r.ID+"/attempts/"+attempt.ID+"/transcript", nil, nil, 200)
}

func TestSandboxChangesetValidatesCandidateRemotely(t *testing.T) {
	for _, tc := range []struct {
		name, check, status, want string
	}{
		{"clean", `test "$(cat file.txt)" = changed && test ! -e scratch.txt && test -z "${BOAT_ID-}"`, "waiting", ""},
		{"mutating", `printf mutated > file.txt`, "failed", "validation changed"},
		{"failing", `echo diagnostic; exit 9`, "failed", "validation failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeBoat(t)
			e := sandboxEngine(t, f, nil)
			w := sandboxWorkflow(t)
			w.Nodes["work"] = Node{Type: "command", Command: "printf changed > file.txt; printf private > scratch.txt", Next: map[string]string{"success": "candidate"}}
			n := candidateNode()
			n.Command = tc.check
			n.Exclude = []string{"scratch.txt"}
			n.Next = map[string]string{"success": "approval"}
			w.Nodes["candidate"] = n
			w.Nodes["approval"] = Node{Type: "human", Prompt: "Review {{ .run.candidate.commit_sha }}", Choices: []string{"accept", "reject"}, Next: map[string]string{"accept": "end", "reject": "end"}}
			r := submitWorkflow(t, e, w)
			r = waitRun(t, e, r.ID, settled)
			result := r.Outputs["candidate"]
			if r.Status != tc.status {
				t.Fatalf("%s %s %+v", r.Status, r.Error, result)
			}
			if tc.want != "" {
				if !strings.Contains(result.Error, tc.want) {
					t.Fatalf("%+v", result)
				}
				return
			}
			if result.Sandbox != r.Sandbox.ID {
				t.Fatalf("validation did not run in the sandbox: %+v", result)
			}
			c := r.Candidate
			if c == nil || c.Files[0] != "file.txt" || c.Excluded[0] != "scratch.txt" {
				t.Fatalf("%+v", c)
			}
			if _, err := os.Stat(filepath.Join(f.home, "kiln", r.ID, "candidates", c.ID)); !os.IsNotExist(err) {
				t.Fatal("remote candidate worktree retained")
			}
			if _, err := os.Stat(filepath.Join(e.exec.candidateDir(r, c.ID), "worktree")); !os.IsNotExist(err) {
				t.Fatal("host validation worktree retained")
			}
			if b, err := os.ReadFile(filepath.Join(r.Workspace, "scratch.txt")); err != nil || string(b) != "private" {
				t.Fatal("run worktree disturbed by candidate validation")
			}
		})
	}
}

func TestSandboxWorkflowValidation(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		mutate func(*Workflow)
		want   string
	}{
		{"provider", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "aws"} }, "must be boat"},
		{"type", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "boat", Type: "huge"} }, "sandbox.type"},
		{"snapshot", func(w *Workflow) { w.Sandbox = &Sandbox{Provider: "boat", Snapshot: "bad name"} }, "sandbox.snapshot"},
		{"codex", func(w *Workflow) {
			w.Sandbox = &Sandbox{Provider: "boat"}
			w.Nodes["work"] = Node{Type: "agent", Provider: "codex", Model: "m", Prompt: "p", Next: map[string]string{"success": "end"}}
		}, "daemon host only"},
	} {
		w := basicWorkflow()
		tc.mutate(&w)
		if err := w.Validate(); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: want %q, got %v", tc.name, tc.want, err)
		}
	}
	w := basicWorkflow()
	w.Sandbox = &Sandbox{Provider: "boat", Type: "large", Snapshot: "team/kiln-base:v2"}
	if _, err := ParseWorkflow([]byte(workflowYAML(t, w))); err != nil {
		t.Fatal(err)
	}
	for _, providers := range []map[string]SandboxProvider{
		{"other": {}}, {"boat": {URL: "ftp://x"}}, {"boat": {URL: "https://user@boat.dev/api/v1"}}, {"boat": {KeyEnv: "bad-name"}}, {"boat": {IdleTimeout: "10s"}}, {"boat": {IdleTimeout: "800h"}},
	} {
		if err := ValidateSandboxes(providers); err == nil {
			t.Fatalf("accepted %+v", providers)
		}
	}
	if err := ValidateSandboxes(map[string]SandboxProvider{"boat": {IdleTimeout: "2h"}}); err != nil {
		t.Fatal(err)
	}
	// Registration enforces server policy: configured provider and HTTP-only MCP.
	e := testEngine(t, func(x *Executor) {
		x.MCP = map[string]MCPServer{"local": {Command: "tool"}, "remote": {URL: "https://docs.invalid/mcp"}}
		x.Providers = map[string]Provider{"openrouter": {URL: "https://openrouter.ai/api/v1", KeyEnv: "X"}}
	})
	if _, err := e.Register(workflowYAML(t, w), ""); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("unconfigured provider accepted: %v", err)
	}
	e.exec.Sandboxes = map[string]SandboxProvider{"boat": {}}
	w.Nodes["work"] = Node{Type: "agent", Provider: "openrouter", Model: "m", Prompt: "p", MCP: []string{"local"}, Next: map[string]string{"success": "end"}}
	if _, err := e.Register(workflowYAML(t, w), ""); err == nil || !strings.Contains(err.Error(), "url servers") {
		t.Fatalf("stdio MCP accepted for a sandbox workflow: %v", err)
	}
	w.Nodes["work"] = Node{Type: "agent", Provider: "openrouter", Model: "m", Prompt: "p", MCP: []string{"remote"}, Next: map[string]string{"success": "end"}}
	if _, err := e.Register(workflowYAML(t, w), ""); err != nil {
		t.Fatal(err)
	}
}

func TestSandboxHelpers(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"../escape", "/abs/path", "a/../../b"} {
		data, err := tarBytes(map[string][]byte{name: []byte("x")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := untarBytes(data); err == nil {
			t.Fatalf("accepted archive entry %q", name)
		}
	}
	data, err := tarBytes(map[string][]byte{"./artifacts/a.txt": []byte("a"), "sync/out.bundle": []byte("b")})
	if err != nil {
		t.Fatal(err)
	}
	entries, err := untarBytes(data)
	if err != nil || string(entries["artifacts/a.txt"]) != "a" || string(entries["sync/out.bundle"]) != "b" {
		t.Fatalf("%v %v", entries, err)
	}
	if got := shQuote("it's $HOME"); got != `'it'\''s $HOME'` {
		t.Fatal(got)
	}
	x := Executor{Root: "/data"}
	r := Run{ID: "run1", Sandbox: &SandboxState{Home: "/home/user"}}
	l := layoutFor(r)
	r.Workspace = "/data/workspaces/run1"
	if dir, candidate, err := x.remoteWorkspace(l, r); err != nil || candidate || dir != "/home/user/kiln/run1/work" {
		t.Fatalf("%s %v %v", dir, candidate, err)
	}
	r.Workspace = "/data/candidates/run1/0123456789abcdef0123456789abcdef/worktree"
	if dir, candidate, err := x.remoteWorkspace(l, r); err != nil || !candidate || dir != "/home/user/kiln/run1/candidates/0123456789abcdef0123456789abcdef" {
		t.Fatalf("%s %v %v", dir, candidate, err)
	}
	r.Workspace = "/data/workspaces/other"
	if _, _, err := x.remoteWorkspace(l, r); err == nil {
		t.Fatal("foreign workspace mapped")
	}
	err = decodeBoatError(502, []byte(`{"ok":false,"code":"sandbox_direct_failed","message":"sandbox_restoring","requestId":"req_1","error":{"code":"sandbox_direct_failed","details":{"retryable":true}}}`))
	var be *boatError
	if !errors.As(err, &be) || !be.transient() || be.RequestID != "req_1" || !strings.Contains(err.Error(), "sandbox_restoring") {
		t.Fatalf("%+v", err)
	}
	err = decodeBoatError(409, []byte(`{"code":"machine_not_running","message":"stopped"}`))
	if errors.As(err, &be) && be.transient() {
		t.Fatal("non-retryable conflict treated as transient")
	}
	err = decodeBoatError(429, []byte(`{"code":"IP_RATE_LIMIT_EXCEEDED","retryAfter":7}`))
	if !errors.As(err, &be) || !be.transient() || be.RetryAfter != 7*time.Second {
		t.Fatalf("%+v", be)
	}
	var env map[string]any
	if err := json.Unmarshal([]byte(`{"a":1}`), &env); err != nil {
		t.Fatal(err)
	}
}
