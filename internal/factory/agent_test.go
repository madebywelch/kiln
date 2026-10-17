package factory

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// Git tests must not depend on the developer's identity, hooks or signing setup.
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"} {
		_ = os.Setenv(k, v)
	}
	os.Exit(m.Run())
}

const piAnswer = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"model":"exact-model","responseId":"response-1","stopReason":"stop","usage":{"input":10,"output":3,"cacheRead":2,"cacheWrite":1,"totalTokens":16}}}`

func TestAgentProtocols(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, provider, events string
		success                bool
	}{
		{"pi", "openrouter", piAnswer + "\n" + `{"type":"agent_settled","aborted":false}`, true},
		{"missing-settled", "openrouter", piAnswer, false},
		{"truncated", "openrouter", `{"type":`, false},
		{"empty", "openrouter", "", false},
		{"provider-error-exit-zero", "openrouter", `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"quota"}}` + "\n" + `{"type":"agent_settled"}`, false},
		{"token-limit", "openrouter", strings.ReplaceAll(piAnswer, `"stopReason":"stop"`, `"stopReason":"length"`) + "\n" + `{"type":"agent_settled"}`, false},
		{"aborted", "openrouter", piAnswer + "\n" + `{"type":"agent_settled","aborted":true}`, false},
		{"codex", "codex", `{"type":"item.completed","item":{"type":"agent_message","text":"done"}}` + "\n" + `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}`, true},
		{"codex-no-answer", "codex", `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}`, false},
		{"codex-error", "codex", `{"type":"turn.failed","error":{"message":"unauthorized"}}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := agentParser{provider: tc.provider, result: Result{Outcome: "success"}}
			parseError := false
			for _, line := range strings.Split(tc.events, "\n") {
				if line == "" {
					continue
				}
				if p.consume([]byte(line)) != nil {
					parseError = true
				}
			}
			r := p.finish()
			success := !parseError && r.Outcome == "success"
			if success != tc.success {
				t.Fatalf("%+v parseError=%v", r, parseError)
			}
			if tc.name == "pi" && (r.Usage.PromptTokens != 13 || r.Usage.TotalTokens != 16 || r.Usage.Cost != nil || r.RequestID != "response-1") {
				t.Fatalf("usage is not faithful: %+v", r)
			}
		})
	}
}

