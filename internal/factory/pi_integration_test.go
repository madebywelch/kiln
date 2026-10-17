package factory

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Uses real Pi + real MCP, but a local inference fixture (no API charges).
// CI's Go-only job need not install the separate Node.js harness.
func TestPiCLISelectedMCP(t *testing.T) {
	if os.Getenv("KILN_PI_INTEGRATION") != "1" {
		t.Skip("set KILN_PI_INTEGRATION=1 to test installed Pi")
	}
	if _, err := exec.LookPath("pi"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KILN_TEST_KEY", "local-inference-fixture")
	t.Setenv("KILN_FIXTURE_KEY", "local-fixture")
	var tools []string
	var mu sync.Mutex
	var called, shellChecked bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			Tools    []struct{ Function struct{ Name string } }
			Messages []struct {
				Role    string
				Content any
			}
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		mu.Lock()
		defer mu.Unlock()
		for _, m := range body.Messages {
			if m.Role == "tool" && strings.Contains(fmt.Sprint(m.Content), "KILN-MCP-VERIFIED") {
				called = true
			}
			if m.Role == "tool" && strings.Contains(fmt.Sprint(m.Content), "transport-env-unset") {
				shellChecked = true
			}
		}
		tools = nil
		for _, tool := range body.Tools {
			tools = append(tools, tool.Function.Name)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if !called {
			fmt.Fprint(w, `data: {"id":"local","object":"chat.completion.chunk","model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"mcp__fixture__rules","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

`)
			return
		}
		if !shellChecked {
			args, _ := json.Marshal(map[string]string{"command": `test -z "${KILN_INFERENCE_KEY+x}" && test -z "${KILN_FIXTURE_KEY+x}" && printf transport-env-unset`})
			chunk, _ := json.Marshal(map[string]any{"id": "local", "object": "chat.completion.chunk", "model": "fixture", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call_env", "type": "function", "function": map[string]any{"name": "bash", "arguments": string(args)}}}}, "finish_reason": "tool_calls"}}})
			fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
			return
		}
		fmt.Fprint(w, `data: {"id":"local","object":"chat.completion.chunk","model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}

data: [DONE]

`)
	}))
	defer server.Close()
	fixture, err := filepath.Abs("../../scripts/fixtures/mcp.py")
	if err != nil {
		t.Fatal(err)
	}
	x := Executor{Root: t.TempDir(), Providers: map[string]Provider{"openrouter": {URL: server.URL + "/v1", KeyEnv: "KILN_TEST_KEY"}}, MCP: map[string]MCPServer{
		"fixture":    {Command: "python3", Args: []string{fixture}, Env: map[string]string{"FIXTURE_TOKEN": "${KILN_FIXTURE_KEY}"}},
		"unselected": {Command: "never-execute-this"},
	}}
	r := makeRun(basicWorkflow(), "rev", "", nil)
	r.Workspace = t.TempDir()
	r.Attempts = []Attempt{{ID: newID()}}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	result := x.Execute(ctx, r, Node{Type: "agent", Provider: "openrouter", Model: "fixture", Prompt: "Say done.", MCP: []string{"fixture"}})
	if result.Outcome != "success" {
		t.Fatalf("%+v", result)
	}
	mu.Lock()
	defer mu.Unlock()
	if !called || !shellChecked || result.ToolCalls != 2 || result.Turns != 3 {
		t.Fatalf("MCP was not actually called: %+v", result)
	}
	if !strings.Contains(strings.Join(tools, ","), "mcp__fixture__rules") {
		stderr, _ := os.ReadFile(filepath.Join(x.Root, "agents", r.ID, r.Attempts[0].ID, "stderr.log"))
		t.Fatalf("selected MCP not declared: %v; stderr: %s", tools, stderr)
	}
	for _, tool := range tools {
		if tool != "read" && tool != "write" && tool != "edit" && tool != "bash" && tool != "mcp__fixture__rules" {
			t.Errorf("unexpected tool: %s", tool)
		}
	}
}
