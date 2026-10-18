package factory

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const agent37DefaultURL = "https://api.agent37.com/v1"
const agent37DefaultExecURL = "https://sandbox.agent37.app"
const agent37DefaultKeyEnv = "AGENT37_API_KEY"
const agent37DefaultTemplate = "agent37-pi"

// agent37Poll paces output polling of a detached node process. The provider's
// exec API is synchronous, so the host reads new output in bounded chunks.
var agent37Poll = time.Second

// Each poll returns at most this many raw bytes per stream. Both streams travel
// base64-encoded in one exec response, whose stdout the provider caps at 512 KB:
// two 160 KB chunks encode to about 427 KB.
const agent37Chunk = 160 << 10

// Minimal client for the agent37 Sandbox API and the per-instance endpoints
// KILN needs. The Sandbox API takes a bearer token; exec and the instance's
// own URL take the same key in the X-Agent37-Key header.
type agent37Client struct {
	base string
	exec string
	key  string
	http *http.Client
}

type agent37Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *agent37Error) Error() string {
	s := fmt.Sprintf("agent37 API HTTP %d", e.Status)
	if e.Code != "" {
		s += " " + e.Code
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	return s
}

// transient reports whether the documented contract says a retry is safe.
func (e *agent37Error) transient() bool {
	switch e.Code {
	case "try_again", "no_capacity", "capacity_unavailable", "rate_limited":
		return true
	}
	return e.Code == "" && (e.Status == 502 || e.Status == 503 || e.Status == 504)
}

type agent37Instance struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	URL          string `json:"url"`
	Type         string `json:"type"`
	Template     string `json:"template"`
	PastDue      bool   `json:"past_due"`
	StatusReason *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"status_reason"`
}

type agent37Exec struct {
	ExitCode  int    `json:"exit_code"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated"`
}

func (c *agent37Client) request(ctx context.Context, method, rawURL string, bearer bool, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	if bearer {
		req.Header.Set("Authorization", "Bearer "+c.key)
	} else {
		req.Header.Set("X-Agent37-Key", c.key)
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("agent37 %s %s: %w", method, rawURL, err)
	}
	return resp, nil
}

// doJSON performs one JSON call on either plane and decodes the envelope.
func (c *agent37Client) doJSON(ctx context.Context, method, rawURL string, bearer bool, body any, out any) error {
	var reader io.Reader
	contentType := ""
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader, contentType = bytes.NewReader(data), "application/json"
	}
	resp, err := c.request(ctx, method, rawURL, bearer, reader, contentType)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil {
		return err
	}
	if len(data) > 16<<20 {
		return fmt.Errorf("agent37 %s %s: response exceeds 16 MiB", method, rawURL)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return decodeAgent37Error(resp, data)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("agent37 %s %s: invalid response: %w", method, rawURL, err)
	}
	return nil
}

func decodeAgent37Error(resp *http.Response, data []byte) error {
	e := &agent37Error{Status: resp.StatusCode}
	var body struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && len(body.Error) > 0 {
		var object struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		var flat string
		if json.Unmarshal(body.Error, &object) == nil && object.Code != "" {
			e.Code, e.Message = object.Code, object.Message
		} else if json.Unmarshal(body.Error, &flat) == nil {
			e.Message = flat
		}
	}
	if e.Message == "" {
		e.Message = strings.TrimSpace(string(data[:min(len(data), 512)]))
	}
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
		e.RetryAfter = time.Duration(seconds) * time.Second
	}
	return e
}

