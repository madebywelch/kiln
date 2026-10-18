package factory

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fakeAgent37 implements the agent37 Sandbox API, the exec endpoint, and the
// per-instance gateway endpoints KILN uses. Exec is synchronous, as on the
// real service, and runs in a temporary directory standing in for /home/node.
type fakeAgent37 struct {
	t      *testing.T
	server *httptest.Server
	home   string
	bin    string

	mu            sync.Mutex
	instances     map[string]*fakeInstance
	creates       []map[string]any
	createRefusal string
	starts, stops int
	deleted       []string
	execs         int
}
type fakeInstance struct {
	id, status, template string
	autoSleep            bool
	idle                 int
}

const fakeAgent37Key = "sk_live_test_0000000000"

func newFakeAgent37(t *testing.T) *fakeAgent37 {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeAgent37{t: t, home: home, bin: t.TempDir(), instances: map[string]*fakeInstance{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}
func (f *fakeAgent37) provider() map[string]SandboxProvider {
	return map[string]SandboxProvider{"agent37": {URL: f.server.URL + "/v1", ExecURL: f.server.URL, KeyEnv: "KILN_TEST_AGENT37_KEY", IdleTimeout: "10m"}}
}
func (f *fakeAgent37) fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}
func (f *fakeAgent37) object(i *fakeInstance) map[string]any {
	return map[string]any{"id": i.id, "status": i.status, "template": i.template, "type": "default", "url": f.server.URL + "/i/" + i.id, "auto_sleep": i.autoSleep, "idle_timeout_seconds": i.idle, "past_due": false}
}
func (f *fakeAgent37) only() *fakeInstance {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.instances) != 1 {
		f.t.Fatalf("expected one instance, have %d", len(f.instances))
	}
	for _, i := range f.instances {
		return i
	}
	return nil
}
func (f *fakeAgent37) status() string {
	i := f.only()
	f.mu.Lock()
	defer f.mu.Unlock()
	return i.status
}
func (f *fakeAgent37) setStatus(status string) {
	i := f.only()
	f.mu.Lock()
	defer f.mu.Unlock()
	i.status = status
}
func (f *fakeAgent37) resolve(p string) (string, bool) {
	if strings.HasPrefix(p, "~/") {
		p = filepath.Join(f.home, p[2:])
	}
	if !filepath.IsAbs(p) {
		return "", false
	}
	p = filepath.Clean(p)
	if p != f.home && !strings.HasPrefix(p, f.home+string(filepath.Separator)) {
		return "", false
	}
	return p, true
}

func (f *fakeAgent37) handle(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case strings.HasPrefix(path, "/i/"):
		f.gateway(w, r)
	case strings.HasSuffix(path, "/exec") && strings.HasPrefix(path, "/v1/instances/"):
		if r.Header.Get("X-Agent37-Key") != fakeAgent37Key {
			f.fail(w, 401, "invalid_api_key", "bad key")
			return
		}
		f.execute(w, r, strings.TrimSuffix(strings.TrimPrefix(path, "/v1/instances/"), "/exec"))
	default:
		if r.Header.Get("Authorization") != "Bearer "+fakeAgent37Key {
			f.fail(w, 401, "invalid_api_key", "bad key")
			return
		}
		f.sandboxAPI(w, r)
	}
}

func (f *fakeAgent37) sandboxAPI(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 2 || parts[0] != "v1" || parts[1] != "instances" {
		f.fail(w, 404, "not_found", r.URL.Path)
		return
	}
	if len(parts) == 2 && r.Method == "POST" {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.creates = append(f.creates, body)
		if f.createRefusal != "" {
			f.fail(w, 402, f.createRefusal, "Add balance to your workspace and try again.")
			return
		}
		template, _ := body["template"].(string)
		idle, _ := body["idle_timeout_seconds"].(float64)
		sleep, _ := body["auto_sleep"].(bool)
		i := &fakeInstance{id: fmt.Sprintf("kiln%06d", len(f.instances)+1), status: "running", template: template, autoSleep: sleep, idle: int(idle)}
		f.instances[i.id] = i
		writeJSON(w, 201, f.object(i))
		return
	}
	f.mu.Lock()
	i, ok := f.instances[parts[2]]
	f.mu.Unlock()
	if !ok {
		f.fail(w, 404, "not_found", "unknown instance")
		return
	}
	switch {
	case len(parts) == 3 && r.Method == "GET":
		f.mu.Lock()
		defer f.mu.Unlock()
		writeJSON(w, 200, f.object(i))
	case len(parts) == 3 && r.Method == "DELETE":
		f.mu.Lock()
		delete(f.instances, i.id)
		f.deleted = append(f.deleted, i.id)
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{"id": i.id, "deleted": true})
	case len(parts) == 4 && parts[3] == "stop" && r.Method == "POST":
		f.mu.Lock()
		f.stops++
		i.status = "stopped"
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{"id": i.id, "status": "stopped"})
	case len(parts) == 4 && parts[3] == "start" && r.Method == "POST":
		f.mu.Lock()
		f.starts++
		i.status = "running"
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{"id": i.id, "status": "running"})
	default:
		f.fail(w, 404, "not_found", r.Method+" "+r.URL.Path)
	}
}

