package factory

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func seedRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()
	for _, args := range [][]string{{"init", "-b", "main"}, {"config", "user.name", "Test"}, {"config", "user.email", "test@example.invalid"}} {
		if _, err := git(ctx, dir, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := git(ctx, dir, "add", "."); err != nil {
		t.Fatal(err)
	}
	if _, err := git(ctx, dir, "commit", "--no-gpg-sign", "-m", "test: seed"); err != nil {
		t.Fatal(err)
	}
	return dir
}
func TestGitWorktreesIsolationDiffAndCleanup(t *testing.T) {
	t.Parallel()
	source := seedRepo(t)
	e := testEngine(t, nil)
	w := basicWorkflow()
	w.Repository = &Repository{Local: source, Base: "main"}
	n := w.Nodes["work"]
	n.Command = "printf changed > file.txt"
	w.Nodes["work"] = n
	a, b := submitWorkflow(t, e, w), submitWorkflow(t, e, w)
	a = waitRun(t, e, a.ID, settled)
	b = waitRun(t, e, b.ID, settled)
	if a.Status != "succeeded" || b.Status != "succeeded" || a.Branch == b.Branch || a.Workspace == b.Workspace {
		t.Fatalf("bad isolation: %+v %+v", a, b)
	}
	original, err := os.ReadFile(filepath.Join(source, "file.txt"))
	if err != nil || string(original) != "original\n" {
		t.Fatal("modified source repo")
	}
	diff, err := e.exec.Diff(context.Background(), a)
	if err != nil || !strings.Contains(diff.Diff, "+changed") {
		t.Fatalf("%+v %v", diff, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		_, err := e.Cleanup(context.Background(), a.ID)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stat(b.Workspace); err != nil {
		t.Fatal("cleanup touched another run")
	}
	if _, err := os.Stat(a.Workspace); !os.IsNotExist(err) {
		t.Fatal("cleanup retained worktree")
	}
}
func TestWorktreePreparationRecoveryAndRouting(t *testing.T) {
	t.Parallel()
	source := seedRepo(t)
	x := Executor{Root: t.TempDir(), AllowLocal: true}
	w := basicWorkflow()
	w.Repository = &Repository{Local: source}
	r := makeRun(w, "rev", "", nil)
	prepared, err := x.Prepare(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prepared.Workspace, "file.txt"), []byte("retain this"), 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := x.Prepare(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.BaseSHA != prepared.BaseSHA || recovered.Branch != prepared.Branch {
		t.Fatal("preparation recovery lost base")
	}
	b, err := os.ReadFile(filepath.Join(recovered.Workspace, "file.txt"))
	if err != nil || string(b) != "retain this" {
		t.Fatal("preparation recovery erased work")
	}
	if _, err := git(context.Background(), x.repoDir(*w.Repository), "remote", "set-url", "--push", "origin", "https://gitea.invalid/test/repo.git"); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Prepare(context.Background(), r); err == nil || !strings.Contains(err.Error(), "origin") {
		t.Fatal("changed remote accepted")
	}
}
func TestLocalRepositoriesDisabledByDefault(t *testing.T) {
	t.Parallel()
	e := testEngine(t, func(x *Executor) { x.AllowLocal = false })
	w := basicWorkflow()
	w.Repository = &Repository{Local: "/tmp/repo"}
	if _, err := e.Register(workflowYAML(t, w), ""); err == nil {
		t.Fatal("local repo accepted")
	}
}
