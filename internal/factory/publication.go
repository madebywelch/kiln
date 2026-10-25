package factory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// A candidate is a tested product commit, never a descendant of audit commits.
// ID identifies this validation attempt, including its PR text and check command.
type Candidate struct {
	ID         string    `json:"id"`
	Node       string    `json:"node"`
	Branch     string    `json:"branch"`
	BaseSHA    string    `json:"base_sha"`
	SourceTree string    `json:"source_tree"`
	TreeSHA    string    `json:"tree_sha"`
	CommitSHA  string    `json:"commit_sha"`
	Files      []string  `json:"files"`
	Excluded   []string  `json:"excluded"`
	Title      string    `json:"title"`
	Body       string    `json:"body"`
	Check      string    `json:"check"`
	Author     string    `json:"author"`
	Committer  string    `json:"committer"`
	CheckedAt  time.Time `json:"checked_at"`
}

var conventionalTitle = regexp.MustCompile(`^[a-z][a-z0-9-]*(\([^()\s]+\))?!?: \S.*$`)
var githubLogin = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)
var branchSeparators = regexp.MustCompile(`[^\p{L}\p{N}]+`)

// Resolve identity once during preparation. The approved candidate pins the
// resulting branch, so retries cannot rename it when authentication changes.
func publicationBranch(login, title string) (string, error) {
	if !githubLogin.MatchString(login) || strings.Contains(login, "--") {
		return "", errors.New("publication requires an authenticated GitHub user login")
	}
	header, subject, ok := strings.Cut(title, ": ")
	if !ok || !conventionalTitle.MatchString(title) {
		return "", errors.New("publication branch requires a Conventional Commit title")
	}
	// A scope is the author's chosen topic and is used whole: truncating it
	// silently merged daily scopes such as deps-2026-10-09 and deps-2026-10-10
	// into one branch, so publication refused every later run. Unscoped titles
	// contribute at most three subject words. Never append opaque IDs.
	basis := strings.TrimSuffix(header, "!")
	if scoped := strings.Contains(basis, "("); scoped {
		slug := strings.Join(strings.Fields(branchSeparators.ReplaceAllString(strings.ToLower(basis), " ")), "-")
		if len(slug) > 32 {
			return "", errors.New("publication topic exceeds 32 bytes; use a shorter Conventional Commit scope")
		}
		return login + "/" + slug, nil
	}
	words := strings.Fields(branchSeparators.ReplaceAllString(strings.ToLower(basis+" "+subject), " "))
	slug := ""
	count := 0
	for _, word := range words {
		next := word
		if slug != "" {
			next = slug + "-" + word
		}
		if len(next) > 32 || count == 4 {
			break
		}
		slug = next
		count++
	}
	if count < 2 {
		return "", errors.New("publication title needs a concise topic; add a short Conventional Commit scope")
	}
	return login + "/" + slug, nil
}

