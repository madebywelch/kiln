package factory

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRemoteUncertainResultsInterrupt(t *testing.T) {
	for _, kind := range []string{"command", "agent"} {
		for _, phase := range []string{"launch", "collection", "failed-collection", "canceled-collection"} {
			t.Run(kind+"/"+phase, func(t *testing.T) {
				f := newFakeBoat(t)
				x := &Executor{Root: t.TempDir(), Sandboxes: f.provider(), Providers: map[string]Provider{"openrouter": {KeyEnv: "KILN_TEST_INFERENCE_KEY"}}}
				t.Setenv("KILN_TEST_INFERENCE_KEY", "test-only")
				r := Run{ID: newID(), Workflow: basicWorkflow(), Artifacts: t.TempDir(), Attempts: []Attempt{{ID: newID()}}}
				r.Workflow.Sandbox = &Sandbox{Provider: "boat"}
				r.Workspace = filepath.Join(x.Root, "workspaces", r.ID)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				var err error
				r, err = x.prepareSandbox(ctx, r)
				if err != nil {
					t.Fatal(err)
				}
				pi := "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '" + piAnswer + "' '{\"type\":\"agent_settled\"}'\n"
				if phase == "failed-collection" {
					pi += "exit 7\n"
				}
				if err := os.WriteFile(filepath.Join(f.bin, "pi"), []byte(pi), 0700); err != nil {
					t.Fatal(err)
				}
				var launched, collectionAttempted atomic.Bool
				x.HTTP = &http.Client{Transport: remoteInterruptionTransport(func(req *http.Request) (*http.Response, error) {
					if req.Method == "POST" && strings.HasSuffix(req.URL.Path, "/commands") {
						body, err := io.ReadAll(req.Body)
						if err != nil {
							return nil, err
						}
						req.Body = io.NopCloser(bytes.NewReader(body))
						var command struct{ Detached bool }
						if err := json.Unmarshal(body, &command); err != nil {
							return nil, err
						}
						if command.Detached {
							launched.Store(true)
							if phase == "launch" {
								return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader("launch result lost")), Header: http.Header{}}, nil
							}
						} else if launched.Load() {
							collectionAttempted.Store(true)
						}
					}
					if strings.HasSuffix(req.URL.Path, "/files/download-url") {
						if phase == "canceled-collection" {
							cancel()
						}
						return &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader("collection unavailable")), Header: http.Header{}}, nil
					}
					return http.DefaultTransport.RoundTrip(req)
				})}
				n := Node{Type: kind, Command: "printf command-evidence", Provider: "openrouter", Model: "test-model", Prompt: "test prompt"}
				if phase == "failed-collection" {
					n.Command += "; exit 7"
				}
				result := x.Execute(ctx, r, n)
				if result.Outcome != "interrupted" || !strings.Contains(result.Error, "inspect") || !strings.Contains(result.Error, "retry") {
					t.Errorf("uncertain remote result did not require inspection: %+v", result)
				}
				if result.Sandbox != r.Sandbox.ID {
					t.Errorf("sandbox evidence lost: %+v", result)
				}
				if phase == "launch" {
					if collectionAttempted.Load() {
						t.Error("collection attempted after an unconfirmed launch")
					}
					if !strings.Contains(result.Error, "launch result lost") {
						t.Errorf("launch error lost: %+v", result)
					}
				} else {
					want := "command-evidence"
					if kind == "agent" {
						want = "done"
						if result.RequestID != "response-1" || result.Usage == nil || result.Harness != "pi" {
							t.Errorf("agent evidence lost: %+v", result)
						}
					}
					if result.Output != want || !strings.Contains(result.Error, "collection unavailable") {
						t.Errorf("completed attempt evidence lost: %+v", result)
					}
					if phase == "failed-collection" && !strings.Contains(result.Error, "exit status 7") {
						t.Errorf("original command failure lost: %+v", result)
					}
					if phase == "failed-collection" && kind == "command" && result.ExitCode != 7 {
						t.Errorf("original command exit code lost: %+v", result)
					}
				}
			})
		}
	}
}

type remoteInterruptionTransport func(*http.Request) (*http.Response, error)

func (f remoteInterruptionTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}
