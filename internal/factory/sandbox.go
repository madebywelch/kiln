package factory

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// SandboxProvider is the server-side configuration of a remote machine
// provider. Workflows reference the provider by name and never see the key.
type SandboxProvider struct {
	URL         string `yaml:"url,omitempty" json:"url,omitempty"`
	ExecURL     string `yaml:"exec_url,omitempty" json:"exec_url,omitempty"`
	KeyEnv      string `yaml:"key_env,omitempty" json:"key_env,omitempty"`
	IdleTimeout string `yaml:"idle_timeout,omitempty" json:"idle_timeout,omitempty"`
}

const sandboxDefaultIdle = time.Hour
const sandboxMaxTTL = 30 * 24 * time.Hour

var idPattern = regexp.MustCompile("^[0-9a-f]{32}$")

// sandboxPoll paces state polling after create, resume and stop.
var sandboxPoll = 2 * time.Second

var sandboxProviders = map[string]struct{ url, keyEnv string }{
	"boat":    {boatDefaultURL, boatDefaultKeyEnv},
	"agent37": {agent37DefaultURL, agent37DefaultKeyEnv},
}

func validateAPIURL(field, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("%s must be an http(s) base URL without credentials, query or fragment", field)
	}
	return nil
}

func ValidateSandboxes(providers map[string]SandboxProvider) error {
	for name, p := range providers {
		if _, ok := sandboxProviders[name]; !ok {
			return fmt.Errorf("sandboxes: unsupported provider %q; boat and agent37 are the providers", name)
		}
		if p.URL != "" {
			if err := validateAPIURL("sandboxes."+name+".url", p.URL); err != nil {
				return err
			}
		}
		if p.ExecURL != "" {
			if name != "agent37" {
				return fmt.Errorf("sandboxes.%s: exec_url applies to agent37 only", name)
			}
			if err := validateAPIURL("sandboxes."+name+".exec_url", p.ExecURL); err != nil {
				return err
			}
		}
		if p.KeyEnv != "" && !envPattern.MatchString(p.KeyEnv) {
			return fmt.Errorf("sandboxes.%s: invalid key_env", name)
		}
		if p.IdleTimeout != "" {
			d, err := time.ParseDuration(p.IdleTimeout)
			if err != nil || d < time.Minute || d > sandboxMaxTTL {
				return fmt.Errorf("sandboxes.%s: idle_timeout must be 1m-720h", name)
			}
		}
	}
	return nil
}

func (p SandboxProvider) idle() time.Duration {
	if p.IdleTimeout == "" {
		return sandboxDefaultIdle
	}
	d, _ := time.ParseDuration(p.IdleTimeout)
	return d
}

// machine is one provider's transport to a run's remote computer. The sync
// protocol, the runner script, the lease, and the lifecycle policy are shared;
// a provider supplies creation, readiness, short synchronous scripts, a
// detached node process with streamed output, file transfer, stop and delete.
type machine interface {
	create(ctx context.Context, r Run, idle time.Duration) (*SandboxState, error)
	ready(ctx context.Context, r Run, idle time.Duration) error
	exec(ctx context.Context, r Run, script string, timeout time.Duration) (string, error)
	launch(ctx context.Context, r Run, l remoteLayout, attempt string, stdout, stderr func([]byte) error) (wait func() (int, error), kill func(), err error)
	upload(ctx context.Context, r Run, path string, data []byte) error
	download(ctx context.Context, r Run, path string, limit int64) ([]byte, error)
	stop(ctx context.Context, r Run) error
	remove(ctx context.Context, r Run) error
}

