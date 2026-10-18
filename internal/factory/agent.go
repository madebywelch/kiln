package factory

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const agentTranscriptLimit = 32 << 20
const agentTurnLimit = 100

// Agent nodes have two deliberate backends, not an arbitrary launcher interface.
// Pi owns the OpenRouter tool loop; Codex owns its subscription authentication.
func (x *Executor) agent(ctx context.Context, r Run, n Node) Result {
	if len(r.Attempts) == 0 {
		return failed(errors.New("agent requires a persisted attempt"))
	}
	attempt := r.Attempts[len(r.Attempts)-1]
	dir := filepath.Join(x.Root, "agents", r.ID, attempt.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return failed(err)
	}
	prompt, err := render(n.Prompt, r)
	if err != nil {
		return failed(err)
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
	args, env, err := x.agentCommand(r, n, dir, env)
	if err != nil {
		return failed(err)
	}
	if n.Provider == "openrouter" && len(n.MCP) > 0 {
		ready := process(ctx, r.Workspace, env, "", "pi", "mcp", "list", "--json")
		if ready.Outcome != "success" {
			return failed(fmt.Errorf("required MCP server unavailable: %s: %s", ready.Error, ready.Output))
		}
	}
	return runAgent(ctx, r.Workspace, dir, env, agentPreamble+prompt, n, args)
}

const agentPreamble = "Work only on the assigned task. Follow repository AGENTS.md instructions and the explicitly available skills. Do not publish, push, create commits, sign your work, or add attribution. KILN owns Git checkpoints and publication. Keep plans, scratch files, logs, and temporary reports outside the repository in KILN_ARTIFACT_DIR. Only intentional product changes belong in the worktree.\n\n"

func (x *Executor) agentCommand(r Run, n Node, dir string, env []string) ([]string, []string, error) {
	home, _, err := x.scratch(r)
	if err != nil {
		return nil, nil, err
	}
	if n.Provider == "codex" {
		source := os.Getenv("CODEX_HOME")
		if source == "" {
			userHome, err := os.UserHomeDir()
			if err != nil {
				return nil, nil, err
			}
			source = filepath.Join(userHome, ".codex")
		}
		source, err := filepath.Abs(source)
		if err != nil {
			return nil, nil, err
		}
		if _, err := os.Stat(filepath.Join(source, "auth.json")); err != nil {
			return nil, nil, errors.New("Codex auth.json is unavailable; run codex login under the daemon account")
		}
		codexHome := filepath.Join(dir, "codex")
		if err := os.MkdirAll(codexHome, 0700); err != nil {
			return nil, nil, err
		}
		if err := os.Symlink(filepath.Join(source, "auth.json"), filepath.Join(codexHome, "auth.json")); err != nil && !os.IsExist(err) {
			return nil, nil, err
		}
		env = setEnv(env, "CODEX_HOME", codexHome)
		// No personal settings, plugins or global skills are copied with credentials.
		// The plugin marketplace cache alone is 30-130 MiB per attempt; the CLI
		// version is pinned by the image, so update checks are noise.
		args := []string{"codex", "exec", "--ignore-user-config", "--ephemeral", "--sandbox", "workspace-write", "--model", n.Model, "-c", `model_reasoning_effort="low"`, "-c", "check_for_update_on_startup=false", "--disable", "skill_mcp_dependency_install", "--disable", "plugins", "--json"}
		if runtime.GOOS == "linux" {
			// Codex's restricted seccomp policy can block shutdown(2) on Node's
			// Unix stdio sockets (openai/codex#41175). Proxy mode permits IPC
			// while an empty allowlist, no approvals, and the network namespace
			// keep egress closed. Filesystem workspace-write remains in force.
			args = append(args, "-c", `approval_policy="never"`,
				"-c", "sandbox_workspace_write.network_access=true",
				"-c", `features.network_proxy={enabled=true,proxy_url="http://127.0.0.1:0",enable_socks5=false,domains={}}`)
		}
		// The sandbox already permits the worktree and TMPDIR. The run's private
		// HOME, its artifact directory, and shared toolchain caches are the only
		// additional writable locations; the daemon state stays read-only.
		roots := append([]string{home}, x.CacheDirs...)
		if r.Artifacts != "" {
			roots = append(roots, r.Artifacts)
		}
		for i, root := range roots {
			roots[i] = strconv.Quote(root)
		}
		args = append(args, "-c", "sandbox_workspace_write.writable_roots=["+strings.Join(roots, ",")+"]")
		var disabled []string
		err = filepath.WalkDir(filepath.Join(r.Workspace, ".agents", "skills"), func(path string, d os.DirEntry, err error) error {
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil {
				return err
			}
			if !d.IsDir() && d.Name() == "SKILL.md" {
				disabled = append(disabled, "{path="+strconv.Quote(path)+",enabled=false}")
			}
			return nil
		})
		if err != nil {
			return nil, nil, err
		}
		if len(disabled) > 0 {
			args = append(args, "-c", "skills.config=["+strings.Join(disabled, ",")+"]")
		}
		return append(args, "-"), env, nil
	}
	layout := agentLayout{Workspace: r.Workspace, Dir: dir, Home: home}
	config, err := x.piConfiguration(n, layout, r.Workspace)
	if err != nil {
		return nil, nil, err
	}
	for path, data := range config.Files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0700); err != nil {
			return nil, nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, path), data, 0600); err != nil {
			return nil, nil, err
		}
	}
	for _, k := range config.envKeys() {
		env = setEnv(env, k, config.Env[k])
	}
	return config.Args, env, nil
}

