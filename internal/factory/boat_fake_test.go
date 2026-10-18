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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fakeBoat implements the subset of the boat.dev v1 API that KILN uses. A
// temporary directory stands in for the sandbox user's home and commands run
// locally, so the remote execution path is exercised end to end offline.
type fakeBoat struct {
	t      *testing.T
	server *httptest.Server
	home   string
	bin    string
	key    string

	mu             sync.Mutex
	sandboxes      map[string]*fakeSandbox
	idempotency    map[string]string
	creates        []map[string]any
	createHeaders  []http.Header
	createFailures int
	createRefusal  string
	ttls           []int
	resumes        int
	stops          int
	deletes        []http.Header
	signed         map[string]string
	procs          map[int]*fakeProcess
	reconnected    map[int]bool
	nextToken      int
}
type fakeSandbox struct {
	id, state, typ string
	gets           int
	deleted        bool
}
type fakeProcess struct {
	cmd      *exec.Cmd
	stdout   string
	stderr   string
	done     chan struct{}
	exitCode int
	signal   string
}

const fakeBoatKey = "boat_test_key_0000000000"

func newFakeBoat(t *testing.T) *fakeBoat {
	t.Helper()
	// A canonical home keeps $PWD inside the sandbox equal to the paths KILN sends.
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeBoat{t: t, home: home, bin: t.TempDir(), key: fakeBoatKey, sandboxes: map[string]*fakeSandbox{}, idempotency: map[string]string{}, signed: map[string]string{}, procs: map[int]*fakeProcess{}, reconnected: map[int]bool{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(func() {
		f.server.Close()
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, p := range f.procs {
			f.killProcess(p)
		}
	})
	return f
}

func (f *fakeBoat) provider() map[string]SandboxProvider {
	return map[string]SandboxProvider{"boat": {URL: f.server.URL, KeyEnv: "KILN_TEST_BOAT_KEY", IdleTimeout: "30m"}}
}
func (f *fakeBoat) fail(w http.ResponseWriter, status int, code, message string, extra map[string]any) {
	body := map[string]any{"ok": false, "type": "sandbox.error", "status": status, "code": code, "message": message, "requestId": "req_test", "error": map[string]any{"code": code, "message": message, "status": status}}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, body)
}
func (f *fakeBoat) sandboxJSON(s *fakeSandbox) map[string]any {
	return map[string]any{"id": s.id, "name": s.id, "state": s.state, "type": s.typ, "desktopAvailable": false, "snapshotAvailable": true}
}
func (f *fakeBoat) resolve(p string) (string, bool) {
	if p == "" {
		return "", false
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(f.home, p)
	}
	p = filepath.Clean(p)
	if p != f.home && !strings.HasPrefix(p, f.home+string(filepath.Separator)) {
		return "", false
	}
	return p, true
}
func (f *fakeBoat) only() *fakeSandbox {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sandboxes) != 1 {
		f.t.Fatalf("expected one sandbox, have %d", len(f.sandboxes))
	}
	for _, s := range f.sandboxes {
		return s
	}
	return nil
}