func TestAgentStdinIsolationAndSelectedResources(t *testing.T) {
	root := t.TempDir()
	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KILN_TEST_KEY", "synthetic-inference-secret")
	t.Setenv("MCP_TEST_TOKEN", "synthetic-mcp-secret")
	script := "#!/bin/sh\nset -eu\nif [ \"${1-}\" = mcp ]; then exit 0; fi\nprintf '%s\\n' \"$@\" > \"$KILN_WORKSPACE/args\"\ncat > \"$KILN_WORKSPACE/prompt\"\nprintf '%s' \"$HOME\" > \"$KILN_WORKSPACE/home\"\nprintf '%s\\n' '" + piAnswer + "' '{\"type\":\"agent_settled\"}'\n"
	if err := os.WriteFile(filepath.Join(bin, "pi"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	r := makeRun(basicWorkflow(), "rev", "", map[string]string{"goal": "literal $(echo wrong)"})
	r.Workspace = t.TempDir()
	r.Attempts = []Attempt{{ID: newID()}}
	writeTestSkill(t, r.Workspace, "chosen")
	writeTestSkill(t, r.Workspace, "unselected")
	if err := os.WriteFile(filepath.Join(r.Workspace, "AGENTS.md"), []byte("Repository instruction"), 0600); err != nil {
		t.Fatal(err)
	}
	x := Executor{Root: root, Providers: map[string]Provider{"openrouter": {URL: "https://openrouter.ai/api/v1", KeyEnv: "KILN_TEST_KEY"}}, MCP: map[string]MCPServer{
		"docs":       {URL: "https://docs.invalid/mcp", Headers: map[string]string{"Authorization": "Bearer ${MCP_TEST_TOKEN}"}},
		"unselected": {URL: "https://other.invalid/mcp", Headers: map[string]string{"Authorization": "Bearer ${UNSET_SECRET}"}},
	}}
	n := Node{Type: "agent", Provider: "openrouter", Model: "exact-model", Prompt: "{{ .inputs.goal }}", Skills: []string{"chosen"}, MCP: []string{"docs"}}
	got := x.Execute(context.Background(), r, n)
	if got.Outcome != "success" || got.Output != "done" || got.Harness != "pi" {
		t.Fatalf("%+v", got)
	}
	args, _ := os.ReadFile(filepath.Join(r.Workspace, "args"))
	for _, flag := range []string{"--no-approve", "--no-extensions", "--no-skills", "read,bash,edit,write", "builtin:mcp", "chosen/SKILL.md"} {
		if !strings.Contains(string(args), flag) {
			t.Fatalf("missing %s: %s", flag, args)
		}
	}
	if strings.Contains(string(args), "unselected") || strings.Contains(string(args), "secret") {
		t.Fatalf("resource/credential leak: %s", args)
	}
	prompt, _ := os.ReadFile(filepath.Join(r.Workspace, "prompt"))
	if !strings.Contains(string(prompt), r.Inputs["goal"]) {
		t.Fatalf("prompt not passed literally: %s", prompt)
	}
	dir := filepath.Join(root, "agents", r.ID, r.Attempts[0].ID)
	home, _ := os.ReadFile(filepath.Join(r.Workspace, "home"))
	if string(home) != filepath.Join(root, "scratch", r.ID, "home") {
		t.Fatalf("agent did not receive the run's private home: %s", home)
	}
	for _, file := range []string{"models.json", "mcp.json"} {
		b, err := os.ReadFile(filepath.Join(dir, "pi", file))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "synthetic-") || strings.Contains(string(b), "unselected") {
			t.Fatalf("configuration leaks resources or credentials: %s", b)
		}
	}
	b, err := os.ReadFile(filepath.Join(dir, "events.jsonl"))
	if err != nil || !strings.Contains(string(b), "agent_settled") {
		t.Fatal("transcript not retained", err)
	}
	// Missing named resources fail before inference; no silent partial loadout.
	r.Attempts = []Attempt{{ID: newID()}}
	n.Skills = []string{"missing"}
	if got := x.Execute(context.Background(), r, n); got.Outcome != "failure" || !strings.Contains(got.Error, "skill missing") {
		t.Fatalf("%+v", got)
	}
}
func writeTestSkill(t *testing.T, workspace, name string) {
	t.Helper()
	path := filepath.Join(workspace, ".agents", "skills", name, "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nname: "+name+"\ndescription: A test skill.\n---\nInstructions.\n"), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestAgentCancellationAndBounds(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, command string
		limit         time.Duration
	}{
		{"timeout", "trap 'exit 0' TERM; sleep 30", 100 * time.Millisecond},
		{"malformed", "printf 'not json\\n'; sleep 30", time.Second},
		{"line-limit", "head -c 3000000 /dev/zero", time.Second},
		{"turn-limit", "i=0; while [ $i -lt 102 ]; do printf '%s\\n' '" + piAnswer + "'; i=$((i+1)); done", time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), tc.limit)
			defer cancel()
			start := time.Now()
			r := runAgent(ctx, t.TempDir(), t.TempDir(), os.Environ(), "", Node{Provider: "openrouter"}, []string{"/bin/sh", "-c", tc.command})
			if r.Outcome != "failure" || time.Since(start) > 5*time.Second {
				t.Fatalf("%+v elapsed %s", r, time.Since(start))
			}
		})
	}
}
func TestSkillsAndMCPValidation(t *testing.T) {
	t.Parallel()
	for _, servers := range []map[string]MCPServer{
		{"x": {}}, {"x": {Command: "tool", URL: "https://example.com"}}, {"x": {URL: "file:///etc/passwd"}},
		{"x": {URL: "https://example.com", Headers: map[string]string{"Authorization": "${HOME}"}}},
		{"a-b": {Command: "tool"}, "a_b": {Command: "tool"}}, {"x": {URL: "https://example.com", Headers: map[string]string{"Authorization": "!get-secret"}}},
	} {
		if ValidateMCP(servers) == nil {
			t.Fatalf("accepted invalid MCP configuration: %+v", servers)
		}
	}
	for _, n := range []Node{
		{Type: "agent", Provider: "codex", Model: "model", Prompt: "p", Skills: []string{"foo"}},
		{Type: "agent", Provider: "openrouter", Model: "model", Prompt: "p", Skills: []string{"../outside"}},
		{Type: "agent", Provider: "openrouter", Model: "model", Prompt: "p", MCP: []string{"x", "x"}},
	} {
		w := basicWorkflow()
		n.Next = map[string]string{"success": "end"}
		w.Nodes["work"] = n
		if w.Validate() == nil {
			t.Fatalf("accepted invalid resource selection: %+v", n)
		}
	}
	workspace := t.TempDir()
	outside := t.TempDir()
	writeTestSkill(t, outside, "escaped")
	if err := os.Symlink(filepath.Join(outside, ".agents"), filepath.Join(workspace, ".agents")); err != nil {
		t.Fatal(err)
	}
	if _, err := skillPath(workspace, "escaped"); err == nil {
		t.Fatal("skill escaped repository")
	}
}
func TestCodexSandboxAndToolchainEnvironment(t *testing.T) {
	auth := t.TempDir()
	t.Setenv("CODEX_HOME", auth)
	t.Setenv("COREPACK_HOME", "/opt/corepack")
	t.Setenv("CARGO_HOME", "/data/cargo")
	if err := os.WriteFile(filepath.Join(auth, "auth.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	x := Executor{Root: root, InheritEnv: []string{"COREPACK_HOME", "CARGO_HOME"}, CacheDirs: []string{"/data/cache"}}
	r := Run{ID: "run", Workspace: t.TempDir(), Artifacts: filepath.Join(root, "artifacts", "run")}
	n := Node{Provider: "codex", Model: "test-model"}
	env, err := x.nodeEnv(n, r, "")
	if err != nil {
		t.Fatal(err)
	}
	args, env, err := x.agentCommand(r, n, t.TempDir(), env)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, "\n")
	if !strings.Contains(joined, "--sandbox\nworkspace-write") || strings.Contains(joined, "danger-full-access") {
		t.Fatalf("filesystem sandbox changed: %s", joined)
	}
	for _, setting := range []string{"--disable\nplugins", "--disable\nskill_mcp_dependency_install", "check_for_update_on_startup=false"} {
		if !strings.Contains(joined, setting) {
			t.Fatalf("missing %s: %s", setting, joined)
		}
	}
	// Builds may write to the run's private home, its artifacts and shared
	// caches, but never to the rest of the daemon state.
	roots := fmt.Sprintf("sandbox_workspace_write.writable_roots=[%q,%q,%q]", filepath.Join(root, "scratch", "run", "home"), "/data/cache", r.Artifacts)
	if !strings.Contains(joined, roots) || strings.Contains(joined, strconv.Quote(root)+",") {
		t.Fatalf("unexpected writable roots: %s", joined)
	}
	for _, setting := range []string{`approval_policy="never"`, "sandbox_workspace_write.network_access=true", `features.network_proxy={enabled=true,proxy_url="http://127.0.0.1:0",enable_socks5=false,domains={}}`} {
		if strings.Contains(joined, setting) != (runtime.GOOS == "linux") {
			t.Fatalf("incorrect platform network policy: %s", joined)
		}
	}
	for _, setting := range []string{"COREPACK_HOME=/opt/corepack", "CARGO_HOME=/data/cargo"} {
		if !strings.Contains(strings.Join(env, "\n"), setting) {
			t.Fatalf("isolated agent lost toolchain location %s", setting)
		}
	}
}

func TestTranscriptAPI(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	r := submitWorkflow(t, e, basicWorkflow())
	r = waitRun(t, e, r.ID, settled)
	a := &r.Attempts[0]
	a.Transcript = filepath.ToSlash(filepath.Join("agents", r.ID, a.ID, "events.jsonl"))
	path := filepath.Join(e.exec.Root, a.Transcript)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(piAnswer+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.store.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	h := NewAPI(e, APIConfig{Token: testToken})
	url := "/v1/runs/" + r.ID + "/attempts/" + a.ID + "/transcript"
	response := request(t, h, "GET", url, nil, nil, 200)
	var value map[string]any
	if err := json.Unmarshal(response, &value); err != nil {
		t.Fatal(err)
	}
	request(t, h, "GET", url, nil, map[string]string{"Authorization": ""}, 401)
	request(t, h, "GET", "/v1/runs/"+r.ID+"/attempts/unknown/transcript", nil, nil, 404)
}