func validatePublicationText(title, body string) error {
	if len(title) > 120 || strings.TrimSpace(title) != title || strings.ContainsAny(title, "\r\n\x00") || !conventionalTitle.MatchString(title) {
		return errors.New("title must be a single Conventional Commit subject, at most 120 bytes")
	}
	if strings.TrimSpace(body) == "" || len(body) > 4000 || strings.ContainsRune(body, 0) {
		return errors.New("body must explain the change and validation, at most 4000 bytes")
	}
	return nil
}
func validatePublicationPath(p string) error {
	if p == "" || p == "." || path.IsAbs(p) || path.Clean(p) != p || p == ".." || strings.HasPrefix(p, "../") || strings.Contains(p, "\\") || !utf8.ValidString(p) || len(p) > 4096 {
		return fmt.Errorf("invalid publication path %q: use an exact repository-relative file path", p)
	}
	for _, r := range p {
		if unicode.IsControl(r) {
			return fmt.Errorf("control character in publication path %q", p)
		}
	}
	for _, part := range strings.Split(p, "/") {
		if strings.EqualFold(part, ".git") {
			return fmt.Errorf("Git metadata is not a publication path: %q", p)
		}
	}
	return nil
}
func publicationSelection(n Node, r Run) (map[string]bool, error) {
	data, err := newTemplateData(r)
	if err != nil {
		return nil, err
	}
	if n.Selection != "" {
		if len(n.Files) > 0 || len(n.Exclude) > 0 {
			return nil, errors.New("selection cannot be combined with files/exclude")
		}
		value, err := data.render(n.Selection)
		if err != nil {
			return nil, err
		}
		var selection struct {
			Files   []string `json:"files"`
			Exclude []string `json:"exclude"`
		}
		if !json.Valid([]byte(value)) {
			return nil, errors.New("selection must contain one JSON object")
		}
		// The strict YAML decoder also accepts JSON and rejects duplicate keys.
		d := yaml.NewDecoder(strings.NewReader(value))
		d.KnownFields(true)
		if err := d.Decode(&selection); err != nil {
			return nil, fmt.Errorf("selection must be JSON with files/exclude arrays: %w", err)
		}
		// Paths in generated JSON are data, not a second template program.
		n.Files, n.Exclude = selection.Files, selection.Exclude
	}
	selected := map[string]bool{}
	for i, paths := range [][]string{n.Files, n.Exclude} {
		for _, p := range paths {
			if n.Selection == "" {
				var err error
				p, err = data.render(p)
				if err != nil {
					return nil, err
				}
			}
			if err := validatePublicationPath(p); err != nil {
				return nil, err
			}
			if _, ok := selected[p]; ok {
				return nil, fmt.Errorf("duplicate or overlapping publication path %q", p)
			}
			selected[p] = i == 0
		}
	}
	if len(n.Files) == 0 || len(selected) > 256 {
		return nil, errors.New("changeset requires files and at most 256 selected/excluded paths")
	}
	return selected, nil
}
func candidateRef(r Run, c *Candidate) string { return "refs/kiln/candidates/" + r.ID + "/" + c.ID }
func (x *Executor) candidateDir(r Run, id string) string {
	return filepath.Join(x.Root, "candidates", r.ID, id)
}

// Working history remains private. Only its tree is used to select a product diff.
func cleanSourceTree(ctx context.Context, r Run) (string, error) {
	branch, err := git(ctx, r.Workspace, "symbolic-ref", "HEAD")
	if err != nil {
		return "", err
	}
	if branch != "refs/heads/"+r.Branch {
		return "", errors.New("workspace branch changed")
	}
	status, err := git(ctx, r.Workspace, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return "", err
	}
	if status != "" {
		return "", errors.New("workspace changed since its checkpoint; prepare a new changeset")
	}
	return git(ctx, r.Workspace, "rev-parse", "HEAD^{tree}")
}