// archive simulates the provider's idle auto-stop.
func (f *fakeBoat) archive(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sandboxes[id].state = "archived"
	for _, p := range f.procs {
		f.killProcess(p)
	}
}
func (f *fakeBoat) killProcess(p *fakeProcess) {
	if p.cmd.Process != nil {
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func (f *fakeBoat) handle(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/signed/") {
		f.signedFile(w, r)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.key {
		f.fail(w, 401, "unauthorized", "bad key", nil)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 1 && parts[0] == "sandboxes" && r.Method == "POST" {
		f.create(w, r)
		return
	}
	if len(parts) < 2 || parts[0] != "sandboxes" {
		f.fail(w, 404, "not_found", r.URL.Path, nil)
		return
	}
	f.mu.Lock()
	s, ok := f.sandboxes[parts[1]]
	f.mu.Unlock()
	if !ok || s.deleted {
		f.fail(w, 404, "not_found", "unknown sandbox", nil)
		return
	}
	rest := parts[2:]
	switch {
	case len(rest) == 0 && r.Method == "GET":
		f.mu.Lock()
		s.gets++
		if s.state == "provisioning" && s.gets > 1 {
			s.state = "ready"
		}
		body := f.sandboxJSON(s)
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "type": "sandbox.get", "sandbox": body})
	case len(rest) == 0 && r.Method == "PATCH":
		var body struct {
			TTL int `json:"ttlSeconds"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.ttls = append(f.ttls, body.TTL)
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "type": "sandbox.updated", "sandbox": f.sandboxJSON(s)})
	case len(rest) == 0 && r.Method == "DELETE":
		f.mu.Lock()
		f.deletes = append(f.deletes, r.Header.Clone())
		if r.Header.Get("X-Ascii-Confirm-Delete") != s.id {
			f.mu.Unlock()
			f.fail(w, 409, "confirm_mismatch", "confirmation header must equal the sandbox id", nil)
			return
		}
		s.deleted = true
		for _, p := range f.procs {
			f.killProcess(p)
		}
		f.mu.Unlock()
		writeJSON(w, 202, map[string]any{"ok": true, "type": "sandbox.deleting", "operation": map[string]any{"id": "bdop_" + strings.Repeat("0", 32), "status": "pending"}})
	case len(rest) == 1 && rest[0] == "stop" && r.Method == "POST":
		f.mu.Lock()
		f.stops++
		s.state = "archived"
		for _, p := range f.procs {
			f.killProcess(p)
		}
		f.mu.Unlock()
		writeJSON(w, 202, map[string]any{"ok": true, "type": "sandbox.stopping", "id": "stop_1", "sandbox": f.sandboxJSON(s)})
	case len(rest) == 1 && rest[0] == "resume" && r.Method == "POST":
		f.mu.Lock()
		if s.state != "archived" {
			f.mu.Unlock()
			f.fail(w, 409, "sandbox_running_stop_first", "already running", nil)
			return
		}
		f.resumes++
		s.state, s.gets = "provisioning", 0
		f.mu.Unlock()
		writeJSON(w, 202, map[string]any{"ok": true, "type": "sandbox.resuming", "sandbox": f.sandboxJSON(s)})
	case len(rest) == 1 && rest[0] == "commands" && r.Method == "POST":
		f.command(w, r, s)
	case len(rest) == 3 && rest[0] == "commands" && rest[2] == "stream" && r.Method == "GET":
		f.stream(w, r, rest[1])
	case len(rest) == 2 && rest[0] == "commands" && r.Method == "DELETE":
		pid, _ := strconv.Atoi(rest[1])
		f.mu.Lock()
		p, ok := f.procs[pid]
		f.mu.Unlock()
		if !ok {
			f.fail(w, 404, "not_found", "unknown process", nil)
			return
		}
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-p.done:
		case <-time.After(500 * time.Millisecond):
			f.killProcess(p)
			<-p.done
		}
		writeJSON(w, 200, map[string]any{"ok": true, "type": "command.stopped", "processId": pid, "running": false, "signaled": true})
	case len(rest) == 2 && rest[0] == "files" && (rest[1] == "upload-url" || rest[1] == "download-url") && r.Method == "POST":
		var body struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		p, ok := f.resolve(body.Path)
		if !ok {
			f.fail(w, 400, "invalid_path", body.Path, nil)
			return
		}
		f.mu.Lock()
		f.nextToken++
		token := strconv.Itoa(f.nextToken)
		f.signed[token] = p
		f.mu.Unlock()
		method := "PUT"
		if rest[1] == "download-url" {
			method = "GET"
		}
		writeJSON(w, 200, map[string]any{"ok": true, "type": "file." + strings.ReplaceAll(rest[1], "-", "_"), "url": f.server.URL + "/signed/" + token, "method": method, "path": p, "expiresAt": time.Now().Add(15 * time.Minute)})
	default:
		f.fail(w, 404, "not_found", r.Method+" "+r.URL.Path, nil)
	}
}

func (f *fakeBoat) create(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		f.fail(w, 400, "invalid_json", err.Error(), nil)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates = append(f.creates, body)
	f.createHeaders = append(f.createHeaders, r.Header.Clone())
	if f.createFailures > 0 {
		f.createFailures--
		f.fail(w, 503, "out_of_capacity", "no machines", map[string]any{"retryAfterSeconds": 0.01})
		return
	}
	if f.createRefusal != "" {
		f.fail(w, 402, f.createRefusal, "Start the $20/month Boat plan to create sandboxes.", nil)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if id, ok := f.idempotency[key]; ok && key != "" {
		writeJSON(w, 202, map[string]any{"ok": true, "type": "sandbox.created", "sandbox": f.sandboxJSON(f.sandboxes[id])})
		return
	}
	typ, _ := body["type"].(string)
	if typ == "" {
		typ = "default"
	}
	s := &fakeSandbox{id: fmt.Sprintf("bx_%08d", len(f.sandboxes)+1), state: "provisioning", typ: typ}
	f.sandboxes[s.id] = s
	if key != "" {
		f.idempotency[key] = s.id
	}
	writeJSON(w, 202, map[string]any{"ok": true, "type": "sandbox.created", "sandbox": f.sandboxJSON(s)})
}

func (f *fakeBoat) command(w http.ResponseWriter, r *http.Request, s *fakeSandbox) {
	var body struct {
		Command        string `json:"command"`
		Detached       bool   `json:"detached"`
		TimeoutSeconds int    `json:"timeoutSeconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		f.fail(w, 400, "invalid_json", err.Error(), nil)
		return
	}
	f.mu.Lock()
	state := s.state
	f.mu.Unlock()
	if state != "ready" && state != "idle" && state != "running" {
		f.fail(w, 409, "machine_not_running", "sandbox is "+state, nil)
		return
	}
	cmd := exec.Command("/bin/sh", "-c", body.Command)
	cmd.Dir = f.home
	cmd.Env = []string{"HOME=" + f.home, "PATH=" + f.bin + string(os.PathListSeparator) + os.Getenv("PATH"), "LANG=C.UTF-8", "BOAT_ID=" + s.id, "KILN_TEST_SANDBOX_MARKER=inside"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if !body.Detached {
		out, errOut := &cappedBuffer{}, &cappedBuffer{}
		cmd.Stdout, cmd.Stderr = out, errOut
		if err := cmd.Start(); err != nil {
			f.fail(w, 500, "http_500", err.Error(), nil)
			return
		}
		timeout := time.Duration(body.TimeoutSeconds) * time.Second
		if timeout == 0 {
			timeout = 30 * time.Second
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		timedOut := false
		select {
		case <-done:
		case <-time.After(timeout):
			timedOut = true
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-done
		}
		code := cmd.ProcessState.ExitCode()
		writeJSON(w, 200, map[string]any{"ok": true, "type": "command.finished", "success": code == 0 && !timedOut, "exitCode": code, "stdout": out.b.String(), "stderr": errOut.b.String(), "timedOut": timedOut})
		return
	}
	dir := filepath.Join(f.home, ".ascii", "processes")
	if err := os.MkdirAll(dir, 0700); err != nil {
		f.fail(w, 500, "http_500", err.Error(), nil)
		return
	}
	stdout, err := os.CreateTemp(dir, "out-*.log")
	if err != nil {
		f.fail(w, 500, "http_500", err.Error(), nil)
		return
	}
	stderr, err := os.CreateTemp(dir, "err-*.log")
	if err != nil {
		f.fail(w, 500, "http_500", err.Error(), nil)
		return
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		f.fail(w, 500, "http_500", err.Error(), nil)
		return
	}
	p := &fakeProcess{cmd: cmd, stdout: stdout.Name(), stderr: stderr.Name(), done: make(chan struct{})}
	pid := cmd.Process.Pid
	f.mu.Lock()
	f.procs[pid] = p
	f.mu.Unlock()
	go func() {
		err := cmd.Wait()
		stdout.Close()
		stderr.Close()
		p.exitCode = cmd.ProcessState.ExitCode()
		if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			p.signal = status.Signal().String()
		}
		_ = err
		close(p.done)
	}()
	writeJSON(w, 200, map[string]any{"ok": true, "type": "command.started", "success": true, "processId": pid, "pid": pid, "command": body.Command, "startedAt": time.Now(), "logPath": p.stdout})
}

func (f *fakeBoat) stream(w http.ResponseWriter, r *http.Request, id string) {
	pid, _ := strconv.Atoi(id)
	f.mu.Lock()
	p, ok := f.procs[pid]
	f.mu.Unlock()
	if !ok {
		f.fail(w, 404, "not_found", "unknown process", nil)
		return
	}
	outOff, _ := strconv.ParseInt(r.URL.Query().Get("stdoutOffset"), 10, 64)
	errOff, _ := strconv.ParseInt(r.URL.Query().Get("stderrOffset"), 10, 64)
	w.Header().Set("Content-Type", "application/x-ndjson")
	flusher := w.(http.Flusher)
	emit := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = w.Write(append(b, '\n'))
		flusher.Flush()
	}
	emit(map[string]any{"type": "attached", "processId": pid, "stdoutOffset": outOff, "stderrOffset": errOff})
	read := func(path string, off *int64, kind string) bool {
		data, err := os.ReadFile(path)
		if err != nil || int64(len(data)) <= *off {
			return false
		}
		chunk := data[*off:]
		*off += int64(len(chunk))
		emit(map[string]any{"type": kind, "data": string(chunk), "nextOffset": *off})
		return true
	}
	for {
		delivered := read(p.stdout, &outOff, "stdout")
		delivered = read(p.stderr, &errOff, "stderr") || delivered
		// Exercise the client's reconnection once per process.
		f.mu.Lock()
		reconnect := delivered && !f.reconnected[pid]
		if reconnect {
			f.reconnected[pid] = true
		}
		f.mu.Unlock()
		if reconnect {
			emit(map[string]any{"type": "reconnect", "stdoutOffset": outOff, "stderrOffset": errOff})
			return
		}
		select {
		case <-p.done:
			read(p.stdout, &outOff, "stdout")
			read(p.stderr, &errOff, "stderr")
			exit := map[string]any{"type": "exit", "status": "exited", "exitCode": p.exitCode, "signal": nil, "stdoutOffset": outOff, "stderrOffset": errOff}
			if p.signal != "" {
				exit["signal"] = p.signal
			}
			emit(exit)
			return
		case <-r.Context().Done():
			return
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (f *fakeBoat) signedFile(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.URL.Path, "/signed/")
	f.mu.Lock()
	p, ok := f.signed[token]
	f.mu.Unlock()
	if !ok {
		f.fail(w, 404, "not_found", "unknown signed url", nil)
		return
	}
	switch r.Method {
	case "PUT":
		data, err := io.ReadAll(r.Body)
		if err != nil {
			f.fail(w, 400, "invalid_body", err.Error(), nil)
			return
		}
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			f.fail(w, 500, "http_500", err.Error(), nil)
			return
		}
		if err := os.WriteFile(p, data, 0600); err != nil {
			f.fail(w, 500, "http_500", err.Error(), nil)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	case "GET":
		data, err := os.ReadFile(p)
		if err != nil {
			f.fail(w, 404, "not_found", err.Error(), nil)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(200)
		_, _ = w.Write(data)
	default:
		f.fail(w, 405, "method_not_allowed", r.Method, nil)
	}
}