// retryAgent37 repeats operations the contract marks safe to repeat.
func retryAgent37(ctx context.Context, op func() error) error {
	delay := time.Second
	for {
		err := op()
		var ae *agent37Error
		if err == nil || !errors.As(err, &ae) || !ae.transient() {
			return err
		}
		wait := delay
		if ae.RetryAfter > 0 {
			wait = ae.RetryAfter
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

func (c *agent37Client) api(path string) string { return strings.TrimRight(c.base, "/") + path }

func (c *agent37Client) create(ctx context.Context, body map[string]any) (agent37Instance, error) {
	var out agent37Instance
	err := retryAgent37(ctx, func() error { return c.doJSON(ctx, "POST", c.api("/instances"), true, body, &out) })
	if err == nil && (out.ID == "" || out.URL == "") {
		err = errors.New("agent37 API returned no instance id or URL")
	}
	return out, err
}
func (c *agent37Client) get(ctx context.Context, id string) (agent37Instance, error) {
	var out agent37Instance
	err := retryAgent37(ctx, func() error { return c.doJSON(ctx, "GET", c.api("/instances/"+id), true, nil, &out) })
	return out, err
}
func (c *agent37Client) lifecycle(ctx context.Context, id, action string) error {
	return retryAgent37(ctx, func() error { return c.doJSON(ctx, "POST", c.api("/instances/"+id+"/"+action), true, nil, nil) })
}
func (c *agent37Client) delete(ctx context.Context, id string) error {
	err := retryAgent37(ctx, func() error { return c.doJSON(ctx, "DELETE", c.api("/instances/"+id), true, nil, nil) })
	var ae *agent37Error
	if errors.As(err, &ae) && ae.Status == 404 {
		return nil
	}
	return err
}

// run executes a shell command synchronously. A command that already ran must
// not be repeated, so only refusals that provably never started it are retried.
func (c *agent37Client) run(ctx context.Context, id, command string) (agent37Exec, error) {
	var out agent37Exec
	err := retryAgent37(ctx, func() error {
		return c.doJSON(ctx, "POST", strings.TrimRight(c.exec, "/")+"/v1/instances/"+id+"/exec", false, map[string]any{"command": command}, &out)
	})
	return out, err
}

func (c *agent37Client) health(ctx context.Context, instanceURL string) (bool, error) {
	var out struct {
		OK bool `json:"ok"`
	}
	err := c.doJSON(ctx, "GET", strings.TrimRight(instanceURL, "/")+"/v1/health", false, nil, &out)
	return out.OK, err
}

// Files travel as raw bodies on the instance's own gateway.
func (c *agent37Client) upload(ctx context.Context, instanceURL, path string, data []byte) error {
	return retryAgent37(ctx, func() error {
		target := strings.TrimRight(instanceURL, "/") + "/v1/files/content?overwrite=true&path=" + url.QueryEscape(path)
		resp, err := c.request(ctx, "PUT", target, false, bytes.NewReader(data), "application/octet-stream")
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return decodeAgent37Error(resp, body)
		}
		return nil
	})
}
func (c *agent37Client) download(ctx context.Context, instanceURL, path string, limit int64) ([]byte, error) {
	var data []byte
	err := retryAgent37(ctx, func() error {
		target := strings.TrimRight(instanceURL, "/") + "/v1/files/content?path=" + url.QueryEscape(path)
		resp, err := c.request(ctx, "GET", target, false, nil, "")
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			return decodeAgent37Error(resp, body)
		}
		data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil {
			return err
		}
		if int64(len(data)) > limit {
			return fmt.Errorf("instance file %s exceeds %d bytes", path, limit)
		}
		return nil
	})
	return data, err
}

// agent37Machine implements machine on agent37. The provider offers only a
// synchronous exec call, so the attempt wrapper runs detached in its own
// session with output redirected to files, and the host polls those files in
// bounded chunks. Idle time is covered by the provider's auto-sleep; an exec
// wakes a sleeping instance and start revives a stopped one.
type agent37Machine struct {
	client *agent37Client
}

func (a *agent37Machine) create(ctx context.Context, r Run, idle time.Duration) (*SandboxState, error) {
	spec := r.Workflow.Sandbox
	template := spec.Template
	if template == "" {
		template = agent37DefaultTemplate
	}
	seconds := int(idle / time.Second)
	if seconds < 300 {
		seconds = 300
	}
	if seconds > 86400 {
		seconds = 86400
	}
	body := map[string]any{"template": template, "name": "kiln run " + r.ID, "env": map[string]string{"KILN_RUN_ID": r.ID}, "metadata": map[string]string{"kiln_run": r.ID}, "auto_sleep": true, "idle_timeout_seconds": seconds}
	if spec.Type != "" {
		body["type"] = spec.Type
	}
	if spec.Region != "" {
		body["region"] = spec.Region
	}
	if res := spec.Resources; res != nil {
		shape := map[string]int{}
		if res.CPU > 0 {
			shape["cpu"] = res.CPU
		}
		if res.Memory > 0 {
			shape["memory"] = res.Memory
		}
		if res.Disk > 0 {
			shape["disk"] = res.Disk
		}
		body["resources"] = shape
	}
	instance, err := a.client.create(ctx, body)
	if err != nil {
		return nil, err
	}
	return &SandboxState{Provider: spec.Provider, ID: instance.ID, Type: instance.Template, URL: instance.URL}, nil
}

// ready waits until the instance runs and its gateway answers, starting a
// stopped instance. A sleeping instance is left to the exec call, which wakes
// it as part of the request.
func (a *agent37Machine) ready(ctx context.Context, r Run, idle time.Duration) error {
	id := r.Sandbox.ID
	started := false
	for {
		s, err := a.client.get(ctx, id)
		if err != nil {
			return fmt.Errorf("inspect instance %s: %w", id, err)
		}
		if s.PastDue {
			return fmt.Errorf("instance %s is suspended for non-payment; fund the agent37 workspace, then retry", id)
		}
		switch s.Status {
		case "running", "sleeping":
			if started {
				slog.Info("sandbox started", "run_id", r.ID, "sandbox", id)
			}
			if s.Status == "sleeping" {
				// Exec wakes it; the gateway answers once the restore completes.
				if _, err := a.client.run(ctx, id, "true"); err != nil {
					return fmt.Errorf("wake instance %s: %w", id, err)
				}
			}
			return a.awaitGateway(ctx, r)
		case "stopped":
			if started {
				return fmt.Errorf("instance %s did not start", id)
			}
			if err := a.client.lifecycle(ctx, id, "start"); err != nil {
				return fmt.Errorf("start instance %s: %w", id, err)
			}
			started = true
		case "provisioning", "starting", "waking", "restarting", "updating", "stopping":
		case "failed":
			reason := ""
			if s.StatusReason != nil {
				reason = s.StatusReason.Code + ": " + s.StatusReason.Message
			}
			return fmt.Errorf("instance %s failed (%s); start or recreate it, then retry", id, reason)
		case "deleting", "deleted":
			return fmt.Errorf("instance %s was deleted outside KILN", id)
		default:
			return fmt.Errorf("instance %s reports unknown status %q", id, s.Status)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for instance %s (%s): %w", id, s.Status, ctx.Err())
		case <-time.After(sandboxPoll):
		}
	}
}

// awaitGateway polls the instance's health endpoint until the gateway that
// serves the file endpoints is up; a fresh boot returns running before that.
func (a *agent37Machine) awaitGateway(ctx context.Context, r Run) error {
	for {
		ok, err := a.client.health(ctx, r.Sandbox.URL)
		if err == nil && ok {
			return nil
		}
		var ae *agent37Error
		if err != nil && errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403 || ae.Status == 404) {
			return fmt.Errorf("instance %s gateway: %w (sandbox workflows need a template that serves the instance file endpoints)", r.Sandbox.ID, err)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for instance %s gateway: %w", r.Sandbox.ID, ctx.Err())
		case <-time.After(sandboxPoll):
		}
	}
}

