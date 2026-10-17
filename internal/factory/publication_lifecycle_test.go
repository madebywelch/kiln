package factory

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCandidateQuestionSurvivesRestart(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	x := &Executor{Root: dir, AllowLocal: true}
	e, err := NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	w := basicWorkflow()
	w.Repository = &Repository{Local: seedRepo(t)}
	w.Nodes["work"] = Node{Type: "command", Command: "printf changed > file.txt", Next: map[string]string{"success": "candidate"}}
	n := candidateNode()
	n.Next = map[string]string{"success": "approval"}
	w.Nodes["candidate"] = n
	w.Nodes["approval"] = Node{Type: "human", Prompt: "Review {{ .run.candidate.commit_sha }}", Choices: []string{"accept", "reject"}, Next: map[string]string{"accept": "end", "reject": "end"}}
	r := submitWorkflow(t, e, w)
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "waiting" || r.Candidate == nil || r.Question.CandidateID != r.Candidate.ID {
		t.Fatalf("%+v", r)
	}
	question, candidate := r.Question.ID, r.Candidate.ID
	e.Close()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, err = NewEngine(s, x, 1)
	if err != nil {
		t.Fatal(err)
	}
	e.Start()
	defer e.Close()
	r, err = e.GetRun(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Question.ID != question || r.Question.CandidateID != candidate || r.Candidate.ID != candidate {
		t.Fatal("candidate approval changed on restart")
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: question, CandidateID: "stale", Choice: "accept"}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale candidate accepted", err)
	}
	if _, err := e.Decide(r.ID, Decision{QuestionID: question, CandidateID: candidate, Choice: "accept"}); err != nil {
		t.Fatal(err)
	}
	r = waitRun(t, e, r.ID, settled)
	if r.Status != "succeeded" || r.Decision.CandidateID != candidate {
		t.Fatalf("%+v", r)
	}
	if err := x.verifyCandidate(context.Background(), r); err != nil {
		t.Fatal(err)
	}
}

func TestGeneratedPublicationSelection(t *testing.T) {
	t.Parallel()
	r := makeRun(basicWorkflow(), "rev", "", map[string]string{"selection": `{"files":["src/main.go"],"exclude":["plan.md"]}`})
	selected, err := publicationSelection(Node{Selection: "{{ .inputs.selection }}"}, r)
	if err != nil || !selected["src/main.go"] || selected["plan.md"] || len(selected) != 2 {
		t.Fatalf("%v %v", selected, err)
	}
	for _, value := range []string{"not JSON", "[]", "null", "{}", `{"files":["../escape"]}`, `{"files":["x"],"unexpected":true}`, `{"files":["x"],"files":["y"]}`, `{"files":["x"]} {}`} {
		if _, err := publicationSelection(Node{Selection: value}, r); err == nil {
			t.Fatal("accepted", value)
		}
	}
	selected, err = publicationSelection(Node{Selection: "{\"files\":[\"{{ .inputs.secret }}\"]}"}, r)
	// The outer template intentionally fails; generated JSON is never rendered twice.
	if err == nil || selected != nil {
		t.Fatal("missing template value accepted")
	}
	r.Inputs["selection"] = "{\"files\":[\"literal{{text}}.go\"]}"
	selected, err = publicationSelection(Node{Selection: "{{ .inputs.selection }}"}, r)
	if err != nil || !selected["literal{{text}}.go"] {
		t.Fatal("rendered model data as a template", err)
	}
}

func TestArtifactAPIIsPrivateAndConfined(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	r := submitWorkflow(t, e, basicWorkflow())
	r = waitRun(t, e, r.ID, settled)
	writeFixture(t, r.Artifacts, "notes/plan.md", "private plan")
	outside := t.TempDir()
	writeFixture(t, outside, "secret", "do not expose")
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(r.Artifacts, "escape")); err != nil {
		t.Fatal(err)
	}
	h := NewAPI(e, APIConfig{Token: testToken})
	url := "/v1/runs/" + r.ID + "/artifacts/"
	if got := string(request(t, h, "GET", url+"notes/plan.md", nil, nil, 200)); got != "private plan" {
		t.Fatal(got)
	}
	request(t, h, "GET", url+"notes/plan.md", nil, map[string]string{"Authorization": ""}, 401)
	request(t, h, "GET", url+"escape", nil, nil, 404)
	request(t, h, "GET", url+"notes", nil, nil, 404)
	request(t, h, "GET", url+"missing", nil, nil, 404)
	waitRun(t, e, r.ID, func(r Run) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.active[r.ID] == nil })
	if _, err := e.Cleanup(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	request(t, h, "GET", url+"notes/plan.md", nil, nil, 200)
}

func TestConfiguredPublicationIdentity(t *testing.T) {
	t.Setenv("GIT_AUTHOR_NAME", "Configured Author")
	t.Setenv("GIT_AUTHOR_EMAIL", "author@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Configured Committer")
	t.Setenv("GIT_COMMITTER_EMAIL", "committer@example.invalid")
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "file.txt", "changed")
	checkpointFixture(t, x, r)
	r, result := makeCandidate(t, x, r, candidateNode())
	if result.Outcome != "success" {
		t.Fatal(result.Error)
	}
	if r.Candidate.Author != "Configured Author <author@example.invalid>" || r.Candidate.Committer != "Configured Committer <committer@example.invalid>" {
		t.Fatalf("%+v", r.Candidate)
	}
	msg, _ := git(context.Background(), x.repoDir(*r.Workflow.Repository), "show", "-s", "--format=%B", r.Candidate.CommitSHA)
	if msg != r.Candidate.Title || strings.Contains(msg, "Co-Authored-By") {
		t.Fatal("identity attribution leaked", msg)
	}
}

func TestPublicationRequiresConfiguredIdentity(t *testing.T) {
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "file.txt", "changed")
	checkpointFixture(t, x, r)
	for _, key := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
	_, result := makeCandidate(t, x, r, candidateNode())
	if result.Outcome != "failure" || result.Candidate != nil {
		t.Fatal("guessed publication identity", result)
	}
}
func TestCandidateBuildProductsAreNeverImported(t *testing.T) {
	t.Parallel()
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "file.txt", "changed")
	writeFixture(t, r.Workspace, ".gitignore", "build/\n")
	checkpointFixture(t, x, r)
	n := candidateNode()
	n.Files = append(n.Files, ".gitignore")
	n.Command += "; mkdir build; printf generated > build/cache.bin"
	r, result := makeCandidate(t, x, r, n)
	if result.Outcome != "success" {
		t.Fatal(result.Error)
	}
	tree, err := git(context.Background(), x.repoDir(*r.Workflow.Repository), "ls-tree", "-r", "--name-only", r.Candidate.CommitSHA)
	if err != nil || strings.Contains(tree, "cache.bin") {
		t.Fatalf("build product imported: %s %v", tree, err)
	}
}
func TestCandidateFileToDirectoryReplacement(t *testing.T) {
	t.Parallel()
	x, r := publicationFixture(t)
	if err := os.Remove(filepath.Join(r.Workspace, "file.txt")); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, r.Workspace, "file.txt/product", "product")
	writeFixture(t, r.Workspace, "file.txt/scratch", "private")
	checkpointFixture(t, x, r)
	n := candidateNode()
	n.Files = []string{"file.txt", "file.txt/product"}
	n.Exclude = []string{"file.txt/scratch"}
	n.Command = "test -f file.txt/product; test ! -e file.txt/scratch"
	_, result := makeCandidate(t, x, r, n)
	if result.Outcome != "success" {
		t.Fatal(result.Error)
	}
}