// agentLayout names the directories as the executing machine sees them: the
// daemon host for local attempts, the remote sandbox for sandbox runs.
type agentLayout struct {
	Workspace string
	Dir       string
	Home      string
}
type piConfig struct {
	Args  []string
	Env   map[string]string
	Files map[string][]byte // relative to the attempt directory
}

func (c piConfig) envKeys() []string {
	keys := make([]string, 0, len(c.Env))
	for k := range c.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// piConfiguration builds Pi's private per-attempt configuration. Repository
// instructions and skills are read from the host checkout, which mirrors the
// executing workspace at attempt start; paths in the arguments use the layout.
func (x *Executor) piConfiguration(n Node, layout agentLayout, hostWorkspace string) (piConfig, error) {
	p, ok := x.Providers["openrouter"]
	if !ok {
		return piConfig{}, errors.New("openrouter provider is not configured")
	}
	if p.KeyEnv == "" || os.Getenv(p.KeyEnv) == "" {
		return piConfig{}, errors.New("OpenRouter credential environment variable is not set")
	}
	config := piConfig{Env: map[string]string{}, Files: map[string][]byte{}}
	piDir := layout.Dir + "/pi"
	config.Env["PI_CODING_AGENT_DIR"] = piDir
	config.Env["PI_OFFLINE"] = "1"
	config.Env["PI_TELEMETRY"] = "0"
	config.Env["KILN_INFERENCE_KEY"] = os.Getenv(p.KeyEnv)
	// Store a reference, never the resolved credential. Only this model is added.
	models := map[string]any{"providers": map[string]any{"openrouter": map[string]any{
		"baseUrl": p.URL, "api": "openai-completions", "apiKey": "${KILN_INFERENCE_KEY}",
		"models": []any{map[string]any{"id": n.Model, "name": n.Model, "reasoning": false, "input": []string{"text"}, "contextWindow": 32768, "maxTokens": 8192}},
	}}}
	var err error
	if config.Files["pi/models.json"], err = json.Marshal(models); err != nil {
		return piConfig{}, err
	}
	mcp, extra, err := x.selectedMCP(n.MCP)
	if err != nil {
		return piConfig{}, err
	}
	keys := []string{"KILN_INFERENCE_KEY"}
	for key := range extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	// Prevent accidental credential capture by ordinary env/debug commands.
	// This is hygiene, not isolation from a process with the same Unix identity.
	settings := map[string]any{"shellCommandPrefix": "unset " + strings.Join(keys, " "), "defaultProjectTrust": "never", "retry": map[string]any{"enabled": false}, "cacheWarming": "off", "enableInstallTelemetry": false}
	if config.Files["pi/settings.json"], err = json.Marshal(settings); err != nil {
		return piConfig{}, err
	}
	toolSet := "read,bash,edit,write"
	for _, name := range n.MCP {
		toolSet += ",mcp__" + strings.ReplaceAll(name, "-", "_") + "__*"
	}
	config.Args = []string{"pi", "--mode", "json", "--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", toolSet, "--provider", "openrouter", "--model", n.Model, "--thinking", "off", "--session", layout.Dir + "/session.jsonl"}
	instructions, err := repositoryInstructions(hostWorkspace)
	if err != nil {
		return piConfig{}, err
	}
	if instructions != "" {
		config.Files["instructions.md"] = []byte(instructions)
		config.Args = append(config.Args, "--append-system-prompt", layout.Dir+"/instructions.md")
	}
	for _, name := range n.Skills {
		if _, err := skillPath(hostWorkspace, name); err != nil {
			return piConfig{}, err
		}
		config.Args = append(config.Args, "--skill", layout.Workspace+"/"+filepath.ToSlash(filepath.Join(".agents", "skills", name, "SKILL.md")))
	}
	for k, v := range extra {
		config.Env[k] = v
	}
	if len(n.MCP) == 0 {
		config.Args = append(config.Args, "--no-mcp")
	} else {
		if config.Files["pi/mcp.json"], err = json.Marshal(map[string]any{"mcpServers": mcp, "autoEnableCodemode": false}); err != nil {
			return piConfig{}, err
		}
		// The only extension enabled is Pi's built-in MCP client. Tools are direct.
		config.Args = append(config.Args, "--extension", "builtin:mcp")
	}
	return config, nil
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			out = append(out, entry)
		}
	}
	return append(out, prefix+value)
}
func writePrivateJSON(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0600)
}