func (a *agent37Machine) exec(ctx context.Context, r Run, script string, timeout time.Duration) (string, error) {
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := a.client.run(execCtx, r.Sandbox.ID, "sh -c "+shQuote(script))
	if err != nil {
		return "", err
	}
	if out.ExitCode != 0 {
		return "", fmt.Errorf("sandbox maintenance command failed (exit %d): %s", out.ExitCode, strings.TrimSpace(out.Stderr+"\n"+out.Stdout))
	}
	if out.Truncated {
		return "", errors.New("sandbox maintenance command output exceeded the provider's 512 KB cap")
	}
	return out.Stdout, nil
}

// launch starts the wrapper in its own session with its output in files, then
// follows those files. The wrapper's process group is terminated through exec
// on cancellation.
func (a *agent37Machine) launch(ctx context.Context, r Run, l remoteLayout, attempt string, stdout, stderr func([]byte) error) (func() (int, error), func(), error) {
	prefix := l.root + "/attempts/" + attempt
	// The wrapper gets its own session so it outlives the exec call and can be
	// terminated as a group. setsid is util-linux; perl covers images without it.
	inner := "echo $$ > " + shQuote(prefix+".pid") + "; sh " + shQuote(prefix+".sh") + " > " + shQuote(prefix+".out") + " 2> " + shQuote(prefix+".err") + " < /dev/null; echo $? > " + shQuote(prefix+".status")
	start := "cd " + shQuote(l.root) + " || exit 74\n" +
		"if command -v setsid >/dev/null 2>&1; then setsid sh -c " + shQuote(inner) + " > /dev/null 2>&1 < /dev/null &\n" +
		"else perl -e 'setpgrp(0,0); exec @ARGV' -- sh -c " + shQuote(inner) + " > /dev/null 2>&1 < /dev/null &\nfi\n" +
		"i=0; while [ ! -s " + shQuote(prefix+".pid") + " ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done\n" +
		"cat " + shQuote(prefix+".pid")
	pidOut, err := a.exec(ctx, r, start, 2*time.Minute)
	if err != nil {
		return nil, nil, fmt.Errorf("start remote process: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(pidOut))
	if err != nil || pid <= 0 {
		return nil, nil, fmt.Errorf("start remote process: no process id recorded (%q)", strings.TrimSpace(pidOut))
	}
	terminate := func() {
		killCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
		defer cancel()
		// dash, Debian's /bin/sh, rejects "kill -- -pgid"; perl's kill takes a
		// negative pid on every platform, and the builtin forms are fallbacks.
		script := fmt.Sprintf("pgid=%d\n", pid) +
			"sig() { perl -e 'exit(kill($ARGV[0], -$ARGV[1]) ? 0 : 1)' \"$1\" \"$pgid\" 2>/dev/null || kill \"-$1\" -- \"-$pgid\" 2>/dev/null || kill \"-$1\" \"-$pgid\" 2>/dev/null; }\n" +
			"sig TERM || exit 0\nsleep 5\nsig KILL || true\n"
		if _, err := a.exec(killCtx, r, script, time.Minute); err != nil {
			slog.Warn("remote process termination failed", "sandbox", r.Sandbox.ID, "pid", pid, "error", err)
		}
	}
	type outcome struct {
		code int
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		code, err := a.follow(ctx, r, prefix, stdout, stderr)
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

// follow delivers each output byte once by reading the wrapper's files from
// byte offsets until its status file appears and both files are drained.
func (a *agent37Machine) follow(ctx context.Context, r Run, prefix string, stdout, stderr func([]byte) error) (int, error) {
	var outOff, errOff int64
	for {
		script := fmt.Sprintf("cat %s 2>/dev/null || echo running\ntail -c +%d %s 2>/dev/null | head -c %d | base64 | tr -d '\\n'\necho\ntail -c +%d %s 2>/dev/null | head -c %d | base64 | tr -d '\\n'\necho\n",
			shQuote(prefix+".status"), outOff+1, shQuote(prefix+".out"), agent37Chunk, errOff+1, shQuote(prefix+".err"), agent37Chunk)
		out, err := a.exec(ctx, r, script, 5*time.Minute)
		if err != nil {
			if ctx.Err() != nil {
				return -1, ctx.Err()
			}
			return -1, fmt.Errorf("follow remote process: %w", err)
		}
		lines := strings.SplitN(out, "\n", 4)
		if len(lines) < 3 {
			return -1, fmt.Errorf("follow remote process: malformed poll response %q", out)
		}
		status := strings.TrimSpace(lines[0])
		outChunk, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[1]))
		if err != nil {
			return -1, fmt.Errorf("follow remote process: invalid stdout chunk: %w", err)
		}
		errChunk, err := base64.StdEncoding.DecodeString(strings.TrimSpace(lines[2]))
		if err != nil {
			return -1, fmt.Errorf("follow remote process: invalid stderr chunk: %w", err)
		}
		if len(outChunk) > 0 {
			if err := stdout(outChunk); err != nil {
				return -1, err
			}
			outOff += int64(len(outChunk))
		}
		if len(errChunk) > 0 {
			if err := stderr(errChunk); err != nil {
				return -1, err
			}
			errOff += int64(len(errChunk))
		}
		full := len(outChunk) == agent37Chunk || len(errChunk) == agent37Chunk
		if status != "running" && !full && len(outChunk) == 0 && len(errChunk) == 0 {
			code, err := strconv.Atoi(status)
			if err != nil {
				return -1, fmt.Errorf("follow remote process: invalid exit status %q", status)
			}
			return code, nil
		}
		if full || status != "running" {
			continue
		}
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		case <-time.After(agent37Poll):
		}
	}
}

func (a *agent37Machine) upload(ctx context.Context, r Run, path string, data []byte) error {
	return a.client.upload(ctx, r.Sandbox.URL, path, data)
}
func (a *agent37Machine) download(ctx context.Context, r Run, path string, limit int64) ([]byte, error) {
	return a.client.download(ctx, r.Sandbox.URL, path, limit)
}
func (a *agent37Machine) stop(ctx context.Context, r Run) error {
	s, err := a.client.get(ctx, r.Sandbox.ID)
	if err != nil {
		return err
	}
	switch s.Status {
	case "stopped", "stopping", "deleting", "deleted", "failed":
		return nil
	}
	return a.client.lifecycle(ctx, r.Sandbox.ID, "stop")
}
func (a *agent37Machine) remove(ctx context.Context, r Run) error {
	return a.client.delete(ctx, r.Sandbox.ID)
}
