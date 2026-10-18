package factory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const outputLimit = 64 << 10

type Provider struct {
	URL    string `json:"url" yaml:"url"`
	KeyEnv string `json:"key_env,omitempty" yaml:"key_env,omitempty"`
}
type Executor struct {
	Root       string
	MCP        map[string]MCPServer
	Providers  map[string]Provider
	Sandboxes  map[string]SandboxProvider
	AllowLocal bool
	// InheritEnv names daemon variables forwarded to every command and agent in
	// addition to PATH and LANG: image-provided toolchain and cache locations,
	// never credentials. HOME and TMPDIR are always private to the run.
	InheritEnv []string
	// CacheDirs are shared toolchain caches outside any run. Codex's
	// workspace-write sandbox is additionally allowed to write there.
	CacheDirs []string
	HTTP      *http.Client
	gitMu     sync.Mutex
}

var reservedEnv = map[string]bool{"HOME": true, "TMPDIR": true, "PI_CODING_AGENT_DIR": true, "PI_OFFLINE": true, "PI_TELEMETRY": true, "CODEX_HOME": true, "KILN_INFERENCE_KEY": true}

func ValidateEnvironment(inherit, caches []string) error {
	for _, k := range inherit {
		if !envPattern.MatchString(k) || reservedEnv[k] || strings.HasPrefix(k, "KILN_") {
			return fmt.Errorf("inherit_env: %q is invalid or reserved by KILN", k)
		}
	}
	for _, d := range caches {
		if !filepath.IsAbs(d) || filepath.Clean(d) != d {
			return fmt.Errorf("cache_dirs: %q must be a clean absolute path", d)
		}
	}
	return nil
}

// Every run gets a private HOME and TMPDIR outside the worktree. Profiles,
// caches, and temporary executables written by one run cannot change another
// run or the daemon's own home, and cleanup removes them with the workspace.
func (x *Executor) scratch(r Run) (home, tmp string, err error) {
	dir := filepath.Join(x.Root, "scratch", r.ID)
	home, tmp = filepath.Join(dir, "home"), filepath.Join(dir, "tmp")
	for _, d := range []string{home, tmp} {
		if err := os.MkdirAll(d, 0700); err != nil {
			return "", "", err
		}
	}
	return home, tmp, nil
}

type cappedBuffer struct {
	mu        sync.Mutex
	b         bytes.Buffer
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if len(p) > outputLimit-b.b.Len() {
		p = p[:outputLimit-b.b.Len()]
		b.truncated = true
	}
	_, _ = b.b.Write(p)
	return n, nil
}
func makeCommand(ctx context.Context, dir string, env []string, stdin string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir, cmd.Env, cmd.Stdin = dir, env, strings.NewReader(stdin)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if lease, ok := ctx.Value(processLeaseKey{}).(*os.File); ok {
		cmd.ExtraFiles = []*os.File{lease}
	}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = time.Second
	return cmd
}
func process(ctx context.Context, dir string, env []string, stdin string, args ...string) Result {
	var b cappedBuffer
	cmd := makeCommand(ctx, dir, env, stdin, args...)
	cmd.Stdout, cmd.Stderr = &b, &b
	err := cmd.Run()
	r := Result{Outcome: "success", Output: strings.ToValidUTF8(b.b.String(), "�"), Truncated: b.truncated}
	if err != nil {
		r.Outcome, r.Error, r.ExitCode = "failure", err.Error(), -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			r.ExitCode = exit.ExitCode()
		}
		if ctx.Err() != nil {
			r.Error = ctx.Err().Error()
		}
	}
	return r
}
func failed(err error) Result { return Result{Outcome: "failure", Error: err.Error(), ExitCode: -1} }

func (x *Executor) nodeEnv(n Node, r Run, contextFile string) ([]string, error) {
	home, tmp, err := x.scratch(r)
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, k := range append([]string{"PATH", "LANG"}, x.InheritEnv...) {
		if v, ok := os.LookupEnv(k); ok {
			env[k] = v
		}
	}
	variables, err := nodeVariables(n, r)
	if err != nil {
		return nil, err
	}
	for k, v := range variables {
		env[k] = v
	}
	env["HOME"], env["TMPDIR"] = home, tmp
	for k, v := range kilnVariables(r, contextFile, r.Workspace, r.Artifacts) {
		env[k] = v
	}
	return envList(env)
}

// nodeVariables are the workflow-declared variables: explicitly forwarded
// daemon variables and rendered node values. The machine-specific variables
// (PATH, HOME, KILN_* paths) are added by the executing side.
func nodeVariables(n Node, r Run) (map[string]string, error) {
	env := map[string]string{}
	for _, k := range n.PassEnv {
		if !envPattern.MatchString(k) {
			return nil, fmt.Errorf("invalid pass_env name %q", k)
		}
		if v, ok := os.LookupEnv(k); ok {
			env[k] = v
		}
	}
	for k, v := range n.Env {
		if !envPattern.MatchString(k) {
			return nil, fmt.Errorf("invalid environment key %q", k)
		}
		value, err := render(v, r)
		if err != nil {
			return nil, err
		}
		env[k] = value
	}
	return env, nil
}
func kilnVariables(r Run, contextFile, workspace, artifacts string) map[string]string {
	return map[string]string{"KILN_CONTEXT_FILE": contextFile, "KILN_RUN_ID": r.ID, "KILN_WORKSPACE": workspace, "KILN_BASE_SHA": r.BaseSHA, "KILN_ARTIFACT_DIR": artifacts}
}
func envList(env map[string]string) ([]string, error) {
	result := []string{}
	size := 0
	for k, v := range env {
		size += len(k) + len(v) + 2
		if len(v) > 64<<10 || size > 128<<10 {
			return nil, errors.New("environment exceeds 128 KiB total or 64 KiB per value; read KILN_CONTEXT_FILE instead")
		}
		result = append(result, k+"="+v)
	}
	return result, nil
}