func (x *Executor) machine(r Run) (machine, SandboxProvider, error) {
	if r.Workflow.Sandbox == nil {
		return nil, SandboxProvider{}, errors.New("workflow has no sandbox")
	}
	name := r.Workflow.Sandbox.Provider
	p, ok := x.Sandboxes[name]
	if !ok {
		return nil, SandboxProvider{}, fmt.Errorf("sandbox provider %q is not configured", name)
	}
	defaults := sandboxProviders[name]
	keyEnv := p.KeyEnv
	if keyEnv == "" {
		keyEnv = defaults.keyEnv
	}
	key := os.Getenv(keyEnv)
	if key == "" {
		return nil, p, fmt.Errorf("sandbox credential environment variable %s is not set", keyEnv)
	}
	base := p.URL
	if base == "" {
		base = defaults.url
	}
	client := x.HTTP
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	switch name {
	case "boat":
		return &boatMachine{client: &boatClient{base: base, key: key, http: client}}, p, nil
	default:
		execURL := p.ExecURL
		if execURL == "" {
			execURL = agent37DefaultExecURL
		}
		return &agent37Machine{client: &agent37Client{base: base, exec: execURL, key: key, http: client}}, p, nil
	}
}

// remoteLayout places every run file under one directory in the sandbox
// user's home. The machine is dedicated to the run, so its real home directory
// and toolchain configuration are used as they are.
type remoteLayout struct {
	home string
	root string
}

func layoutFor(r Run) remoteLayout {
	return remoteLayout{home: r.Sandbox.Home, root: r.Sandbox.Home + "/kiln/" + r.ID}
}
func (l remoteLayout) work() string               { return l.root + "/work" }
func (l remoteLayout) candidate(id string) string { return l.root + "/candidates/" + id }
func (l remoteLayout) artifacts() string          { return l.root + "/artifacts" }
func (l remoteLayout) agent(attempt string) string {
	return l.root + "/agents/" + attempt
}