func (f *fakeAgent37) execute(w http.ResponseWriter, r *http.Request, id string) {
	f.mu.Lock()
	i, ok := f.instances[id]
	if ok {
		f.execs++
		if i.status == "sleeping" {
			i.status = "running"
		}
	}
	status := ""
	if ok {
		status = i.status
	}
	f.mu.Unlock()
	if !ok {
		f.fail(w, 404, "not_found", "unknown instance")
		return
	}
	if status != "running" {
		f.fail(w, 400, "invalid_request", "instance is "+status)
		return
	}
	var body struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Command == "" {
		f.fail(w, 400, "invalid_request", "command required")
		return
	}
	cmd := exec.Command("/bin/sh", "-c", body.Command)
	cmd.Dir = f.home
	cmd.Env = []string{"HOME=" + f.home, "PATH=" + f.bin + string(os.PathListSeparator) + os.Getenv("PATH"), "LANG=C.UTF-8", "AGENT37_INSTANCE_ID=" + id}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// The real service caps each stream at 512 KB and reports truncation.
	out, errOut := &limitedBuffer{limit: 512 << 10}, &limitedBuffer{limit: 512 << 10}
	cmd.Stdout, cmd.Stderr = out, errOut
	if err := cmd.Start(); err != nil {
		f.fail(w, 502, "provisioning_failed", err.Error())
		return
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		f.fail(w, 504, "try_again", "command timed out")
		return
	}
	writeJSON(w, 200, map[string]any{"exit_code": cmd.ProcessState.ExitCode(), "stdout": out.b.String(), "stderr": errOut.b.String(), "truncated": out.truncated || errOut.truncated})
}

type limitedBuffer struct {
	mu        sync.Mutex
	limit     int
	b         strings.Builder
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if room := b.limit - b.b.Len(); len(p) > room {
		p, b.truncated = p[:room], true
	}
	b.b.Write(p)
	return n, nil
}

func (f *fakeAgent37) gateway(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/i/")
	id, route, _ := strings.Cut(rest, "/")
	if r.Header.Get("X-Agent37-Key") != fakeAgent37Key {
		writeJSON(w, 401, map[string]any{"error": "unauthorized"})
		return
	}
	f.mu.Lock()
	i, ok := f.instances[id]
	status := ""
	if ok {
		status = i.status
	}
	f.mu.Unlock()
	if !ok {
		f.fail(w, 404, "not_found", "unknown instance")
		return
	}
	if status != "running" {
		writeJSON(w, 502, map[string]any{"error": "upstream unavailable"})
		return
	}
	switch {
	case route == "v1/health" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"ok": true, "agent": "pi", "healthy": true})
	case route == "v1/files/content":
		p, ok := f.resolve(r.URL.Query().Get("path"))
		if !ok {
			f.fail(w, 400, "validation_error", "bad path")
			return
		}
		switch r.Method {
		case "PUT":
			data, err := io.ReadAll(r.Body)
			if err != nil {
				f.fail(w, 400, "validation_error", err.Error())
				return
			}
			if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
				f.fail(w, 500, "internal_error", err.Error())
				return
			}
			if err := os.WriteFile(p, data, 0600); err != nil {
				f.fail(w, 500, "internal_error", err.Error())
				return
			}
			writeJSON(w, 200, map[string]any{"name": filepath.Base(p), "path": p, "type": "file", "size": len(data)})
		case "GET":
			data, err := os.ReadFile(p)
			if err != nil {
				f.fail(w, 404, "file_not_found", err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.WriteHeader(200)
			_, _ = w.Write(data)
		default:
			f.fail(w, 405, "method_not_allowed", r.Method)
		}
	default:
		f.fail(w, 404, "not_found", route)
	}
}
