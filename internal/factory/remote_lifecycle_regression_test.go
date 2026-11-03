package factory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRemoteMutationsDoNotReplayAmbiguousServerErrors(t *testing.T) {
	for _, provider := range []string{"boat", "agent37"} {
		operations := []string{"exec", "launch"}
		statuses := []int{500, 503}
		if provider == "agent37" {
			operations = []string{"exec", "create"}
			statuses = []int{502, 503, 504}
		}
		for _, operation := range operations {
			for _, status := range statuses {
				t.Run(fmt.Sprintf("%s/%s/%d", provider, operation, status), func(t *testing.T) {
					var calls atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if calls.Add(1) == 1 {
							http.Error(w, "gateway lost the operation result", status)
							return
						}
						_, _ = w.Write([]byte(`{"exitCode":0,"processId":123,"exit_code":0,"id":"instance-2","url":"https://example.invalid"}`))
					}))
					defer server.Close()
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					var err error
					if provider == "boat" {
						c := &boatClient{base: server.URL, http: server.Client()}
						if operation == "exec" {
							_, err = c.run(ctx, "instance", "side effect", time.Minute)
						} else {
							_, err = c.start(ctx, "instance", "side effect")
						}
					} else {
						c := &agent37Client{base: server.URL, exec: server.URL, http: server.Client()}
						if operation == "exec" {
							_, err = c.run(ctx, "instance", "side effect")
						} else {
							_, err = c.create(ctx, map[string]any{"template": "test"})
						}
					}
					if calls.Load() != 1 || err == nil {
						t.Fatalf("ambiguous operation replayed: requests=%d error=%v", calls.Load(), err)
					}
				})
			}
		}
	}
}

func TestRemoteMutationsRetryExplicitRefusals(t *testing.T) {
	for _, tc := range []struct {
		name, provider, body string
		status               int
	}{
		{"boat-capacity", "boat", `{"code":"out_of_capacity","retryAfterSeconds":0.001}`, 503},
		{"boat-restoring", "boat", `{"code":"sandbox_direct_failed","retryAfterSeconds":0.001,"error":{"details":{"retryable":true}}}`, 502},
		{"agent37-capacity", "agent37", `{"error":{"code":"no_capacity"}}`, 503},
		{"agent37-rate-limit", "agent37", `{"error":{"code":"rate_limited"}}`, 429},
	} {
		for _, operation := range []string{"exec", "launch-or-create"} {
			t.Run(tc.name+"/"+operation, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if calls.Add(1) == 1 {
						w.WriteHeader(tc.status)
						_, _ = w.Write([]byte(tc.body))
						return
					}
					_, _ = w.Write([]byte(`{"exitCode":0,"processId":123,"exit_code":0,"id":"instance","url":"https://example.invalid"}`))
				}))
				defer server.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				var err error
				if tc.provider == "boat" {
					c := &boatClient{base: server.URL, http: server.Client()}
					if operation == "exec" {
						_, err = c.run(ctx, "instance", "side effect", time.Minute)
					} else {
						_, err = c.start(ctx, "instance", "side effect")
					}
				} else {
					c := &agent37Client{base: server.URL, exec: server.URL, http: server.Client()}
					if operation == "exec" {
						_, err = c.run(ctx, "instance", "side effect")
					} else {
						_, err = c.create(ctx, map[string]any{"template": "test"})
					}
				}
				if calls.Load() != 2 || err != nil {
					t.Fatalf("safe refusal not retried: requests=%d error=%v", calls.Load(), err)
				}
			})
		}
	}
}

type localLifecycleMachine struct{ machine }

func (localLifecycleMachine) download(ctx context.Context, r Run, path string, limit int64) ([]byte, error) {
	return os.ReadFile(path)
}

func (localLifecycleMachine) exec(ctx context.Context, r Run, script string, timeout time.Duration) (string, error) {
	result := process(ctx, "", os.Environ(), "", "sh", "-c", script)
	if result.Outcome != "success" {
		return "", errors.New(result.Error + ": " + result.Output)
	}
	return result.Output, nil
}