// remoteWorkspace maps a host checkout to its sandbox directory. The run
// worktree is a persistent checkout; a candidate is a fresh detached worktree.
func (x *Executor) remoteWorkspace(l remoteLayout, r Run) (dir string, candidate bool, err error) {
	rel, err := filepath.Rel(x.Root, r.Workspace)
	if err != nil {
		return "", false, err
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	switch {
	case len(parts) == 2 && parts[0] == "workspaces" && parts[1] == r.ID:
		return l.work(), false, nil
	case len(parts) == 4 && parts[0] == "candidates" && parts[1] == r.ID && parts[3] == "worktree" && idPattern.MatchString(parts[2]):
		return l.candidate(parts[2]), true, nil
	}
	return "", false, fmt.Errorf("workspace %s is not a run checkout", r.Workspace)
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// prepareSandbox creates or reconnects the run's machine, records its home
// directory, and seeds the repository. Preparation is journaled by the engine
// even on failure, so a retried preparation reuses the recorded sandbox and the
// idempotency key covers a lost create response.
func (x *Executor) prepareSandbox(ctx context.Context, r Run) (Run, error) {
	m, provider, err := x.machine(r)
	if err != nil {
		return r, err
	}
	if r.Sandbox == nil {
		state, err := m.create(ctx, r, provider.idle())
		if err != nil {
			return r, fmt.Errorf("create sandbox: %w", err)
		}
		r.Sandbox = state
		slog.Info("sandbox created", "run_id", r.ID, "provider", state.Provider, "sandbox", state.ID, "type", state.Type)
	}
	if err := m.ready(ctx, r, provider.idle()); err != nil {
		return r, err
	}
	if r.Sandbox.Home == "" {
		home, err := m.exec(ctx, r, `printf '%s' "$HOME"`, time.Minute)
		if err != nil {
			return r, fmt.Errorf("query sandbox home: %w", err)
		}
		home = strings.TrimSpace(home)
		if !strings.HasPrefix(home, "/") || strings.ContainsAny(home, "'\n\x00") {
			return r, fmt.Errorf("sandbox did not report an absolute home directory: %q", home)
		}
		r.Sandbox.Home = home
	}
	l := layoutFor(r)
	setup := "set -eu\nmkdir -p " + shQuote(l.root+"/sync") + " " + shQuote(l.root+"/attempts") + " " + shQuote(l.root+"/agents") + " " + shQuote(l.artifacts()) + " " + shQuote(l.work()) + "\n"
	if _, err := m.exec(ctx, r, setup, 2*time.Minute); err != nil {
		return r, err
	}
	if r.Workflow.Repository != nil {
		if err := x.pushWorkspace(ctx, m, r, l, l.work(), false, nil, nil); err != nil {
			return r, fmt.Errorf("seed sandbox repository: %w", err)
		}
	}
	return r, nil
}

// pushWorkspace makes the sandbox checkout equal to the host checkout's HEAD.
// Only objects the sandbox lacks travel, as a Git bundle inside the inbound
// tar that also carries per-attempt files and artifacts.
func (x *Executor) pushWorkspace(ctx context.Context, m machine, r Run, l remoteLayout, dir string, candidate bool, files map[string][]byte, artifacts map[string][]byte) error {
	entries := map[string][]byte{}
	for k, v := range files {
		entries[k] = v
	}
	for k, v := range artifacts {
		entries["artifacts/"+k] = v
	}
	var gitSteps strings.Builder
	if r.Workflow.Repository != nil {
		have, err := m.exec(ctx, r, "root="+shQuote(l.root)+"\nif [ -d \"$root/work/.git\" ]; then git -C \"$root/work\" rev-parse HEAD 2>/dev/null || echo none; else echo none; fi\n", 2*time.Minute)
		if err != nil {
			return err
		}
		have = strings.TrimSpace(have)
		x.gitMu.Lock()
		head, err := git(ctx, r.Workspace, "rev-parse", "HEAD")
		if err == nil && have != head {
			var bundle []byte
			if bundle, err = x.bundle(ctx, r.Workspace, have); err == nil {
				entries["sync/in.bundle"] = bundle
			}
		}
		x.gitMu.Unlock()
		if err != nil {
			return err
		}
		if have != head {
			gitSteps.WriteString("[ -d \"$root/work/.git\" ] || git init -q \"$root/work\"\n")
			gitSteps.WriteString("git -C \"$root/work\" fetch -q \"$root/sync/in.bundle\" HEAD\nrm -f \"$root/sync/in.bundle\"\n")
		}
		gitSteps.WriteString("git -C \"$root/work\" cat-file -e " + shQuote(head+"^{commit}") + "\n")
		if candidate {
			gitSteps.WriteString("git -C \"$root/work\" worktree remove --force " + shQuote(dir) + " 2>/dev/null || rm -rf " + shQuote(dir) + "\n")
			gitSteps.WriteString("git -C \"$root/work\" worktree prune\n")
			gitSteps.WriteString("git -C \"$root/work\" worktree add -q --detach " + shQuote(dir) + " " + shQuote(head) + "\n")
		} else {
			// Untracked files are kept: a failed collection leaves them for the
			// next attempt to capture rather than discarding remote work.
			gitSteps.WriteString("git -C \"$root/work\" reset -q --hard " + shQuote(head) + "\n")
		}
	}
	script := "set -eu\nroot=" + shQuote(l.root) + "\nrm -rf \"$root/sync/out\" \"$root/sync/out.tar\"\nmkdir -p \"$root/sync\" \"$root/attempts\" \"$root/agents\" \"$root/artifacts\" \"$root/work\"\n"
	if len(entries) > 0 {
		data, err := tarBytes(entries)
		if err != nil {
			return err
		}
		if err := m.upload(ctx, r, l.root+"/sync/in.tar", data); err != nil {
			return fmt.Errorf("upload to sandbox: %w", err)
		}
		script += "tar -xf \"$root/sync/in.tar\" -C \"$root\"\nrm -f \"$root/sync/in.tar\"\n"
	}
	script += gitSteps.String()
	if _, err := m.exec(ctx, r, script, 10*time.Minute); err != nil {
		return fmt.Errorf("apply workspace to sandbox: %w", err)
	}
	return nil
}

// Caller holds gitMu. have is the sandbox HEAD or "none".
func (x *Executor) bundle(ctx context.Context, workspace, have string) ([]byte, error) {
	f, err := os.CreateTemp(filepath.Join(x.Root, "contexts"), "bundle-*")
	if err != nil {
		if err := os.MkdirAll(filepath.Join(x.Root, "contexts"), 0700); err != nil {
			return nil, err
		}
		if f, err = os.CreateTemp(filepath.Join(x.Root, "contexts"), "bundle-*"); err != nil {
			return nil, err
		}
	}
	f.Close()
	defer os.Remove(f.Name())
	rev := "HEAD"
	if have != "none" {
		if _, err := git(ctx, workspace, "cat-file", "-e", have+"^{commit}"); err == nil {
			rev = have + "..HEAD"
		}
	}
	if _, err := git(ctx, workspace, "bundle", "create", "-q", f.Name(), rev); err != nil {
		return nil, err
	}
	return os.ReadFile(f.Name())
}

// pullWorkspace brings the sandbox's working tree back into the host checkout
// as staged changes for the ordinary checkpoint, and merges remote artifacts.
// Candidate worktrees are removed from the sandbox afterwards.
func (x *Executor) pullWorkspace(ctx context.Context, m machine, r Run, l remoteLayout, dir string, candidate bool, attempt string) error {
	// COPYFILE_DISABLE keeps bsdtar from adding AppleDouble entries when the
	// provider is simulated on macOS; GNU tar ignores it.
	script := "set -eu\nexport COPYFILE_DISABLE=1\nroot=" + shQuote(l.root) + "\nrm -rf \"$root/sync/out\" \"$root/sync/out.tar\"\nmkdir -p \"$root/sync/out\"\n"
	if r.Workflow.Repository != nil {
		script += "cd " + shQuote(dir) + "\ngit add -A -- .\ntree=$(git write-tree)\n"
		script += "if [ \"$tree\" != \"$(git rev-parse 'HEAD^{tree}')\" ]; then\n"
		script += "  sha=$(git -c user.name=kiln -c user.email=kiln@localhost commit-tree \"$tree\" -p HEAD -m 'kiln sync')\n"
		script += "  git update-ref refs/kiln/sync \"$sha\"\n  mkdir -p \"$root/sync/out/sync\"\n"
		script += "  git bundle create -q \"$root/sync/out/sync/out.bundle\" HEAD..refs/kiln/sync\nfi\ncd \"$root\"\n"
		if candidate {
			script += "git -C \"$root/work\" worktree remove --force " + shQuote(dir) + "\n"
		}
	}
	script += "tar -cf \"$root/sync/out.tar\" -C \"$root/sync/out\" .\n"
	script += "if [ -n \"$(ls -A \"$root/artifacts\")\" ]; then tar -rf \"$root/sync/out.tar\" -C \"$root\" artifacts; fi\nrm -rf \"$root/sync/out\"\n"
	// Per-attempt process files are no longer needed once the attempt has ended.
	script += "rm -f \"$root/attempts/\"" + shQuote(attempt) + ".*\n"
	if _, err := m.exec(ctx, r, script, 10*time.Minute); err != nil {
		return fmt.Errorf("collect sandbox workspace: %w", err)
	}
	data, err := m.download(ctx, r, l.root+"/sync/out.tar", 4<<30)
	if err != nil {
		return fmt.Errorf("download from sandbox: %w", err)
	}
	entries, err := untarBytes(data)
	if err != nil {
		return fmt.Errorf("sandbox returned an invalid archive: %w", err)
	}
	if bundle, ok := entries["sync/out.bundle"]; ok {
		delete(entries, "sync/out.bundle")
		if err := x.applyBundle(ctx, r.Workspace, bundle); err != nil {
			return err
		}
	}
	for name, content := range entries {
		rel, ok := strings.CutPrefix(name, "artifacts/")
		if !ok {
			return fmt.Errorf("sandbox archive contains unexpected entry %q", name)
		}
		if r.Artifacts == "" {
			return errors.New("artifact directory is unavailable")
		}
		if err := writeWorkspace(r.Artifacts, rel, content); err != nil {
			return fmt.Errorf("store artifact %s: %w", rel, err)
		}
	}
	return nil
}

func (x *Executor) applyBundle(ctx context.Context, workspace string, bundle []byte) error {
	x.gitMu.Lock()
	defer x.gitMu.Unlock()
	f, err := os.CreateTemp(filepath.Join(x.Root, "contexts"), "bundle-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(bundle); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if _, err := git(ctx, workspace, "fetch", "-q", "--no-tags", f.Name(), "refs/kiln/sync"); err != nil {
		return err
	}
	_, err = git(ctx, workspace, "read-tree", "--reset", "-u", "FETCH_HEAD^{tree}")
	return err
}

// tarBytes and untarBytes move small trees. Extraction accepts regular files
// with clean relative names only; the host side writes them through a rooted
// filesystem handle, so a hostile archive cannot escape its directory.
func tarBytes(entries map[string][]byte) ([]byte, error) {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, name := range names {
		mode := int64(0600)
		if strings.HasSuffix(name, ".sh") {
			mode = 0700
		}
		if err := w.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(entries[name])), Typeflag: tar.TypeReg, ModTime: time.Unix(0, 0)}); err != nil {
			return nil, err
		}
		if _, err := w.Write(entries[name]); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
func untarBytes(data []byte) (map[string][]byte, error) {
	entries := map[string][]byte{}
	r := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := r.Next()
		if errors.Is(err, io.EOF) {
			return entries, nil
		}
		if err != nil {
			return nil, err
		}
		name := path.Clean(strings.TrimPrefix(h.Name, "./"))
		if h.Typeflag == tar.TypeDir || name == "." {
			continue
		}
		if h.Typeflag != tar.TypeReg || path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
			return nil, fmt.Errorf("unsupported archive entry %q", h.Name)
		}
		content, err := io.ReadAll(r)
		if err != nil {
			return nil, err
		}
		entries[name] = content
	}
}

