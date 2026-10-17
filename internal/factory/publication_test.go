package factory

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func publicationFixture(t *testing.T) (*Executor, Run) {
	t.Helper()
	x := &Executor{Root: t.TempDir(), AllowLocal: true}
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t), Base: "main"}
	r, err := x.Prepare(context.Background(), makeRun(w, "rev", "", nil))
	if err != nil {
		t.Fatal(err)
	}
	r.Prepared = true
	return x, r
}
func checkpointFixture(t *testing.T, x *Executor, r Run) string {
	t.Helper()
	finished := now()
	sha, err := x.Checkpoint(context.Background(), r, Attempt{ID: newID(), Node: "work", FinishedAt: &finished, Result: Result{Outcome: "success"}})
	if err != nil {
		t.Fatal(err)
	}
	return sha
}
func candidateNode() Node {
	return Node{Type: "changeset", Files: []string{"file.txt"}, Command: "test \"$(cat file.txt)\" = changed", Title: "fix(fixture): update the product file", Body: "Correct the fixture output.\n\nValidation: verify the product file in a clean checkout."}
}
func makeCandidate(t *testing.T, x *Executor, r Run, n Node) (Run, Result) {
	t.Helper()
	r.Current = "candidate"
	r.Attempts = append(r.Attempts, Attempt{ID: newID(), Node: r.Current, StartedAt: now()})
	result := x.Execute(context.Background(), r, n)
	r.Candidate = result.Candidate
	return r, result
}
func writeFixture(t *testing.T, workspace, name, text string) {
	t.Helper()
	p := filepath.Join(workspace, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestCandidateSeparatesProductFromPrivateHistory(t *testing.T) {
	t.Parallel()
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "plan.md", "private reasoning")
	writeFixture(t, r.Workspace, "some-tool-cache/report.bin", "build residue")
	writeFixture(t, r.Workspace, "file.txt", "changed")
	audit := checkpointFixture(t, x, r)
	n := candidateNode()
	n.Exclude = []string{"plan.md", "some-tool-cache/report.bin"}
	n.Command += "; test ! -e plan.md; test ! -e some-tool-cache; printf private-report > \"$KILN_ARTIFACT_DIR/report.txt\""
	r, result := makeCandidate(t, x, r, n)
	if result.Outcome != "success" {
		t.Fatalf("%+v", result)
	}
	c := r.Candidate
	if len(c.Files) != 1 || len(c.Excluded) != 2 || c.Author != "Test <test@example.invalid>" || c.Committer != c.Author {
		t.Fatalf("%+v", c)
	}
	cache := x.repoDir(*r.Workflow.Repository)
	parents, err := git(context.Background(), cache, "rev-list", "--parents", "-n", "1", c.CommitSHA)
	if err != nil || parents != c.CommitSHA+" "+r.BaseSHA {
		t.Fatalf("audit ancestry leaked: %s %v", parents, err)
	}
	message, _ := git(context.Background(), cache, "show", "-s", "--format=%B", c.CommitSHA)
	if message != n.Title {
		t.Fatalf("commit metadata leaked: %q", message)
	}
	if _, err := git(context.Background(), cache, "merge-base", "--is-ancestor", audit, c.CommitSHA); err == nil {
		t.Fatal("private audit is an ancestor")
	}
	files, _ := git(context.Background(), cache, "ls-tree", "-r", "--name-only", c.CommitSHA)
	if files != "file.txt" {
		t.Fatalf("internal files leaked: %q", files)
	}
	if _, err := os.Stat(filepath.Join(r.Artifacts, "report.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(x.candidateDir(r, c.ID), "worktree")); !os.IsNotExist(err) {
		t.Fatal("validation worktree was retained")
	}
	if err := x.verifyCandidate(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	diff, err := x.CandidateDiff(context.Background(), r)
	if err != nil || !strings.Contains(diff.Diff, "+changed") || strings.Contains(diff.Diff, "private") {
		t.Fatalf("%+v %v", diff, err)
	}
	// API and cleanup retain the publication evidence, not build residue.
	e := testEngine(t, func(exec *Executor) { exec.Root = x.Root })
	r.Status = "succeeded"
	if err := e.store.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	request(t, NewAPI(e, APIConfig{Token: testToken}), "GET", "/v1/runs/"+r.ID+"/candidate/diff", nil, nil, 200)
	if err := x.Cleanup(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if _, err := x.CandidateDiff(context.Background(), r); err != nil {
		t.Fatal("cleanup lost candidate", err)
	}
}

func TestCandidateRefusesUnclassifiedAndValidationFailures(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		mutate func(t *testing.T, x *Executor, r Run, n *Node)
		want   string
	}{
		{"unclassified", func(t *testing.T, x *Executor, r Run, n *Node) {
			writeFixture(t, r.Workspace, "arbitrary.cache", "residue")
			checkpointFixture(t, x, r)
		}, "unclassified"},
		{"new-uncheckpointed", func(t *testing.T, x *Executor, r Run, n *Node) {
			writeFixture(t, r.Workspace, "surprise.txt", "residue")
		}, "changed since its checkpoint"},
		{"failure", func(t *testing.T, x *Executor, r Run, n *Node) { n.Command = "echo diagnostic; exit 9" }, "validation failed"},
		{"mutating-check", func(t *testing.T, x *Executor, r Run, n *Node) { n.Command = "echo mutated > file.txt" }, "validation changed"},
		{"unignored-check-output", func(t *testing.T, x *Executor, r Run, n *Node) { n.Command = "echo output > build-output.bin" }, "validation changed"},
		{"missing-excluded-dependency", func(t *testing.T, x *Executor, r Run, n *Node) {
			writeFixture(t, r.Workspace, "private-helper", "hidden")
			checkpointFixture(t, x, r)
			n.Exclude = []string{"private-helper"}
			n.Command = "test -f private-helper"
		}, "validation failed"},
		{"no-changes", func(t *testing.T, x *Executor, r Run, n *Node) {
			n.Files = []string{"absent"}
			n.Exclude = []string{"file.txt"}
		}, "no selected product changes"},
		{"bad-title", func(t *testing.T, x *Executor, r Run, n *Node) { n.Title = "checkpoint: work\nextra" }, "Conventional Commit"},
		{"empty-body", func(t *testing.T, x *Executor, r Run, n *Node) { n.Body = " " }, "body must"},
		{"overlap", func(t *testing.T, x *Executor, r Run, n *Node) { n.Exclude = []string{"file.txt"} }, "overlapping"},
		{"glob-not-expanded", func(t *testing.T, x *Executor, r Run, n *Node) { n.Files = []string{"*"} }, "unclassified"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			x, r := publicationFixture(t)
			writeFixture(t, r.Workspace, "file.txt", "changed")
			checkpointFixture(t, x, r)
			n := candidateNode()
			tc.mutate(t, x, r, &n)
			_, result := makeCandidate(t, x, r, n)
			if result.Outcome != "failure" || result.Candidate != nil || !strings.Contains(result.Error, tc.want) {
				t.Fatalf("%+v", result)
			}
		})
	}
}

func TestCandidateSupportsLiteralPathsBinaryAndDeletion(t *testing.T) {
	t.Parallel()
	x, r := publicationFixture(t)
	if err := os.Remove(filepath.Join(r.Workspace, "file.txt")); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, r.Workspace, "app/[id].tsx", "route")
	writeFixture(t, r.Workspace, "large file.bin", strings.Repeat("\x00\xffdata", 20000))
	writeFixture(t, r.Workspace, "run.sh", "#!/bin/sh\nexit 0\n")
	if err := os.Chmod(filepath.Join(r.Workspace, "run.sh"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("app/[id].tsx", filepath.Join(r.Workspace, "link")); err != nil {
		t.Fatal(err)
	}
	checkpointFixture(t, x, r)
	n := candidateNode()
	n.Files = []string{"file.txt", "app/[id].tsx", "large file.bin", "run.sh", "link"}
	n.Command = "test ! -e file.txt; test -x run.sh; test -L link; test -f 'app/[id].tsx'; test -f 'large file.bin'"
	r, result := makeCandidate(t, x, r, n)
	if result.Outcome != "success" {
		t.Fatalf("%+v", result)
	}
	data, err := git(context.Background(), x.repoDir(*r.Workflow.Repository), "ls-tree", "-r", r.Candidate.CommitSHA)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(data, "100755") || !strings.Contains(data, "120000") || strings.Contains(data, "file.txt") {
		t.Fatal(data)
	}
}
func TestCandidateInvalidation(t *testing.T) {
	t.Parallel()
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "file.txt", "changed")
	checkpointFixture(t, x, r)
	r, result := makeCandidate(t, x, r, candidateNode())
	if result.Outcome != "success" {
		t.Fatal(result.Error)
	}
	r.Decision = &Decision{CandidateID: "old-candidate"}
	if err := x.verifyCandidate(context.Background(), r); err == nil {
		t.Fatal("stale approval accepted")
	}
	r.Decision = &Decision{CandidateID: r.Candidate.ID}
	if err := x.verifyCandidate(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, r.Workspace, "file.txt", "after approval")
	checkpointFixture(t, x, r)
	if err := x.verifyCandidate(context.Background(), r); err == nil || !strings.Contains(err.Error(), "changed after") {
		t.Fatal("stale source accepted", err)
	}
}
func TestPublicationConventions(t *testing.T) {
	t.Parallel()
	for _, title := range []string{"fix: correct handling", "feat(api)!: change response", "chore(deps): update dependencies"} {
		if err := validatePublicationText(title, "Explain why. Tests passed."); err != nil {
			t.Fatal(err)
		}
	}
	for _, title := range []string{"Fix bug", "fix:no space", "fix: ", "fix: subject\nbody", strings.Repeat("x", 121)} {
		if validatePublicationText(title, "body") == nil {
			t.Fatal("accepted title", title)
		}
	}
	if validatePublicationText("fix: valid", strings.Repeat("x", 4001)) == nil {
		t.Fatal("accepted oversized PR body")
	}
	for _, p := range []string{".", "../outside", "/absolute", "a/../b", ".git/config", "A/.GiT/config", "a\nfile"} {
		if validatePublicationPath(p) == nil {
			t.Fatal("accepted path", p)
		}
	}
}

// Redirect only the transport operations to a disposable local bare remote.
// Origin inspection remains real and still sees the configured GitHub URL.
func localPublicationTransport(t *testing.T, x *Executor, r Run) (Run, string, string) {
	t.Helper()
	ctx := context.Background()
	remote := filepath.Join(t.TempDir(), "remote.git")
	if _, err := git(ctx, "", "clone", "--bare", r.Workflow.Repository.Local, remote); err != nil {
		t.Fatal(err)
	}
	oldCache := x.repoDir(*r.Workflow.Repository)
	r.Workflow.Repository = &Repository{GitHub: "fixture/project", Base: "main"}
	if err := os.Symlink(oldCache, x.repoDir(*r.Workflow.Repository)); err != nil {
		t.Fatal(err)
	}
	if _, err := git(ctx, oldCache, "remote", "set-url", "origin", "https://github.com/fixture/project.git"); err != nil {
		t.Fatal(err)
	}
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	log := filepath.Join(bin, "transport.log")
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("KILN_TEST_GIT_HELPER", "1")
	t.Setenv("KILN_TEST_GIT_BINARY", realGit)
	t.Setenv("KILN_TEST_GIT_REMOTE", remote)
	t.Setenv("KILN_TEST_GIT_LOG", log)
	shim := "#!/bin/sh\nexec '" + strings.ReplaceAll(testBinary, "'", "'\\''") + "' -test.run=TestPublicationGitHelper -- \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	ghShim := "#!/bin/sh\ncase \"$2\" in\nuser) if [ \"${KILN_TEST_LOGIN_FAIL:-0}\" = 1 ]; then exit 1; fi; printf '%s' \"${KILN_TEST_LOGIN-fixture-user}\";;\nlist) printf '%s' \"${KILN_TEST_PRS:-[]}\";;\ncreate) printf '%s' 'https://github.com/fixture/project/pull/1';;\n*) exit 9;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(ghShim), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return r, remote, log
}
func TestPublicationGitHelper(t *testing.T) {
	if os.Getenv("KILN_TEST_GIT_HELPER") != "1" {
		return
	}
	var args []string
	for i, a := range os.Args {
		if a == "--" {
			args = os.Args[i+1:]
			break
		}
	}
	for _, a := range args {
		if a == "push" && os.Getenv("KILN_TEST_CREATE_REF_ON_PUSH") != "" {
			cmd := exec.Command(os.Getenv("KILN_TEST_GIT_BINARY"), "-C", os.Getenv("KILN_TEST_GIT_REMOTE"), "update-ref", os.Getenv("KILN_TEST_CREATE_REF_ON_PUSH"), os.Getenv("KILN_TEST_RACE_BASE"))
			if err := cmd.Run(); err != nil {
				os.Exit(92)
			}
		}
		if a == "push" || a == "ls-remote" {
			f, err := os.OpenFile(os.Getenv("KILN_TEST_GIT_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				os.Exit(90)
			}
			_ = json.NewEncoder(f).Encode(args)
			_ = f.Close()
			for i, a := range args {
				if a == "origin" {
					args[i] = os.Getenv("KILN_TEST_GIT_REMOTE")
				}
			}
			break
		}
	}
	binary := os.Getenv("KILN_TEST_GIT_BINARY")
	if err := syscall.Exec(binary, append([]string{binary}, args...), os.Environ()); err != nil {
		os.Exit(91)
	}
}
func TestPublicationPushesOnlyCandidateAndRetriesSafely(t *testing.T) {
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "file.txt", "changed")
	writeFixture(t, r.Workspace, "private-plan.md", "private marker")
	audit := checkpointFixture(t, x, r)
	r, remote, log := localPublicationTransport(t, x, r)
	n := candidateNode()
	n.Exclude = []string{"private-plan.md"}
	r, result := makeCandidate(t, x, r, n)
	if result.Outcome != "success" {
		t.Fatal(result.Error)
	}
	cache := x.repoDir(*r.Workflow.Repository)
	for _, args := range [][]string{{"config", "push.followTags", "true"}, {"config", "remote.origin.mirror", "true"}, {"tag", "-a", "internal-audit", "-m", "private", audit}} {
		if _, err := git(context.Background(), cache, args...); err != nil {
			t.Fatal(err)
		}
	}
	if want := "fixture-user/fix-fixture"; r.Candidate.Branch != want {
		t.Fatalf("branch %q, want %q", r.Candidate.Branch, want)
	}
	ref := "refs/heads/" + r.Candidate.Branch
	t.Setenv("KILN_TEST_CREATE_REF_ON_PUSH", ref)
	t.Setenv("KILN_TEST_RACE_BASE", r.BaseSHA)
	if got := x.pullRequest(context.Background(), r, Node{Draft: true}); got.Outcome != "failure" {
		t.Fatal("racing remote branch creation was overwritten")
	}
	if head, _ := git(context.Background(), remote, "rev-parse", ref); head != r.BaseSHA {
		t.Fatal("overwrote a racing writer")
	}
	t.Setenv("KILN_TEST_CREATE_REF_ON_PUSH", "")
	if _, err := git(context.Background(), remote, "update-ref", "-d", ref); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, nil, 0600); err != nil {
		t.Fatal(err)
	}
	got := x.pullRequest(context.Background(), r, Node{Draft: true})
	if got.Outcome != "success" {
		t.Fatalf("%+v", got)
	}
	sha, err := git(context.Background(), remote, "rev-parse", ref)
	if err != nil || sha != r.Candidate.CommitSHA {
		t.Fatalf("%s %v", sha, err)
	}
	count, _ := git(context.Background(), remote, "rev-list", "--count", r.BaseSHA+".."+sha)
	if count != "1" {
		t.Fatalf("published %s commits", count)
	}
	if _, err := git(context.Background(), remote, "cat-file", "-e", audit); err == nil {
		t.Fatal("private audit object reached remote")
	}
	tags, _ := git(context.Background(), remote, "tag", "--list")
	if tags != "" {
		t.Fatal("tag leaked", tags)
	}
	if _, err := git(context.Background(), remote, "show", sha+":private-plan.md"); err == nil {
		t.Fatal("private file reached remote")
	}
	// Retry keeps the approved branch even if the active GitHub login changes.
	t.Setenv("KILN_TEST_LOGIN", "another-user")
	// Retry after push or PR creation never force-pushes/repeats the push.
	t.Setenv("KILN_TEST_PRS", fmt.Sprintf(`[{"url":"https://github.com/fixture/project/pull/1","state":"OPEN","headRefOid":%q,"title":%q,"body":%q}]`, sha, r.Candidate.Title, r.Candidate.Body))
	if got := x.pullRequest(context.Background(), r, Node{}); got.Outcome != "success" {
		t.Fatalf("%+v", got)
	}
	b, _ := os.ReadFile(log)
	pushes := 0
	for _, line := range strings.Split(string(b), "\n") {
		var args []string
		if json.Unmarshal([]byte(line), &args) != nil {
			continue
		}
		for _, a := range args {
			if a == "push" {
				pushes++
			}
		}
	}
	if pushes != 1 {
		t.Fatalf("push count %d: %s", pushes, b)
	}
	t.Setenv("KILN_TEST_PRS", fmt.Sprintf(`[{"url":"https://github.com/fixture/project/pull/1","state":"OPEN","headRefOid":%q,"title":"changed","body":"changed"}]`, sha))
	if got := x.pullRequest(context.Background(), r, Node{}); got.Outcome != "failure" || !strings.Contains(got.Error, "PR text changed") {
		t.Fatal("accepted unapproved PR text", got)
	}
	t.Setenv("KILN_TEST_PRS", `[{"url":"https://github.com/fixture/project/pull/1","state":"CLOSED"}]`)
	if got := x.pullRequest(context.Background(), r, Node{}); got.Outcome != "failure" {
		t.Fatal("reused closed PR")
	}
	// Existing remote content is never overwritten, even if it is an ancestor.
	if _, err := git(context.Background(), remote, "update-ref", ref, r.BaseSHA); err != nil {
		t.Fatal(err)
	}
	if got := x.pullRequest(context.Background(), r, Node{}); got.Outcome != "failure" || !strings.Contains(got.Error, "different commit") {
		t.Fatalf("%+v", got)
	}
	if _, err := git(context.Background(), cache, "remote", "set-url", "--push", "origin", "https://elsewhere.invalid/x.git"); err != nil {
		t.Fatal(err)
	}
	if got := x.pullRequest(context.Background(), r, Node{}); got.Outcome != "failure" || !strings.Contains(got.Error, "origin") {
		t.Fatalf("%+v", got)
	}
}
