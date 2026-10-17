package factory

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLLMContractAndFailurePaths(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		status     int
		want       string
	}{
		{"rate limit", "", 429, "HTTP 429"},
		{"bad JSON", "not json", 200, "invalid provider"},
		{"empty choices", `{"choices":[]}`, 200, "no text choice"},
		{"null content", `{"choices":[{"message":{"content":null}}]}`, 200, "no text choice"},
		{"truncated generation", `{"choices":[{"finish_reason":"length","message":{"content":"incomplete"}}]}`, 200, "finish_reason=length"},
		{"success", `{"id":"request-1","model":"cheap","choices":[{"finish_reason":"stop","message":{"content":"print(42)"}}],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"cost":0.001}}`, 200, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/chat/completions" || r.Method != "POST" {
					t.Errorf("wrong request: %s %s", r.Method, r.URL.Path)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["model"] != "cheap" || body["max_tokens"] != float64(256) {
					t.Errorf("wrong body: %+v", body)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			dir := t.TempDir()
			x := Executor{Providers: map[string]Provider{"test": {URL: server.URL + "/v1"}}}
			r := makeRun(basicWorkflow(), "rev", "", map[string]string{"goal": "test"})
			r.Workspace = t.TempDir()
			r.Artifacts = dir
			got := x.Execute(context.Background(), r, Node{Type: "llm", Provider: "test", Model: "cheap", Prompt: "{{ .inputs.goal }}", MaxTokens: 256, ArtifactFile: "src/main.py"})
			if _, err := os.Stat(filepath.Join(r.Workspace, "src/main.py")); !os.IsNotExist(err) {
				t.Fatal("internal artifact leaked into worktree")
			}
			if tc.want != "" {
				if got.Outcome != "failure" || !strings.Contains(got.Error, tc.want) {
					t.Fatalf("%+v", got)
				}
				if _, err := os.Stat(filepath.Join(dir, "src/main.py")); !os.IsNotExist(err) {
					t.Fatal("failed inference wrote a file")
				}
			} else {
				if got.Outcome != "success" || got.Output != "print(42)" || got.Usage.TotalTokens != 24 || got.RequestID != "request-1" {
					t.Fatalf("%+v", got)
				}
				b, err := os.ReadFile(filepath.Join(dir, "src/main.py"))
				if err != nil || string(b) != got.Output {
					t.Fatalf("%s %v", b, err)
				}
			}
		})
	}
}
func TestProviderTimeoutAndMissingCredential(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer server.Close()
	x := Executor{Providers: map[string]Provider{"test": {URL: server.URL}}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	got := x.Execute(ctx, Run{}, Node{Type: "llm", Provider: "test", Model: "x", Prompt: "hello"})
	if got.Outcome != "failure" || !strings.Contains(got.Error, "deadline") {
		t.Fatalf("%+v", got)
	}
	x.Providers["test"] = Provider{URL: server.URL, KeyEnv: "KILN_NONEXISTENT_TEST_CREDENTIAL"}
	got = x.Execute(context.Background(), Run{}, Node{Type: "llm", Provider: "test", Model: "x", Prompt: "hello"})
	if !strings.Contains(got.Error, "not set") {
		t.Fatalf("%+v", got)
	}
}
func TestWorkspaceFileConfinement(t *testing.T) {
	t.Parallel()
	dir, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../escaped", filepath.Join(outside, "absolute"), "escape/file"} {
		if err := writeWorkspace(dir, path, []byte("bad")); err == nil {
			t.Fatalf("accepted escaping path %s", path)
		}
	}
	if err := writeWorkspace(dir, "nested/file", []byte("ok")); err != nil {
		t.Fatal(err)
	}
}
func TestCommandOutputIsBounded(t *testing.T) {
	t.Parallel()
	x := Executor{Root: t.TempDir()}
	r := makeRun(basicWorkflow(), "rev", "", map[string]string{"goal": "literal $(echo wrong)"})
	r.Workspace = t.TempDir()
	got := x.Execute(context.Background(), r, Node{Type: "command", Command: "head -c 100000 /dev/zero"})
	if !got.Truncated || len(got.Output) != outputLimit {
		t.Fatalf("output length=%d truncated=%v", len(got.Output), got.Truncated)
	}
}
func TestMinimalCommandEnvironment(t *testing.T) {
	t.Setenv("KILN_TEST_SECRET", "hidden")
	t.Setenv("KILN_TEST_UNLISTED", "hidden")
	t.Setenv("COREPACK_HOME", "/opt/corepack")
	t.Setenv("CARGO_HOME", "/data/cache/cargo")
	root, workspace, otherWorkspace := t.TempDir(), t.TempDir(), t.TempDir()
	// The daemon's own home and temporary directory must never reach a run.
	t.Setenv("HOME", "/daemon/home")
	t.Setenv("TMPDIR", "/daemon/tmp")
	r := makeRun(basicWorkflow(), "rev", "", nil)
	r.Workspace = workspace
	x := Executor{Root: root, InheritEnv: []string{"COREPACK_HOME", "CARGO_HOME", "KILN_TEST_UNSET"}}
	got := x.Execute(context.Background(), r, Node{Type: "command", Command: "printf '%s|%s' \"${KILN_TEST_SECRET-unset}\" \"${KILN_TEST_UNLISTED-unset}\""})
	if got.Output != "unset|unset" {
		t.Fatalf("daemon credentials inherited: %+v", got)
	}
	got = x.Execute(context.Background(), r, Node{Type: "command", Command: "printf '%s' \"$KILN_TEST_SECRET\"", PassEnv: []string{"KILN_TEST_SECRET"}})
	if got.Output != "hidden" {
		t.Fatal("explicit credential not inherited")
	}
	got = x.Execute(context.Background(), r, Node{Type: "command", Command: `printf '%s|%s|%s' "$COREPACK_HOME" "$CARGO_HOME" "${KILN_TEST_UNSET-absent}"`})
	if got.Output != "/opt/corepack|/data/cache/cargo|absent" {
		t.Fatalf("configured toolchain locations lost: %+v", got)
	}
	got = x.Execute(context.Background(), r, Node{Type: "command", Command: `printf '%s' "$CARGO_HOME"`, Env: map[string]string{"CARGO_HOME": "/custom/cargo"}})
	if got.Output != "/custom/cargo" {
		t.Fatalf("explicit cache override lost: %+v", got)
	}
	// HOME and TMPDIR are private to the run, writable, and executable, so
	// profiles, caches and temporary binaries never leak between runs or
	// depend on the daemon's own home. They disappear with workspace cleanup.
	scratch := filepath.Join(root, "scratch", r.ID)
	got = x.Execute(context.Background(), r, Node{Type: "command", Command: `printf '%s|%s' "$HOME" "$TMPDIR"; printf '#!/bin/sh\nexit 42\n' > "$TMPDIR/probe"; chmod +x "$TMPDIR/probe"; "$TMPDIR/probe" || test $? -eq 42; touch "$HOME/.profile"`})
	if got.Outcome != "success" || got.Output != filepath.Join(scratch, "home")+"|"+filepath.Join(scratch, "tmp") {
		t.Fatalf("run scratch is not private: %+v", got)
	}
	other := makeRun(basicWorkflow(), "rev", "", nil)
	other.Workspace = otherWorkspace
	got = x.Execute(context.Background(), other, Node{Type: "command", Command: `test ! -e "$HOME/.profile" && printf '%s' "$HOME"`})
	if got.Outcome != "success" || got.Output == filepath.Join(scratch, "home") {
		t.Fatalf("scratch shared between runs: %+v", got)
	}
	if err := x.Cleanup(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(scratch); !os.IsNotExist(err) {
		t.Fatal("cleanup retained run scratch")
	}
	if _, err := os.Stat(filepath.Join(root, "scratch", other.ID, "home")); err != nil {
		t.Fatal("cleanup removed another run's scratch")
	}
}
func TestEnvironmentConfigurationValidation(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ inherit, caches []string }{
		{[]string{"HOME"}, nil}, {[]string{"TMPDIR"}, nil}, {[]string{"CODEX_HOME"}, nil}, {[]string{"KILN_TOKEN"}, nil},
		{[]string{"BAD-NAME"}, nil}, {nil, []string{"relative/cache"}}, {nil, []string{"/data/cache/"}},
	} {
		if err := ValidateEnvironment(tc.inherit, tc.caches); err == nil {
			t.Fatalf("accepted %+v", tc)
		}
	}
	if err := ValidateEnvironment([]string{"CARGO_HOME", "GOMODCACHE"}, []string{"/data/cache"}); err != nil {
		t.Fatal(err)
	}
}