func (x *Executor) Execute(ctx context.Context, r Run, n Node) Result {
	switch n.Type {
	case "start", "end":
		return Result{Outcome: "success"}
	case "agent":
		if r.Sandbox != nil {
			return x.remoteAgent(ctx, r, n)
		}
		return x.agent(ctx, r, n)
	case "command":
		if r.Sandbox != nil {
			return x.remoteCommand(ctx, r, n)
		}
		contextFile, err := x.writeContext(r)
		if err != nil {
			return failed(err)
		}
		defer os.Remove(contextFile)
		env, err := x.nodeEnv(n, r, contextFile)
		if err != nil {
			return failed(err)
		}
		return process(ctx, r.Workspace, env, "", "/bin/sh", "-eu", "-c", n.Command)
	case "llm":
		return x.llm(ctx, r, n)
	case "changeset":
		return x.changeset(ctx, r, n)
	case "pull_request":
		return x.pullRequest(ctx, r, n)
	default:
		return failed(fmt.Errorf("unsupported executable node %q", n.Type))
	}
}

func contextDocument(r Run, artifacts string) ([]byte, error) {
	return json.Marshal(map[string]any{"inputs": r.Inputs, "outputs": r.Outputs, "run_id": r.ID, "decision": r.Decision, "candidate": r.Candidate, "artifacts": artifacts})
}

// Large outputs belong in a data file, not exec's size-limited environment.
// Keep inputs out of recovery snapshots and product checkouts.
func (x *Executor) writeContext(r Run) (string, error) {
	dir := ""
	if x.Root != "" {
		dir = filepath.Join(x.Root, "contexts")
		if err := os.MkdirAll(dir, 0700); err != nil {
			return "", err
		}
	}
	f, err := os.CreateTemp(dir, "kiln-"+r.ID+"-*.json")
	if err != nil {
		return "", err
	}
	data, err := contextDocument(r, r.Artifacts)
	if err == nil {
		_, err = f.Write(data)
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

func (x *Executor) llm(ctx context.Context, r Run, n Node) Result {
	p, ok := x.Providers[n.Provider]
	if !ok {
		return failed(fmt.Errorf("provider %q is not configured", n.Provider))
	}
	prompt, err := render(n.Prompt, r)
	if err != nil {
		return failed(err)
	}
	maxTokens := n.MaxTokens
	if maxTokens == 0 {
		maxTokens = 4096
	}
	data, _ := json.Marshal(map[string]any{"model": n.Model, "max_tokens": maxTokens, "messages": []map[string]string{{"role": "user", "content": prompt}}})
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(p.URL, "/")+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return failed(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if p.KeyEnv != "" {
		key := os.Getenv(p.KeyEnv)
		if key == "" {
			return failed(fmt.Errorf("provider credential environment variable %s is not set", p.KeyEnv))
		}
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := x.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	resp, err := client.Do(req)
	if err != nil {
		return failed(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return failed(fmt.Errorf("provider returned HTTP %d", resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20+1))
	if err != nil {
		return failed(err)
	}
	if len(body) > 2<<20 {
		return failed(errors.New("provider response exceeds 2 MiB"))
	}
	var response struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Usage   *Usage `json:"usage"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return failed(fmt.Errorf("invalid provider response: %w", err))
	}
	if len(response.Choices) == 0 || response.Choices[0].Message.Content == nil {
		return failed(errors.New("provider response has no text choice"))
	}
	output := *response.Choices[0].Message.Content
	result := Result{Outcome: "success", Output: output, Provider: n.Provider, Model: response.Model, RequestID: response.ID, Usage: response.Usage}
	if reason := response.Choices[0].FinishReason; reason != "" && reason != "stop" {
		result.Outcome, result.Error, result.ExitCode = "failure", "provider stopped with finish_reason="+reason, -1
		result.Output = ""
		return result
	}
	if n.ArtifactFile != "" {
		path, err := render(n.ArtifactFile, r)
		if err != nil {
			return failed(err)
		}
		if r.Artifacts == "" {
			return failed(errors.New("artifact directory is unavailable"))
		}
		if err := writeWorkspace(r.Artifacts, path, []byte(output)); err != nil {
			return failed(err)
		}
		result.Artifact = path
	}
	if len(result.Output) > outputLimit {
		result.Output = strings.ToValidUTF8(result.Output[:outputLimit], "�")
		result.Truncated = true
	}
	return result
}

// os.Root rejects symlink escapes and traversal, including races during file access.
func writeWorkspace(dir, path string, data []byte) error {
	if filepath.IsAbs(path) || path == "." || path == "" {
		return errors.New("artifact_file must be a relative file path")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := root.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func ValidateProviders(providers map[string]Provider) error {
	for name, p := range providers {
		u, err := url.Parse(p.URL)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("provider %s requires an http(s) base URL without credentials, query or fragment", name)
		}
	}
	return nil
}