func (x *Executor) changeset(ctx context.Context, r Run, n Node) Result {
	if r.Workflow.Repository == nil || len(r.Attempts) == 0 {
		return failed(errors.New("changeset requires a repository and persisted attempt"))
	}
	if n.Command == "" {
		return failed(errors.New("changeset requires a validation command"))
	}
	selected, err := publicationSelection(n, r)
	if err != nil {
		return failed(err)
	}
	title, err := render(n.Title, r)
	if err != nil {
		return failed(err)
	}
	body, err := render(n.Body, r)
	if err != nil {
		return failed(err)
	}
	title, body = strings.TrimSpace(title), strings.TrimSpace(body)
	if err := validatePublicationText(title, body); err != nil {
		return failed(err)
	}
	c := &Candidate{ID: r.Attempts[len(r.Attempts)-1].ID, Node: r.Current, BaseSHA: r.BaseSHA, Title: title, Body: body, Check: n.Command, Files: []string{}, Excluded: []string{}}
	if r.Workflow.Repository.GitHub != "" {
		login, err := gh(ctx, r.Workspace, "api", "user", "--hostname", "github.com", "--jq", ".login")
		if err != nil {
			return failed(fmt.Errorf("resolve publication GitHub user: %w", err))
		}
		c.Branch, err = publicationBranch(login, title)
		if err != nil {
			return failed(err)
		}
	}
	dir := x.candidateDir(r, c.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return failed(err)
	}
	workspace := filepath.Join(dir, "worktree")
	// Remove validation worktrees even on failure. Crashes retain them until cleanup.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		x.gitMu.Lock()
		defer x.gitMu.Unlock()
		_, _ = git(cleanup, x.repoDir(*r.Workflow.Repository), "worktree", "remove", "--force", workspace)
	}()
	x.gitMu.Lock()
	err = x.buildCandidate(ctx, r, c, selected, workspace)
	x.gitMu.Unlock()
	if err != nil {
		return failed(err)
	}
	// This checkout contains only base + selected product changes, not the run's
	// ignored caches, excluded scratch files, or private checkpoint ancestry.
	checkRun := r
	checkRun.Workspace = workspace
	checkRun.Candidate = c
	result := x.Execute(ctx, checkRun, Node{Type: "command", Command: n.Command, Env: n.Env, PassEnv: n.PassEnv})
	if result.Outcome != "success" {
		result.Error = "candidate validation failed: " + result.Error
		return result
	}
	x.gitMu.Lock()
	defer x.gitMu.Unlock()
	head, err := git(ctx, workspace, "rev-parse", "HEAD")
	if err != nil {
		return failed(err)
	}
	status, err := git(ctx, workspace, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return failed(err)
	}
	if head != c.CommitSHA || status != "" {
		return failed(errors.New("validation changed candidate files or left unignored output; write reports/caches to KILN_ARTIFACT_DIR and prepare again"))
	}
	tree, err := cleanSourceTree(ctx, r)
	if err != nil {
		return failed(err)
	}
	if tree != c.SourceTree {
		return failed(errors.New("source changed during validation; prepare again"))
	}
	c.CheckedAt = now()
	result.Candidate = c
	return result
}

