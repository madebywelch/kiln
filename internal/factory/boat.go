package factory

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Minimal client for the boat.dev v1 API: only the calls KILN needs to run a
// job on one dedicated virtual machine. No SDK dependency; the surface is small
// and every response is checked against its documented envelope.
type boatClient struct {
	base string
	key  string
	http *http.Client
}

type boatError struct {
	Status     int
	Code       string
	Message    string
	RequestID  string
	Retryable  bool
	RetryAfter time.Duration
}

func (e *boatError) Error() string {
	s := fmt.Sprintf("boat API HTTP %d", e.Status)
	if e.Code != "" {
		s += " " + e.Code
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	if e.RequestID != "" {
		s += " (request " + e.RequestID + ")"
	}
	return s
}

// transient reports whether the documented contract says a retry is safe.
func (e *boatError) transient() bool {
	switch {
	case e.Status == 503, e.Status == 500:
		return true
	case e.Status == 429 && e.Code == "IP_RATE_LIMIT_EXCEEDED":
		return true
	case e.Status == 409 && (e.Code == "sandbox_starting" || e.Code == "sandbox_resuming" || e.Code == "idempotency_in_progress" || e.Code == "sandbox_securing"):
		return true
	case e.Status == 502 && e.Retryable:
		return true
	}
	return false
}

type boatSandbox struct {
	ID           string     `json:"id"`
	State        string     `json:"state"`
	Type         string     `json:"type"`
	Error        *string    `json:"error"`
	TTLSeconds   *int       `json:"ttlSeconds"`
	ArchiveAfter *time.Time `json:"archiveAfter"`
	Stop         *struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"stop"`
}

type boatCreateRequest struct {
	Type       string            `json:"type,omitempty"`
	From       string            `json:"from,omitempty"`
	TTLSeconds int               `json:"ttlSeconds"`
	NoEnv      bool              `json:"noEnv"`
	Monitoring bool              `json:"monitoring"`
	Env        map[string]string `json:"env,omitempty"`
}

type boatCommandResult struct {
	ExitCode *int   `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timedOut"`
}

func (c *boatClient) do(ctx context.Context, method, path string, headers map[string]string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.base, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("boat API %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil {
		return fmt.Errorf("boat API %s %s: %w", method, path, err)
	}
	if len(data) > 16<<20 {
		return fmt.Errorf("boat API %s %s: response exceeds 16 MiB", method, path)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return decodeBoatError(resp.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("boat API %s %s: invalid response: %w", method, path, err)
	}
	return nil
}

func decodeBoatError(status int, data []byte) error {
	e := &boatError{Status: status}
	var body struct {
		Code              string  `json:"code"`
		Message           string  `json:"message"`
		RequestID         string  `json:"requestId"`
		RetryAfter        float64 `json:"retryAfter"`
		RetryAfterSeconds float64 `json:"retryAfterSeconds"`
		Error             struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Details struct {
				Retryable bool `json:"retryable"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil {
		e.Code, e.Message, e.RequestID, e.Retryable = body.Code, body.Message, body.RequestID, body.Error.Details.Retryable
		if e.Code == "" {
			e.Code = body.Error.Code
		}
		if e.Message == "" {
			e.Message = body.Error.Message
		}
		seconds := body.RetryAfterSeconds
		if seconds == 0 {
			seconds = body.RetryAfter
		}
		e.RetryAfter = time.Duration(seconds * float64(time.Second))
	}
	if e.Message == "" {
		e.Message = strings.TrimSpace(string(data[:min(len(data), 512)]))
	}
	return e
}

// retry repeats an operation whose repetition the API documents as safe,
// pacing by the body's retryAfter when present, until the context ends.
func retry(ctx context.Context, op func() error) error {
	delay := time.Second
	for {
		err := op()
		var be *boatError
		if err == nil || !errors.As(err, &be) || !be.transient() {
			return err
		}
		wait := delay
		if be.RetryAfter > 0 {
			wait = be.RetryAfter
		}
		if wait > 30*time.Second {
			wait = 30 * time.Second
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w (last error: %v)", ctx.Err(), err)
		case <-time.After(wait):
		}
		if delay < 10*time.Second {
			delay *= 2
		}
	}
}

func (c *boatClient) create(ctx context.Context, req boatCreateRequest, idempotencyKey string) (boatSandbox, error) {
	var out struct {
		Sandbox boatSandbox `json:"sandbox"`
	}
	err := retry(ctx, func() error {
		return c.do(ctx, "POST", "/sandboxes", map[string]string{"Idempotency-Key": idempotencyKey}, req, &out)
	})
	if err == nil && out.Sandbox.ID == "" {
		err = errors.New("boat API returned no sandbox id")
	}
	return out.Sandbox, err
}
func (c *boatClient) get(ctx context.Context, id string) (boatSandbox, error) {
	var out struct {
		Sandbox boatSandbox `json:"sandbox"`
	}
	err := retry(ctx, func() error { return c.do(ctx, "GET", "/sandboxes/"+id, nil, nil, &out) })
	return out.Sandbox, err
}
func (c *boatClient) extend(ctx context.Context, id string, ttlSeconds int) error {
	return retry(ctx, func() error {
		return c.do(ctx, "PATCH", "/sandboxes/"+id, nil, map[string]any{"ttlSeconds": ttlSeconds}, nil)
	})
}
func (c *boatClient) stop(ctx context.Context, id string) error {
	return retry(ctx, func() error { return c.do(ctx, "POST", "/sandboxes/"+id+"/stop", nil, map[string]any{}, nil) })
}
func (c *boatClient) resume(ctx context.Context, id string, ttlSeconds int) error {
	return retry(ctx, func() error {
		return c.do(ctx, "POST", "/sandboxes/"+id+"/resume", nil, map[string]any{"ttlSeconds": ttlSeconds}, nil)
	})
}
func (c *boatClient) delete(ctx context.Context, id string) error {
	err := retry(ctx, func() error {
		return c.do(ctx, "DELETE", "/sandboxes/"+id, map[string]string{"X-Ascii-Confirm-Delete": id}, nil, nil)
	})
	var be *boatError
	if errors.As(err, &be) && be.Status == 404 {
		return nil
	}
	return err
}

// run executes a short command synchronously. The API caps this at 600 s;
// node processes use start/attach instead.
func (c *boatClient) run(ctx context.Context, id, command string, timeout time.Duration) (boatCommandResult, error) {
	seconds := int(timeout / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 600 {
		seconds = 600
	}
	var out boatCommandResult
	err := retry(ctx, func() error {
		// A command may already have run when the transport fails without the
		// documented retryable flag, so only retryable errors repeat it.
		return c.do(ctx, "POST", "/sandboxes/"+id+"/commands", nil, map[string]any{"command": command, "timeoutSeconds": seconds}, &out)
	})
	return out, err
}
func (c *boatClient) start(ctx context.Context, id, command string) (int, error) {
	var out struct {
		ProcessID int `json:"processId"`
	}
	err := retry(ctx, func() error {
		return c.do(ctx, "POST", "/sandboxes/"+id+"/commands", nil, map[string]any{"command": command, "detached": true}, &out)
	})
	if err == nil && out.ProcessID == 0 {
		err = errors.New("boat API returned no process id")
	}
	return out.ProcessID, err
}
func (c *boatClient) kill(ctx context.Context, id string, pid int) error {
	err := c.do(ctx, "DELETE", "/sandboxes/"+id+"/commands/"+strconv.Itoa(pid), nil, nil, nil)
	var be *boatError
	if errors.As(err, &be) && be.Status == 404 {
		return nil
	}
	return err
}

type streamFrame struct {
	Type         string `json:"type"`
	Data         string `json:"data"`
	NextOffset   int64  `json:"nextOffset"`
	StdoutOffset int64  `json:"stdoutOffset"`
	StderrOffset int64  `json:"stderrOffset"`
	Status       string `json:"status"`
	ExitCode     *int   `json:"exitCode"`
	Signal       string `json:"signal"`
	Error        string `json:"error"`
	Message      string `json:"message"`
}

// attach follows a detached process until it exits, reconnecting as the
// documented protocol requires, and delivers each output chunk exactly once.
// It returns the exit code; a lost process or an error frame is an error.
func (c *boatClient) attach(ctx context.Context, id string, pid int, stdout, stderr func([]byte) error) (int, error) {
	var outOff, errOff int64
	reconnects := 0
	for {
		code, done, err := c.attachOnce(ctx, id, pid, &outOff, &errOff, stdout, stderr)
		if done || err != nil {
			return code, err
		}
		reconnects++
		if reconnects > 10000 {
			return -1, errors.New("remote process stream reconnected too often")
		}
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (c *boatClient) attachOnce(ctx context.Context, id string, pid int, outOff, errOff *int64, stdout, stderr func([]byte) error) (int, bool, error) {
	path := fmt.Sprintf("/sandboxes/%s/commands/%d/stream?stdoutOffset=%d&stderrOffset=%d", id, pid, *outOff, *errOff)
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(c.base, "/")+path, nil)
	if err != nil {
		return -1, false, err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return -1, false, ctx.Err()
		}
		return -1, false, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		err := decodeBoatError(resp.StatusCode, data)
		var be *boatError
		if errors.As(err, &be) && be.transient() {
			return -1, false, nil
		}
		return -1, false, err
	}
	scan := bufio.NewScanner(resp.Body)
	scan.Buffer(make([]byte, 64<<10), 16<<20)
	for scan.Scan() {
		line := bytes.TrimSpace(scan.Bytes())
		if len(line) == 0 {
			continue
		}
		var f streamFrame
		if err := json.Unmarshal(line, &f); err != nil {
			return -1, false, fmt.Errorf("invalid stream frame from boat: %w", err)
		}
		switch f.Type {
		case "stdout":
			if err := stdout([]byte(f.Data)); err != nil {
				return -1, false, err
			}
			*outOff = f.NextOffset
		case "stderr":
			if err := stderr([]byte(f.Data)); err != nil {
				return -1, false, err
			}
			*errOff = f.NextOffset
		case "reconnect":
			*outOff, *errOff = f.StdoutOffset, f.StderrOffset
			return -1, false, nil
		case "exit":
			if f.Status == "lost" || f.ExitCode == nil {
				return -1, true, errors.New("remote process was lost by the sandbox agent; its exit status is unknown")
			}
			return *f.ExitCode, true, nil
		case "error":
			msg := f.Message
			if msg == "" {
				msg = f.Error
			}
			return -1, true, fmt.Errorf("remote process stream error: %s", msg)
		}
	}
	if err := scan.Err(); err != nil && ctx.Err() != nil {
		return -1, false, ctx.Err()
	}
	// The stream ended without an exit frame: reconnect from the known offsets.
	return -1, false, nil
}

// Files move through signed URLs that the sandbox serves itself. They have no
// size limit and the same URL works for text and binary content.
func (c *boatClient) upload(ctx context.Context, id, path string, data []byte) error {
	return retry(ctx, func() error {
		var signed struct {
			URL string `json:"url"`
		}
		if err := c.do(ctx, "POST", "/sandboxes/"+id+"/files/upload-url", nil, map[string]any{"path": path, "ttlSeconds": 900}, &signed); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, "PUT", signed.URL, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.ContentLength = int64(len(data))
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("upload to sandbox: %w", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return decodeBoatError(resp.StatusCode, body)
		}
		return nil
	})
}
func (c *boatClient) download(ctx context.Context, id, path string, limit int64) ([]byte, error) {
	var data []byte
	err := retry(ctx, func() error {
		var signed struct {
			URL string `json:"url"`
		}
		if err := c.do(ctx, "POST", "/sandboxes/"+id+"/files/download-url", nil, map[string]any{"path": path, "ttlSeconds": 900}, &signed); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, "GET", signed.URL, nil)
		if err != nil {
			return err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("download from sandbox: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			return decodeBoatError(resp.StatusCode, body)
		}
		data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil {
			return err
		}
		if int64(len(data)) > limit {
			return fmt.Errorf("sandbox file %s exceeds %d bytes", path, limit)
		}
		return nil
	})
	return data, err
}

const boatDefaultURL = "https://boat.dev/api/v1"
const boatDefaultKeyEnv = "BOAT_API_KEY"

// boatMachine implements machine on boat.dev: one no-env sandbox per run with
// command history disabled, a detached wrapper followed over the attach
// stream, signed URLs for files, and the provider's auto-stop kept past every
// node.
type boatMachine struct {
	client *boatClient
}

func (b *boatMachine) create(ctx context.Context, r Run, idle time.Duration) (*SandboxState, error) {
	spec := r.Workflow.Sandbox
	s, err := b.client.create(ctx, boatCreateRequest{Type: spec.Type, From: spec.Snapshot, TTLSeconds: int(idle / time.Second), NoEnv: true, Monitoring: false, Env: map[string]string{"KILN_RUN_ID": r.ID}}, "kiln-run-"+r.ID)
	if err != nil {
		return nil, err
	}
	return &SandboxState{Provider: spec.Provider, ID: s.ID, Type: s.Type}, nil
}

// ready brings the machine to a command-accepting state and moves its
// auto-stop deadline past the current operation. Error states are reported,
// not papered over: the operator decides whether to recover or start over.
func (b *boatMachine) ready(ctx context.Context, r Run, idle time.Duration) error {
	id := r.Sandbox.ID
	ttl := idle
	if deadline, ok := ctx.Deadline(); ok {
		ttl += time.Until(deadline) + 10*time.Minute
	}
	if ttl > sandboxMaxTTL {
		ttl = sandboxMaxTTL
	}
	seconds := int(ttl / time.Second)
	resumed := false
	for {
		s, err := b.client.get(ctx, id)
		if err != nil {
			return fmt.Errorf("inspect sandbox %s: %w", id, err)
		}
		switch s.State {
		case "ready", "idle", "running":
			if err := b.client.extend(ctx, id, seconds); err != nil {
				return fmt.Errorf("extend sandbox %s auto-stop: %w", id, err)
			}
			if resumed {
				slog.Info("sandbox resumed", "run_id", r.ID, "sandbox", id)
			}
			return nil
		case "archived":
			if resumed {
				return fmt.Errorf("sandbox %s did not start after resume", id)
			}
			if err := b.client.resume(ctx, id, seconds); err != nil {
				return fmt.Errorf("resume sandbox %s: %w", id, err)
			}
			resumed = true
		case "init", "provisioning", "provisioned", "cloning", "archiving":
		case "error":
			reason := ""
			if s.Error != nil {
				reason = *s.Error
			}
			return fmt.Errorf("sandbox %s is in error state (%s); recover or resume it with the boat CLI, then retry", id, reason)
		case "cancelled":
			return fmt.Errorf("sandbox %s was cancelled by the provider before it got a machine", id)
		default:
			return fmt.Errorf("sandbox %s reports unknown state %q", id, s.State)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for sandbox %s (%s): %w", id, s.State, ctx.Err())
		case <-time.After(sandboxPoll):
		}
	}
}

// exec runs a short administrative script synchronously and returns its
// stdout. Node processes never go through here.
func (b *boatMachine) exec(ctx context.Context, r Run, script string, timeout time.Duration) (string, error) {
	out, err := b.client.run(ctx, r.Sandbox.ID, "sh -c "+shQuote(script), timeout)
	if err != nil {
		return "", err
	}
	if out.TimedOut {
		return "", errors.New("sandbox maintenance command timed out")
	}
	if out.ExitCode == nil || *out.ExitCode != 0 {
		code := -1
		if out.ExitCode != nil {
			code = *out.ExitCode
		}
		return "", fmt.Errorf("sandbox maintenance command failed (exit %d): %s", code, strings.TrimSpace(out.Stderr+"\n"+out.Stdout))
	}
	return out.Stdout, nil
}

// launch starts the attempt's wrapper detached and follows its output.
// Cancellation terminates the remote process group through the API.
func (b *boatMachine) launch(ctx context.Context, r Run, l remoteLayout, attempt string, stdout, stderr func([]byte) error) (func() (int, error), func(), error) {
	sandbox := r.Sandbox.ID
	pid, err := b.client.start(ctx, sandbox, "sh "+shQuote(l.root+"/attempts/"+attempt+".sh"))
	if err != nil {
		return nil, nil, fmt.Errorf("start remote process: %w", err)
	}
	terminate := func() {
		killCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := b.client.kill(killCtx, sandbox, pid); err != nil {
			slog.Warn("remote process termination failed", "sandbox", sandbox, "pid", pid, "error", err)
		}
	}
	type outcome struct {
		code int
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		code, err := b.client.attach(ctx, sandbox, pid, stdout, stderr)
		if ctx.Err() != nil {
			terminate()
			if err == nil {
				err = ctx.Err()
			}
		}
		done <- outcome{code, err}
	}()
	return func() (int, error) { o := <-done; return o.code, o.err }, terminate, nil
}

func (b *boatMachine) upload(ctx context.Context, r Run, path string, data []byte) error {
	return b.client.upload(ctx, r.Sandbox.ID, path, data)
}
func (b *boatMachine) download(ctx context.Context, r Run, path string, limit int64) ([]byte, error) {
	return b.client.download(ctx, r.Sandbox.ID, path, limit)
}
func (b *boatMachine) stop(ctx context.Context, r Run) error {
	s, err := b.client.get(ctx, r.Sandbox.ID)
	if err != nil {
		return err
	}
	if s.State == "archived" || s.State == "archiving" || s.State == "cancelled" {
		return nil
	}
	return b.client.stop(ctx, r.Sandbox.ID)
}
func (b *boatMachine) remove(ctx context.Context, r Run) error {
	return b.client.delete(ctx, r.Sandbox.ID)
}