func TestRemoteSyncRefusesLiveLeaseBeforeMutatingFiles(t *testing.T) {
	for _, operation := range []string{"push", "pull"} {
		t.Run(operation, func(t *testing.T) {
			root := t.TempDir()
			l := remoteLayout{root: root}
			for _, dir := range []string{l.work(), l.artifacts(), filepath.Join(root, "attempts"), filepath.Join(root, "sync")} {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			stale := exec.Command("sleep", "30")
			if err := stale.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = stale.Process.Kill(); _ = stale.Wait() }()
			lease := filepath.Join(root, "lease.pid")
			if err := os.WriteFile(lease, []byte(strconv.Itoa(stale.Process.Pid)), 0600); err != nil {
				t.Fatal(err)
			}
			pending := filepath.Join(root, "sync", "out.tar")
			if err := os.WriteFile(pending, []byte("uncollected evidence"), 0600); err != nil {
				t.Fatal(err)
			}
			x := &Executor{Root: t.TempDir()}
			m := localLifecycleMachine{}
			r := Run{}
			var err error
			if operation == "push" {
				err = x.pushWorkspace(context.Background(), m, r, l, l.work(), false, nil, nil)
			} else {
				err = x.pullWorkspace(context.Background(), m, r, l, l.work(), false, "attempt")
			}
			if err == nil || !strings.Contains(err.Error(), "still running") {
				t.Fatalf("live remote lease did not reject synchronization: %v", err)
			}
			if got, err := os.ReadFile(pending); err != nil || string(got) != "uncollected evidence" {
				t.Fatalf("live attempt evidence was mutated: %q, %v", got, err)
			}
			if result := failed(err); result.ExitCode != remoteLeaseExit {
				t.Fatalf("lease refusal lost its exit code: %+v", result)
			}
		})
	}
}

func TestRemoteLaunchTerminatesOnFollowFailure(t *testing.T) {
	for _, provider := range []string{"boat", "agent37"} {
		for _, failure := range []string{"protocol", "output"} {
			t.Run(provider+"/"+failure, func(t *testing.T) {
				var terminated atomic.Bool
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if provider == "boat" {
						switch {
						case r.Method == "DELETE":
							terminated.Store(true)
							_, _ = w.Write([]byte(`{}`))
						case strings.HasSuffix(r.URL.Path, "/stream"):
							if failure == "protocol" {
								_, _ = w.Write([]byte("invalid frame\n"))
							} else {
								_, _ = w.Write([]byte("{\"type\":\"stdout\",\"data\":\"hello\",\"nextOffset\":5}\n"))
							}
						default:
							_, _ = w.Write([]byte(`{"processId":123}`))
						}
						return
					}
					var body struct{ Command string }
					_ = json.NewDecoder(r.Body).Decode(&body)
					out := agent37Exec{}
					switch {
					case strings.Contains(body.Command, "pgid=123"):
						terminated.Store(true)
					case strings.Contains(body.Command, "setsid"):
						out.Stdout = "123\n"
					default:
						out.Stdout = "malformed poll"
						if failure == "output" {
							out.Stdout = "running\naGVsbG8=\n\n"
						}
					}
					_ = json.NewEncoder(w).Encode(out)
				}))
				defer server.Close()
				var m machine = &boatMachine{client: &boatClient{base: server.URL, http: server.Client()}}
				if provider == "agent37" {
					m = &agent37Machine{client: &agent37Client{exec: server.URL, http: server.Client()}}
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				r := Run{Sandbox: &SandboxState{ID: "instance"}}
				write := func([]byte) error { return errors.New("output sink failed") }
				wait, _, err := m.launch(ctx, r, remoteLayout{root: "/test"}, "attempt", write, write)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := wait(); err == nil {
					t.Fatal("follow failure was not returned")
				}
				if ctx.Err() != nil {
					t.Fatal("test must exercise a non-cancellation follow error")
				}
				if !terminated.Load() {
					t.Fatal("wait returned while the detached process was left running")
				}
			})
		}
	}
}
