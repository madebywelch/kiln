package factory

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEngineStopsAfterLostRemoteLaunchResponse(t *testing.T) {
	f := newFakeBoat(t)
	var launches atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/commands") {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			var command struct{ Detached bool }
			if err := json.Unmarshal(body, &command); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			if command.Detached && launches.Add(1) == 1 {
				recorder := httptest.NewRecorder()
				f.handle(recorder, r)
				var started struct{ ProcessID int }
				if err := json.Unmarshal(recorder.Body.Bytes(), &started); err != nil || started.ProcessID == 0 {
					t.Errorf("launch fixture failed: %s", recorder.Body.String())
					http.Error(w, "fixture failed", 500)
					return
				}
				f.mu.Lock()
				process := f.procs[started.ProcessID]
				f.mu.Unlock()
				select {
				case <-process.done:
				case <-r.Context().Done():
					return
				}
				http.Error(w, "launch response lost after execution", 500)
				return
			}
		}
		f.handle(w, r)
	}))
	defer proxy.Close()
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	providers := f.provider()
	provider := providers["boat"]
	provider.URL = proxy.URL
	providers["boat"] = provider
	x := &Executor{Root: root, AllowLocal: true, Sandboxes: providers}
	e, err := NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	defer func() {
		if e != nil {
			e.Close()
		}
	}()
	w := sandboxWorkflow(t)
	w.Nodes["work"] = Node{Type: "command", Command: "printf x >> file.txt", Next: map[string]string{"success": "end", "failure": "repair"}}
	w.Nodes["repair"] = Node{Type: "command", Command: "printf overwritten > file.txt", Next: map[string]string{"success": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "interrupted" || !strings.Contains(r.Error, "inspect") {
		t.Fatalf("unknown remote outcome did not stop the graph: status=%s error=%s", r.Status, r.Error)
	}
	waitRun(t, e, r.ID, func(r Run) bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return e.active[r.ID] == nil
	})
	e.Close()
	e, err = NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	time.Sleep(350 * time.Millisecond)
	r, err = e.GetRun(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != "interrupted" || launches.Load() != 1 || r.Visits["repair"] != 0 {
		t.Fatalf("restart advanced an uncertain run: %+v launches=%d", r, launches.Load())
	}
	b, err := os.ReadFile(filepath.Join(layoutFor(r).work(), "file.txt"))
	if err != nil || string(b) != "original\nx" {
		t.Fatalf("uncollected remote changes were overwritten: %q %v", b, err)
	}
}

func TestRecoveryDoesNotReplayJournaledInterruption(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	x := &Executor{Root: root}
	r, err := x.Prepare(context.Background(), makeRun(basicWorkflow(), "rev", "", nil))
	if err != nil {
		t.Fatal(err)
	}
	r.Prepared, r.Status, r.Current = true, "running", "work"
	finished := now()
	result := Result{Outcome: "interrupted", Error: "inspect remote sandbox before retrying", Output: "retained evidence"}
	r.Attempts = []Attempt{{ID: newID(), Node: "work", StartedAt: finished, FinishedAt: &finished, Result: result}}
	r.Outputs["work"] = result
	if err := s.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	e, err := NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	defer e.Close()
	time.Sleep(350 * time.Millisecond)
	r, err = e.GetRun(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != "interrupted" || len(r.Attempts) != 1 || r.Attempts[0].Result != result {
		t.Fatalf("journaled interruption was replayed or its evidence lost: %+v", r)
	}
	if _, err := e.Retry(r.ID); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" {
		t.Fatalf("explicitly acknowledged retry did not recover: %+v", r)
	}
}
