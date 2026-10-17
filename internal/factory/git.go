package factory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func git(ctx context.Context, dir string, args ...string) (string, error) {
	return gitInput(ctx, dir, "", args...)
}
func gitInput(ctx context.Context, dir, stdin string, args ...string) (string, error) {
	return gitEnv(ctx, dir, nil, stdin, args...)
}
func gitEnv(ctx context.Context, dir string, extra map[string]string, stdin string, args ...string) (string, error) {
	prefix := []string{"git", "--literal-pathspecs", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "credential.https://github.com.helper=!gh auth git-credential"}
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1")
	for k, v := range extra {
		env = setEnv(env, k, v)
	}
	r := process(ctx, dir, env, stdin, append(prefix, args...)...)
	if r.Outcome != "success" {
		return "", fmt.Errorf("git %s: %s: %s", args[0], r.Error, r.Output)
	}
	if r.Truncated {
		return "", fmt.Errorf("git %s output exceeded %d bytes", args[0], outputLimit)
	}
	if strings.ContainsRune(r.Output, 0) {
		return r.Output, nil
	}
	return strings.TrimSpace(r.Output), nil
}
func gh(ctx context.Context, dir string, args ...string) (string, error) {
	r := process(ctx, dir, append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_HOST=github.com"), "", append([]string{"gh"}, args...)...)
	if r.Outcome != "success" {
		return "", fmt.Errorf("gh %s: %s: %s", args[0], r.Error, r.Output)
	}
	return strings.TrimSpace(r.Output), nil
}
func (x *Executor) repoDir(repo Repository) string {
	key := repo.GitHub
	if key == "" {
		key = repo.Local
	}
	return filepath.Join(x.Root, "repos", digest([]byte(key))[:24]+".git")
}
func (x *Executor) Prepare(ctx context.Context, r Run) (Run, error) {
	x.gitMu.Lock()
	defer x.gitMu.Unlock()
	r.Artifacts = filepath.Join(x.Root, "artifacts", r.ID)
	if err := os.MkdirAll(r.Artifacts, 0700); err != nil {
		return r, err
	}
	r.Workspace = filepath.Join(x.Root, "workspaces", r.ID)
	if r.Workflow.Repository == nil {
		return r, os.MkdirAll(r.Workspace, 0700)
	}
	repo := *r.Workflow.Repository
	if repo.Local != "" && !x.AllowLocal {
		return r, errors.New("local repositories are disabled by server policy")
	}
	source := "https://github.com/" + repo.GitHub + ".git"
	if repo.Local != "" {
		if !filepath.IsAbs(repo.Local) {
			return r, errors.New("repository.local must be an absolute path")
		}
		source = repo.Local
	}
	cache := x.repoDir(repo)
	if err := os.MkdirAll(filepath.Dir(cache), 0700); err != nil {
		return r, err
	}
	if _, err := os.Stat(cache); os.IsNotExist(err) {
		temp, err := os.MkdirTemp(filepath.Dir(cache), "clone-")
		if err != nil {
			return r, err
		}
		defer os.RemoveAll(temp)
		if _, err = git(ctx, "", "clone", "--bare", "--", source, temp); err != nil {
			return r, err
		}
		if err = os.Rename(temp, cache); err != nil {
			return r, err
		}
	} else if err != nil {
		return r, err
	}
	if err := verifyOrigin(ctx, cache, source); err != nil {
		return r, err
	}
	// Reconcile an interrupted worktree creation without deleting possible work.
	if _, err := os.Stat(filepath.Join(r.Workspace, ".git")); err == nil {
		branch, err := git(ctx, r.Workspace, "branch", "--show-current")
		if err != nil {
			return r, err
		}
		if branch != "kiln/"+r.ID {
			return r, errors.New("existing workspace has unexpected branch")
		}
		base, err := git(ctx, cache, "rev-parse", "refs/kiln/bases/"+r.ID)
		if err != nil {
			return r, err
		}
		r.Branch, r.BaseSHA = branch, base
		return r, nil
	}
	base := repo.Base
	if base == "" {
		base = "HEAD"
	}
	if _, err := git(ctx, cache, "fetch", "--no-tags", "origin", base); err != nil {
		return r, err
	}
	sha, err := git(ctx, cache, "rev-parse", "FETCH_HEAD^{commit}")
	if err != nil {
		return r, err
	}
	r.BaseSHA, r.Branch = sha, "kiln/"+r.ID
	if _, err = git(ctx, cache, "update-ref", "refs/kiln/bases/"+r.ID, sha); err != nil {
		return r, err
	}
	if err = os.MkdirAll(filepath.Dir(r.Workspace), 0700); err != nil {
		return r, err
	}
	// A failed add can leave its branch behind. Reuse only our run-specific branch.
	_, existsErr := git(ctx, cache, "show-ref", "--verify", "refs/heads/"+r.Branch)
	args := []string{"worktree", "add", "-b", r.Branch, r.Workspace, sha}
	if existsErr == nil {
		args = []string{"worktree", "add", r.Workspace, r.Branch}
	}
	_, err = git(ctx, cache, args...)
	return r, err
}

func verifyOrigin(ctx context.Context, dir, expected string) error {
	remote, err := git(ctx, dir, "remote", "-v")
	if err != nil {
		return err
	}
	origin, err := git(ctx, dir, "remote", "get-url", "--all", "origin")
	if err != nil {
		return err
	}
	push, err := git(ctx, dir, "remote", "get-url", "--push", "--all", "origin")
	if err != nil {
		return err
	}
	if origin != expected || push != expected {
		return fmt.Errorf("origin does not match configured repository; refusing remote operation (%s)", remote)
	}
	return nil
}
func (x *Executor) pullRequest(ctx context.Context, r Run, n Node) Result {
	x.gitMu.Lock()
	defer x.gitMu.Unlock()
	if r.Workflow.Repository == nil || r.Workflow.Repository.GitHub == "" {
		return failed(errors.New("pull_request requires a GitHub repository"))
	}
	if err := x.verifyCandidate(ctx, r); err != nil {
		return failed(err)
	}
	c := r.Candidate
	cache := x.repoDir(*r.Workflow.Repository)
	expected := "https://github.com/" + r.Workflow.Repository.GitHub + ".git"
	// Inspect the effective origin in the repository actually used for the push.
	if err := verifyOrigin(ctx, cache, expected); err != nil {
		return failed(err)
	}
	if err := verifyOrigin(ctx, r.Workspace, expected); err != nil {
		return failed(err)
	}
	ref := "refs/heads/" + c.Branch
	remote, err := git(ctx, cache, "ls-remote", "--refs", "origin", ref)
	if err != nil {
		return failed(err)
	}
	if remote != "" && remote != c.CommitSHA+"\t"+ref {
		return failed(errors.New("publication branch already contains a different commit; choose a distinct title scope and start a new run; existing branches are never overwritten"))
	}
	prs, err := gh(ctx, cache, "pr", "list", "--repo", r.Workflow.Repository.GitHub, "--head", c.Branch, "--state", "all", "--json", "url,state,headRefOid,title,body")
	if err != nil {
		return failed(err)
	}
	url, err := existingPR(prs)
	if err != nil {
		return failed(err)
	}
	if url != "" {
		var matches []struct {
			Head  string `json:"headRefOid"`
			Title string `json:"title"`
			Body  string `json:"body"`
		}
		if err := json.Unmarshal([]byte(prs), &matches); err != nil {
			return failed(err)
		}
		if remote == "" || len(matches) != 1 || matches[0].Head != c.CommitSHA {
			return failed(errors.New("existing PR does not match the validated candidate"))
		}
		if matches[0].Title != c.Title || strings.TrimSpace(matches[0].Body) != c.Body {
			return failed(errors.New("existing PR text changed; inspect before retrying"))
		}
		return Result{Outcome: "success", Output: url}
	}
	if remote == "" {
		// Explicit commit/ref only. No checkpoint ancestors, tags, mirror pushes,
		// implicit refspecs, submodule pushes, signing, or attribution.
		if _, err := git(ctx, cache, "-c", "remote.origin.mirror=false", "push", "--no-follow-tags", "--recurse-submodules=no", "--force-with-lease="+ref+":", "origin", c.CommitSHA+":"+ref); err != nil {
			return failed(err)
		}
	}
	args := []string{"pr", "create", "--repo", r.Workflow.Repository.GitHub, "--head", c.Branch, "--title", c.Title, "--body", c.Body}
	if base := r.Workflow.Repository.Base; base != "" {
		args = append(args, "--base", base)
	}
	if n.Draft {
		args = append(args, "--draft")
	}
	out, err := gh(ctx, cache, args...)
	if err != nil {
		return failed(err)
	}
	return Result{Outcome: "success", Output: out}
}

func existingPR(data string) (string, error) {
	var prs []struct {
		URL   string `json:"url"`
		State string `json:"state"`
	}
	if err := json.Unmarshal([]byte(data), &prs); err != nil {
		return "", err
	}
	if len(prs) == 0 {
		return "", nil
	}
	if len(prs) != 1 {
		return "", errors.New("multiple PRs match this run branch; inspect before publication")
	}
	if prs[0].State != "OPEN" {
		return "", fmt.Errorf("existing PR is %s (%s); inspect it before submitting a new run", prs[0].State, prs[0].URL)
	}
	if prs[0].URL == "" {
		return "", errors.New("GitHub returned an empty PR URL")
	}
	return prs[0].URL, nil
}

type DiffResult struct {
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated"`
}

func (x *Executor) Diff(ctx context.Context, r Run) (DiffResult, error) {
	if !r.Prepared || r.Cleaned || r.Workflow.Repository == nil {
		return DiffResult{}, fmt.Errorf("%w: no available Git workspace", ErrConflict)
	}
	result := process(ctx, r.Workspace, os.Environ(), "", "git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", r.BaseSHA, "--")
	if result.Outcome != "success" {
		return DiffResult{}, fmt.Errorf("git diff: %s: %s", result.Error, result.Output)
	}
	return DiffResult{Diff: result.Output, Truncated: result.Truncated}, nil
}
func (x *Executor) Cleanup(ctx context.Context, r Run) error {
	x.gitMu.Lock()
	defer x.gitMu.Unlock()
	if r.Workflow.Repository != nil {
		dirs, err := os.ReadDir(filepath.Join(x.Root, "candidates", r.ID))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		for _, d := range dirs {
			p := filepath.Join(x.Root, "candidates", r.ID, d.Name(), "worktree")
			if _, err := os.Stat(p); os.IsNotExist(err) {
				continue
			} else if err != nil {
				return err
			}
			if _, err := git(ctx, x.repoDir(*r.Workflow.Repository), "worktree", "remove", "--force", p); err != nil {
				return err
			}
		}
	}
	if err := os.RemoveAll(filepath.Join(x.Root, "scratch", r.ID)); err != nil {
		return err
	}
	if _, err := os.Stat(r.Workspace); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	if r.Workflow.Repository != nil {
		_, err := git(ctx, x.repoDir(*r.Workflow.Repository), "worktree", "remove", "--force", r.Workspace)
		return err
	}
	return os.RemoveAll(r.Workspace)
}