// hostArtifacts reads the run's private artifact files for the sandbox.
func hostArtifacts(dir string) (map[string][]byte, error) {
	files := map[string][]byte{}
	if dir == "" {
		return files, nil
	}
	root, err := os.OpenRoot(dir)
	if os.IsNotExist(err) {
		return files, nil
	}
	if err != nil {
		return nil, err
	}
	defer root.Close()
	err = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		f, err := root.Open(rel)
		if err != nil {
			return err
		}
		defer f.Close()
		b, err := io.ReadAll(f)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = b
		return nil
	})
	return files, err
}

// remoteRunner is one node process in the sandbox: a wrapper script that holds
// a per-run lease, sources the attempt environment from a file it then
// removes, and runs the program with a minimal environment from the checkout.
type remoteRunner struct {
	attempt string
	dir     string
	env     map[string]string
	stdin   []byte
	argv    []string
	files   map[string][]byte
}

const remoteLeaseExit = 75

func (j remoteRunner) payload(l remoteLayout) map[string][]byte {
	keys := make([]string, 0, len(j.env))
	for k := range j.env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var envFile strings.Builder
	var pass strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&envFile, "%s=%s\n", k, shQuote(j.env[k]))
		fmt.Fprintf(&pass, " %s=\"$%s\"", k, k)
	}
	var argv strings.Builder
	for _, a := range j.argv {
		argv.WriteString(" " + shQuote(a))
	}
	prefix := l.root + "/attempts/" + j.attempt
	script := "#!/bin/sh\nset -u\nroot=" + shQuote(l.root) + "\nlease=\"$root/lease.pid\"\n" +
		"if [ -f \"$lease\" ] && kill -0 \"$(cat \"$lease\" 2>/dev/null)\" 2>/dev/null; then\n" +
		"  printf 'kiln: attempt %s (pid %s) is still running in this sandbox; stop it before retrying\\n' \"$(cat \"$lease.attempt\" 2>/dev/null)\" \"$(cat \"$lease\")\" >&2\n" +
		fmt.Sprintf("  exit %d\nfi\n", remoteLeaseExit) +
		"printf '%s\\n' \"$$\" > \"$lease\"\nprintf '%s\\n' " + shQuote(j.attempt) + " > \"$lease.attempt\"\n" +
		". " + shQuote(prefix+".env") + "\nrm -f " + shQuote(prefix+".env") + "\n" +
		"cd " + shQuote(j.dir) + " || exit 74\n" +
		"env -i PATH=\"$PATH\" HOME=\"$HOME\" ${LANG+LANG=\"$LANG\"} ${LC_ALL+LC_ALL=\"$LC_ALL\"}" + pass.String() + argv.String() + " < " + shQuote(prefix+".stdin") + "\nstatus=$?\n" +
		"rm -f \"$lease\" \"$lease.attempt\" " + shQuote(prefix+".stdin") + " " + shQuote(prefix+".sh") + "\nexit $status\n"
	files := map[string][]byte{"attempts/" + j.attempt + ".sh": []byte(script), "attempts/" + j.attempt + ".env": []byte(envFile.String()), "attempts/" + j.attempt + ".stdin": j.stdin}
	for k, v := range j.files {
		files[k] = v
	}
	return files
}