// Caller holds gitMu. An alternate index avoids changing the working checkout.
func (x *Executor) buildCandidate(ctx context.Context, r Run, c *Candidate, selected map[string]bool, workspace string) error {
	source, err := cleanSourceTree(ctx, r)
	if err != nil {
		return err
	}
	c.SourceTree = source
	names, err := git(ctx, r.Workspace, "diff", "--name-only", "--no-renames", "-z", r.BaseSHA, source, "--")
	if err != nil {
		return err
	}
	var unclassified []string
	for _, p := range strings.Split(names, "\x00") {
		if p == "" {
			continue
		}
		if err := validatePublicationPath(p); err != nil {
			return err
		}
		include, known := selected[p]
		if !known {
			unclassified = append(unclassified, p)
		} else if include {
			c.Files = append(c.Files, p)
		} else {
			c.Excluded = append(c.Excluded, p)
		}
	}
	if len(unclassified) > 0 {
		return fmt.Errorf("unclassified changes: %q; select product files, explicitly exclude residue, or move it to KILN_ARTIFACT_DIR", unclassified)
	}
	if len(c.Files) == 0 {
		return errors.New("no selected product changes; nothing to publish")
	}
	slices.Sort(c.Files)
	slices.Sort(c.Excluded)
	cache := x.repoDir(*r.Workflow.Repository)
	index := filepath.Join(x.candidateDir(r, c.ID), "index")
	defer os.Remove(index)
	env := map[string]string{"GIT_INDEX_FILE": index}
	if _, err := gitEnv(ctx, cache, env, "", "read-tree", r.BaseSHA); err != nil {
		return err
	}
	// Remove first to handle deletions, renames and file/directory replacements.
	var entries strings.Builder
	for _, p := range c.Files {
		fmt.Fprintf(&entries, "0 %s\t%s\x00", strings.Repeat("0", len(r.BaseSHA)), p)
	}
	treeArgs := append([]string{"ls-tree", "-rz", "--full-tree", source, "--"}, c.Files...)
	raw, err := git(ctx, cache, treeArgs...)
	if err != nil {
		return err
	}
	for _, entry := range strings.Split(raw, "\x00") {
		if entry == "" {
			continue
		}
		meta, p, ok := strings.Cut(entry, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 || (fields[1] != "blob" && fields[1] != "commit") {
			return errors.New("unexpected candidate tree entry")
		}
		// A deleted file path may now be a directory. ls-tree recursively
		// returns its children; import only exact selected file paths.
		if !slices.Contains(c.Files, p) {
			continue
		}
		fmt.Fprintf(&entries, "%s %s\t%s\x00", fields[0], fields[2], p)
	}
	if _, err := gitEnv(ctx, cache, env, entries.String(), "update-index", "-z", "--index-info"); err != nil {
		return err
	}
	c.TreeSHA, err = gitEnv(ctx, cache, env, "", "write-tree")
	if err != nil {
		return err
	}
	// No checkpoint parent, workflow IDs, generated footers, or attribution.
	// Git resolves author/committer from the service account's configuration/env.
	c.CommitSHA, err = git(ctx, cache, "-c", "user.useConfigOnly=true", "commit-tree", c.TreeSHA, "-p", r.BaseSHA, "-m", c.Title)
	if err != nil {
		return err
	}
	c.Author, err = git(ctx, cache, "show", "-s", "--format=%an <%ae>", c.CommitSHA)
	if err != nil {
		return err
	}
	c.Committer, err = git(ctx, cache, "show", "-s", "--format=%cn <%ce>", c.CommitSHA)
	if err != nil {
		return err
	}
	if _, err := git(ctx, cache, "update-ref", candidateRef(r, c), c.CommitSHA, strings.Repeat("0", len(c.CommitSHA))); err != nil {
		return err
	}
	_, err = git(ctx, cache, "worktree", "add", "--detach", workspace, c.CommitSHA)
	return err
}

func (x *Executor) verifyCandidate(ctx context.Context, r Run) error {
	c := r.Candidate
	if c == nil || c.CheckedAt.IsZero() {
		return errors.New("no validated changeset; run a changeset node first")
	}
	expectedBranch := ""
	if r.Workflow.Repository != nil && r.Workflow.Repository.GitHub != "" {
		login, _, _ := strings.Cut(c.Branch, "/")
		var err error
		expectedBranch, err = publicationBranch(login, c.Title)
		if err != nil {
			return err
		}
	}
	if c.BaseSHA != r.BaseSHA || c.Branch != expectedBranch {
		return errors.New("candidate does not belong to this run or publication title")
	}
	if r.Decision != nil && r.Decision.CandidateID != "" && r.Decision.CandidateID != c.ID {
		return errors.New("human decision refers to a stale candidate; review the new changeset")
	}
	if err := validatePublicationText(c.Title, c.Body); err != nil {
		return err
	}
	source, err := cleanSourceTree(ctx, r)
	if err != nil {
		return err
	}
	if source != c.SourceTree {
		return errors.New("source changed after validation/approval; prepare and review a new changeset")
	}
	cache := x.repoDir(*r.Workflow.Repository)
	ref, err := git(ctx, cache, "rev-parse", candidateRef(r, c))
	if err != nil {
		return err
	}
	parents, err := git(ctx, cache, "rev-list", "--parents", "-n", "1", c.CommitSHA)
	if err != nil {
		return err
	}
	tree, err := git(ctx, cache, "rev-parse", c.CommitSHA+"^{tree}")
	if err != nil {
		return err
	}
	if ref != c.CommitSHA || tree != c.TreeSHA || parents != c.CommitSHA+" "+r.BaseSHA {
		return errors.New("candidate commit/tree/ancestry changed; refusing publication")
	}
	return nil
}

func (x *Executor) CandidateDiff(ctx context.Context, r Run) (DiffResult, error) {
	if r.Candidate == nil || r.Workflow.Repository == nil {
		return DiffResult{}, fmt.Errorf("%w: no publication candidate", ErrConflict)
	}
	result := process(ctx, x.repoDir(*r.Workflow.Repository), os.Environ(), "", "git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", r.Candidate.BaseSHA, r.Candidate.CommitSHA, "--")
	if result.Outcome != "success" {
		return DiffResult{}, fmt.Errorf("candidate diff: %s: %s", result.Error, result.Output)
	}
	return DiffResult{Diff: result.Output, Truncated: result.Truncated}, nil
}
