package factory

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestHardCrashRecoveryHelper(t *testing.T) {
	root := os.Getenv("KILN_CRASH_TEST_ROOT")
	if root == "" {
		return
	}
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, err := NewEngine(s, &Executor{Root: root}, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	defer e.Close()
	w := basicWorkflow()
	if os.Getenv("KILN_CRASH_TEST_GATE") == "1" {
		w.Nodes["work"] = Node{Type: "human", Prompt: "Continue?", Choices: []string{"approve", "reject"}, Next: map[string]string{"approve": "end", "reject": "end"}}
	} else {
		w.Nodes["work"] = Node{Type: "command", Command: "printf x >> executions; printf '%s' \"$$\" > pid; while [ ! -f release ]; do sleep 0.05; done", Next: map[string]string{"success": "end"}}
	}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, func(r Run) bool {
		if r.Status == "waiting" {
			return true
		}
		if !r.Prepared {
			return false
		}
		b, err := os.ReadFile(filepath.Join(r.Workspace, "pid"))
		_, parseErr := strconv.Atoi(string(b))
		return err == nil && parseErr == nil
	})
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ready.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Second)
	t.Fatal("parent did not terminate crash fixture")
}

func TestHardCrashRecovery(t *testing.T) {
	for _, gate := range []bool{false, true} {
		t.Run(map[bool]string{false: "external-operation", true: "human-gate"}[gate], func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			log, err := os.Create(filepath.Join(root, "child.log"))
			if err != nil {
				t.Fatal(err)
			}
			defer log.Close()
			child := exec.Command(os.Args[0], "-test.run=^TestHardCrashRecoveryHelper$", "-test.timeout=40s")
			child.Env = append(os.Environ(), "KILN_CRASH_TEST_ROOT="+root, "KILN_CRASH_TEST_GATE="+map[bool]string{false: "0", true: "1"}[gate])
			child.Stdout, child.Stderr = log, log
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			orphanStopped := false
			defer func() {
				_ = child.Process.Kill()
				_ = child.Wait()
				if orphanStopped {
					return
				}
				paths, _ := filepath.Glob(filepath.Join(root, "workspaces", "*", "pid"))
				for _, path := range paths {
					b, _ := os.ReadFile(path)
					if pid, err := strconv.Atoi(string(b)); err == nil && pid > 1 {
						_ = unix.Kill(-pid, unix.SIGKILL)
					}
				}
			}()
			var before Run
			deadline := time.Now().Add(15 * time.Second)
			for {
				b, err := os.ReadFile(filepath.Join(root, "ready.json"))
				if err == nil && json.Unmarshal(b, &before) == nil {
					break
				}
				if time.Now().After(deadline) {
					output, _ := os.ReadFile(log.Name())
					t.Fatalf("crash fixture did not become ready: %s", output)
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := child.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := child.Wait(); err == nil {
				t.Fatal("fixture exited without a hard kill")
			}
			s, err := OpenStore(root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			e, err := NewEngine(s, &Executor{Root: root}, 1)
			if err != nil {
				t.Fatal(err)
			}
			e.Start()
			defer e.Close()
			time.Sleep(350 * time.Millisecond)
			after, err := e.GetRun(before.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(after.Attempts) != len(before.Attempts) {
				t.Fatal("restart repeated work without an explicit decision")
			}
			if gate {
				if after.Status != "waiting" || after.Question == nil || after.Question.ID != before.Question.ID {
					t.Fatalf("restart lost the pending question: %+v", after)
				}
				if _, err := e.Decide(after.ID, Decision{QuestionID: after.Question.ID, Choice: "approve"}); err != nil {
					t.Fatal(err)
				}
			} else {
				if after.Status != "interrupted" {
					t.Fatalf("ambiguous operation was not interrupted: %+v", after)
				}
				if _, err := e.Retry(after.ID); !errors.Is(err, ErrConflict) {
					t.Fatalf("surviving process did not block retry: %v", err)
				}
				b, err := os.ReadFile(filepath.Join(after.Workspace, "pid"))
				if err != nil {
					t.Fatal(err)
				}
				pid, err := strconv.Atoi(string(b))
				if err != nil || pid <= 1 {
					t.Fatalf("invalid command pid: %q", b)
				}
				if err := unix.Kill(-pid, unix.SIGKILL); err != nil {
					t.Fatal(err)
				}
				orphanStopped = true
				if err := os.WriteFile(filepath.Join(after.Workspace, "release"), nil, 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := e.Retry(after.ID); err != nil {
					t.Fatal(err)
				}
			}
			after = waitRun(t, e, after.ID, settled)
			if after.Status != "succeeded" {
				t.Fatalf("explicit recovery failed: %+v", after)
			}
			if !gate {
				b, err := os.ReadFile(filepath.Join(after.Workspace, "executions"))
				if err != nil || string(b) != "xx" {
					t.Fatalf("expected only the original and acknowledged attempts, got %q: %v", b, err)
				}
			}
		})
	}
}