func (x *Executor) remoteCommand(ctx context.Context, r Run, n Node) Result {
	m, provider, err := x.machine(r)
	if err != nil {
		return failed(err)
	}
	if err := m.ready(ctx, r, provider.idle()); err != nil {
		return failed(err)
	}
	l := layoutFor(r)
	dir, candidate, err := x.remoteWorkspace(l, r)
	if err != nil {
		return failed(err)
	}
	attempt := newID()
	if len(r.Attempts) > 0 {
		attempt = r.Attempts[len(r.Attempts)-1].ID
	}
	env, err := x.remoteEnv(n, r, l, dir, attempt)
	if err != nil {
		return failed(err)
	}
	contextJSON, err := contextDocument(r, l.artifacts())
	if err != nil {
		return failed(err)
	}
	job := remoteRunner{attempt: attempt, dir: dir, env: env, argv: []string{"/bin/sh", "-eu", "-c", n.Command}, files: map[string][]byte{"attempts/" + attempt + ".context.json": contextJSON}}
	artifacts, err := hostArtifacts(r.Artifacts)
	if err != nil {
		return failed(err)
	}
	if err := x.pushWorkspace(ctx, m, r, l, dir, candidate, job.payload(l), artifacts); err != nil {
		return failed(err)
	}
	var b cappedBuffer
	write := func(p []byte) error { _, err := b.Write(p); return err }
	wait, _, err := m.launch(ctx, r, l, attempt, write, write)
	if err != nil {
		return failed(err)
	}
	code, waitErr := wait()
	result := Result{Outcome: "success", Output: strings.ToValidUTF8(b.b.String(), "�"), Truncated: b.truncated, Sandbox: r.Sandbox.ID}
	switch {
	case ctx.Err() != nil:
		result.Outcome, result.Error, result.ExitCode = "failure", ctx.Err().Error(), -1
	case waitErr != nil:
		result.Outcome, result.Error, result.ExitCode = "failure", waitErr.Error(), -1
	case code == remoteLeaseExit:
		result.Outcome, result.Error, result.ExitCode = "failure", strings.TrimSpace(result.Output), code
	case code != 0:
		result.Outcome, result.Error, result.ExitCode = "failure", fmt.Sprintf("exit status %d", code), code
	}
	// Collection runs for failed attempts too: checkpoints record failures.
	if err := x.collect(ctx, m, r, l, dir, candidate, attempt); err != nil && ctx.Err() == nil {
		return failed(fmt.Errorf("remote attempt finished (%s) but its results could not be collected: %w", result.Outcome, err))
	}
	return result
}