// agentProcess is a started harness whose JSONL stdout is consumed by
// collectAgent. kill escalates on budget violations; wait returns the exit
// status after stdout has closed.
type agentProcess struct {
	stdout io.Reader
	wait   func() error
	stderr *cappedBuffer
	kill   func()
}

func runAgent(ctx context.Context, workspace, dir string, env []string, prompt string, n Node, args []string) Result {
	return collectAgent(ctx, dir, n, func(ctx context.Context) (agentProcess, error) {
		cmd := makeCommand(ctx, workspace, env, prompt, args...)
		// Pi's bash/MCP children have their own groups. Give its SIGTERM handler time
		// to clean them up before falling back to killing the harness process group.
		var timerMu sync.Mutex
		var killTimer *time.Timer
		cmd.Cancel = func() error {
			err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			timerMu.Lock()
			killTimer = time.AfterFunc(2*time.Second, func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
			timerMu.Unlock()
			if errors.Is(err, syscall.ESRCH) {
				return os.ErrProcessDone
			}
			return err
		}
		cmd.WaitDelay = 3 * time.Second
		reader, writer := io.Pipe()
		var stderr cappedBuffer
		cmd.Stdout, cmd.Stderr = writer, &stderr
		if err := cmd.Start(); err != nil {
			writer.Close()
			return agentProcess{}, err
		}
		waited := make(chan error, 1)
		go func() { err := cmd.Wait(); writer.Close(); waited <- err }()
		return agentProcess{stdout: reader, stderr: &stderr, wait: func() error {
			err := <-waited
			timerMu.Lock()
			if killTimer != nil {
				killTimer.Stop()
			}
			timerMu.Unlock()
			return err
		}}, nil
	})
}

// collectAgent owns the transcript, budgets, and semantic completion check for
// a harness process wherever it runs. The start function receives a context
// whose cancellation must terminate the process.
func collectAgent(ctx context.Context, dir string, n Node, start func(context.Context) (agentProcess, error)) Result {
	f, err := os.OpenFile(filepath.Join(dir, "events.jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return failed(err)
	}
	defer f.Close()
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	proc, err := start(childCtx)
	if err != nil {
		return failed(err)
	}
	stop := func() {
		cancel()
		if proc.kill != nil {
			proc.kill()
		}
	}
	parser := agentParser{provider: n.Provider, result: Result{Outcome: "success", Provider: n.Provider, Model: n.Model, Harness: "pi"}}
	if n.Provider == "codex" {
		parser.result.Harness = "codex"
	}
	scan := bufio.NewScanner(proc.stdout)
	scan.Buffer(make([]byte, 64<<10), 2<<20)
	total := 0
	var streamErr error
	for scan.Scan() {
		line := scan.Bytes()
		total += len(line) + 1
		if total > agentTranscriptLimit {
			streamErr = errors.New("agent transcript exceeded 32 MiB")
			stop()
			break
		}
		if _, err := f.Write(append(append([]byte(nil), line...), '\n')); err != nil {
			streamErr = err
			stop()
			break
		}
		if err := parser.consume(line); err != nil {
			streamErr = err
			stop()
			break
		}
		if parser.result.Turns > agentTurnLimit {
			streamErr = errors.New("agent exceeded 100 model turns")
			stop()
			break
		}
	}
	if err := scan.Err(); err != nil && streamErr == nil {
		streamErr = err
		stop()
	}
	// Drain after a protocol/budget failure so the process cannot block on stdout.
	if streamErr != nil {
		_, _ = io.Copy(io.Discard, proc.stdout)
	}
	waitErr := proc.wait()
	if err := f.Sync(); err != nil && streamErr == nil {
		streamErr = err
	}
	if err := os.WriteFile(filepath.Join(dir, "stderr.log"), proc.stderr.b.Bytes(), 0600); err != nil && streamErr == nil {
		streamErr = err
	}
	result := parser.finish()
	if streamErr != nil {
		result.Outcome, result.Error = "failure", streamErr.Error()
	} else if ctx.Err() != nil {
		result.Outcome, result.Error = "failure", ctx.Err().Error()
	} else if waitErr != nil {
		result.Outcome, result.Error = "failure", waitErr.Error()+": "+strings.TrimSpace(proc.stderr.b.String())
	}
	if result.Outcome == "failure" {
		result.ExitCode = -1
	}
	if len(result.Output) > outputLimit {
		result.Output = strings.ToValidUTF8(result.Output[:outputLimit], "�")
		result.Truncated = true
	}
	if len(result.Error) > outputLimit {
		result.Error = strings.ToValidUTF8(result.Error[:outputLimit], "�")
		result.Truncated = true
	}
	return result
}

// Parse semantic completion, not process exit alone: Pi JSON mode can exit zero
// after a provider failure. Deltas are ignored; message_end is authoritative.
type agentParser struct {
	provider      string
	result        Result
	settled       bool
	stop          string
	terminalError string
	finalAnswer   bool
}

func (p *agentParser) consume(line []byte) error {
	var e struct {
		Type    string          `json:"type"`
		Aborted bool            `json:"aborted"`
		Message json.RawMessage `json:"message"`
		Item    struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"item"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Usage struct {
			Input  int `json:"input_tokens"`
			Output int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(line, &e); err != nil {
		return fmt.Errorf("invalid agent JSONL: %w", err)
	}
	if p.provider == "codex" {
		switch e.Type {
		case "item.completed":
			if e.Item.Type == "agent_message" {
				p.finalAnswer = true
				p.result.Output = e.Item.Text
			}
			if e.Item.Type == "command_execution" || e.Item.Type == "file_change" || e.Item.Type == "mcp_tool_call" {
				p.result.ToolCalls++
			}
		case "turn.completed":
			p.settled = true
			p.result.Turns++
			if p.result.Usage == nil {
				p.result.Usage = &Usage{}
			}
			p.result.Usage.PromptTokens += e.Usage.Input
			p.result.Usage.CompletionTokens += e.Usage.Output
			p.result.Usage.TotalTokens += e.Usage.Input + e.Usage.Output
		case "turn.failed":
			p.terminalError = e.Error.Message
			if p.terminalError == "" {
				p.terminalError = "Codex turn failed"
			}
		case "error":
			var message string
			_ = json.Unmarshal(e.Message, &message)
			p.terminalError = message
			if p.terminalError == "" {
				p.terminalError = "Codex error"
			}
		}
		return nil
	}
	switch e.Type {
	case "tool_execution_start":
		p.result.ToolCalls++
	case "agent_settled":
		p.settled = true
		if e.Aborted {
			p.terminalError = "agent aborted"
		}
	case "message_end":
		var m struct {
			Role          string `json:"role"`
			Model         string `json:"model"`
			ResponseModel string `json:"responseModel"`
			ResponseID    string `json:"responseId"`
			Content       []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			StopReason   string `json:"stopReason"`
			ErrorMessage string `json:"errorMessage"`
			Usage        struct {
				Input      int `json:"input"`
				Output     int `json:"output"`
				CacheRead  int `json:"cacheRead"`
				CacheWrite int `json:"cacheWrite"`
				Total      int `json:"totalTokens"`
			} `json:"usage"`
		}
		// User messages may have string content, so inspect the role before decoding.
		var role struct {
			Role string `json:"role"`
		}
		if err := json.Unmarshal(e.Message, &role); err != nil {
			return err
		}
		if role.Role != "assistant" {
			return nil
		}
		if err := json.Unmarshal(e.Message, &m); err != nil {
			return err
		}
		p.result.Turns++
		p.stop = m.StopReason
		p.result.RequestID = m.ResponseID
		if m.Model != "" {
			p.result.Model = m.Model
		}
		if m.ResponseModel != "" {
			p.result.Model = m.ResponseModel
		}
		if p.result.Usage == nil {
			p.result.Usage = &Usage{}
		}
		p.result.Usage.PromptTokens += m.Usage.Input + m.Usage.CacheRead + m.Usage.CacheWrite
		p.result.Usage.CompletionTokens += m.Usage.Output
		p.result.Usage.TotalTokens += m.Usage.Total
		// Pi's prices are catalog estimates, not billed costs; do not report them as cost.
		p.result.Output = ""
		for _, c := range m.Content {
			if c.Type == "text" {
				p.result.Output += c.Text
			}
		}
		if m.StopReason == "error" || m.StopReason == "aborted" {
			p.terminalError = m.ErrorMessage
			if p.terminalError == "" {
				p.terminalError = m.StopReason
			}
		}
	}
	return nil
}
func (p *agentParser) finish() Result {
	if p.terminalError != "" {
		p.result.Outcome, p.result.Error = "failure", p.terminalError
	} else if !p.settled || p.result.Turns == 0 || (p.provider == "codex" && !p.finalAnswer) || (p.provider != "codex" && p.stop != "stop") {
		p.result.Outcome, p.result.Error = "failure", "agent exited without a completed final answer"
	}
	return p.result
}