// collect pulls the remote working tree after an attempt, with its own bound
// so a canceled or timed-out node still gets its evidence back.
func (x *Executor) collect(ctx context.Context, m machine, r Run, l remoteLayout, dir string, candidate bool, attempt string) error {
	pullCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Minute)
	defer cancel()
	return x.pullWorkspace(pullCtx, m, r, l, dir, candidate, attempt)
}

func (x *Executor) remoteEnv(n Node, r Run, l remoteLayout, dir, attempt string) (map[string]string, error) {
	env, err := nodeVariables(n, r)
	if err != nil {
		return nil, err
	}
	for k, v := range kilnVariables(r, l.root+"/attempts/"+attempt+".context.json", dir, l.artifacts()) {
		env[k] = v
	}
	if _, err := envList(env); err != nil {
		return nil, err
	}
	return env, nil
}

func (x *Executor) remoteAgent(ctx context.Context, r Run, n Node) Result {
	if len(r.Attempts) == 0 {
		return failed(errors.New("agent requires a persisted attempt"))
	}
	if n.Provider != "openrouter" {
		return failed(errors.New("sandbox workflows run Pi-backed agents only"))
	}
	attempt := r.Attempts[len(r.Attempts)-1]
	hostDir := filepath.Join(x.Root, "agents", r.ID, attempt.ID)
	if err := os.MkdirAll(hostDir, 0700); err != nil {
		return failed(err)
	}
	m, provider, err := x.machine(r)
	if err != nil {
		return failed(err)
	}
	if err := m.ready(ctx, r, provider.idle()); err != nil {
		return failed(err)
	}
	l := layoutFor(r)
	dir, candidate, err := x.remoteWorkspace(l, r)
	if err != nil {
		return failed(err)
	}
	prompt, err := render(n.Prompt, r)
	if err != nil {
		return failed(err)
	}
	env, err := x.remoteEnv(n, r, l, dir, attempt.ID)
	if err != nil {
		return failed(err)
	}
	config, err := x.piConfiguration(n, agentLayout{Workspace: dir, Dir: l.agent(attempt.ID), Home: l.home}, r.Workspace)
	if err != nil {
		return failed(err)
	}
	for k, v := range config.Env {
		env[k] = v
	}
	contextJSON, err := contextDocument(r, l.artifacts())
	if err != nil {
		return failed(err)
	}
	files := map[string][]byte{"attempts/" + attempt.ID + ".context.json": contextJSON}
	for name, data := range config.Files {
		files["agents/"+attempt.ID+"/"+name] = data
	}
	prompt = agentPreamble + prompt
	job := remoteRunner{attempt: attempt.ID, dir: dir, env: env, stdin: []byte(prompt), argv: config.Args, files: files}
	artifacts, err := hostArtifacts(r.Artifacts)
	if err != nil {
		return failed(err)
	}
	if err := x.pushWorkspace(ctx, m, r, l, dir, candidate, job.payload(l), artifacts); err != nil {
		return failed(err)
	}
	if len(n.MCP) > 0 {
		if _, err := m.exec(ctx, r, "set -a\n. "+shQuote(l.root+"/attempts/"+attempt.ID+".env")+"\nset +a\ncd "+shQuote(dir)+"\npi mcp list --json\n", 2*time.Minute); err != nil {
			return failed(fmt.Errorf("required MCP server unavailable: %w", err))
		}
	}
	result := collectAgent(ctx, hostDir, n, func(ctx context.Context) (agentProcess, error) {
		reader, writer := io.Pipe()
		stderr := &cappedBuffer{}
		wait, kill, err := m.launch(ctx, r, l, attempt.ID, func(p []byte) error { _, err := writer.Write(p); return err }, func(p []byte) error { _, err := stderr.Write(p); return err })
		if err != nil {
			return agentProcess{}, err
		}
		waited := make(chan error, 1)
		go func() {
			code, err := wait()
			if err == nil && code != 0 {
				err = fmt.Errorf("exit status %d", code)
				if code == remoteLeaseExit {
					err = errors.New(strings.TrimSpace(stderr.b.String()))
				}
			}
			writer.Close()
			waited <- err
		}()
		return agentProcess{stdout: reader, stderr: stderr, wait: func() error { return <-waited }, kill: kill}, nil
	})
	result.Sandbox = r.Sandbox.ID
	if err := x.collect(ctx, m, r, l, dir, candidate, attempt.ID); err != nil && ctx.Err() == nil {
		return failed(fmt.Errorf("remote attempt finished (%s) but its results could not be collected: %w", result.Outcome, err))
	}
	return result
}

// StopSandbox halts the run's machine: billing for compute stops and its disk
// remains for resume. Called when a run reaches a terminal state.
func (x *Executor) StopSandbox(ctx context.Context, r Run) error {
	m, _, err := x.machine(r)
	if err != nil {
		return err
	}
	return m.stop(ctx, r)
}

// DeleteSandbox erases the machine and its data. Called by workspace cleanup,
// which the operator requests explicitly.
func (x *Executor) DeleteSandbox(ctx context.Context, r Run) error {
	m, _, err := x.machine(r)
	if err != nil {
		return err
	}
	return m.remove(ctx, r)
}
