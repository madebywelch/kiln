package factory

import (
	"context"
	"strings"
	"testing"
)

func TestPublicationBranch(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ title, want string }{
		{"feat: add search", "octocat/feat-add-search"},
		{"fix(intervals): merge without mutating inputs", "octocat/fix-intervals"},
		{"feat(api)!: Support V2 / endpoints [new]", "octocat/feat-api"},
		{"fix: 修复缓存", "octocat/fix-修复缓存"},
		{"fix: handle empty responses without exceptions", "octocat/fix-handle-empty-responses"},
		{"fix(cache/storage): correct eviction", "octocat/fix-cache-storage"},
		// Daily scopes must stay distinct; the day was previously dropped.
		{"chore(deps-2026-10-09): update JavaScript dependencies", "octocat/chore-deps-2026-10-09"},
		{"chore(deps-2026-10-10): update JavaScript dependencies", "octocat/chore-deps-2026-10-10"},
		{"feat(a-b-c-d-e-f): six parts", "octocat/feat-a-b-c-d-e-f"},
	} {
		got, err := publicationBranch("octocat", tc.title)
		if err != nil || got != tc.want {
			t.Fatalf("%q: %q %v", tc.title, got, err)
		}
		if _, err := git(context.Background(), "", "check-ref-format", "--branch", got); err != nil {
			t.Fatal(err)
		}
	}
	long, err := publicationBranch("octocat", "feat: "+strings.Repeat("word ", 100))
	if err != nil || long != "octocat/feat-word-word-word" {
		t.Fatal(long, err)
	}
	for _, login := range []string{"", "../outside", "-option", "name/branch", "trailing-", "two--hyphens", "bot[bot]", "name\nother", strings.Repeat("a", 40)} {
		if _, err := publicationBranch(login, "fix: product"); err == nil {
			t.Fatal("accepted login", login)
		}
	}
	// Oversized scopes are rejected, never truncated into a colliding name.
	for _, title := range []string{"!!!", "fix: !!!", "fix: " + strings.Repeat("x", 40), "fix(" + strings.Repeat("x", 29) + "): too long", "chore(deps-2026-10-10-and-more-words): x"} {
		if _, err := publicationBranch("octocat", title); err == nil {
			t.Fatal("accepted missing/oversized topic", title)
		}
	}
	if exact, err := publicationBranch("octocat", "fix("+strings.Repeat("x", 28)+"): fits"); err != nil || exact != "octocat/fix-"+strings.Repeat("x", 28) {
		t.Fatal(exact, err)
	}
	bounded, err := publicationBranch("octocat", "fix: authentication response processing errors")
	if err != nil || bounded != "octocat/fix-authentication-response" {
		t.Fatal("split a word or exceeded the limit", bounded, err)
	}
}

func TestCandidateRequiresGitHubIdentity(t *testing.T) {
	x, r := publicationFixture(t)
	writeFixture(t, r.Workspace, "file.txt", "changed")
	checkpointFixture(t, x, r)
	r, _, _ = localPublicationTransport(t, x, r)
	t.Setenv("KILN_TEST_LOGIN_FAIL", "1")
	if _, result := makeCandidate(t, x, r, candidateNode()); result.Outcome != "failure" || !strings.Contains(result.Error, "resolve publication GitHub user") {
		t.Fatalf("%+v", result)
	}
	t.Setenv("KILN_TEST_LOGIN_FAIL", "0")
	t.Setenv("KILN_TEST_LOGIN", "")
	if _, result := makeCandidate(t, x, r, candidateNode()); result.Outcome != "failure" || !strings.Contains(result.Error, "GitHub user login") {
		t.Fatalf("%+v", result)
	}
	t.Setenv("KILN_TEST_LOGIN", "fixture-user")
	r, result := makeCandidate(t, x, r, candidateNode())
	if result.Outcome != "success" {
		t.Fatal(result.Error)
	}
	r.Candidate.Branch = "kiln/pr/" + r.ID
	if err := x.verifyCandidate(context.Background(), r); err == nil {
		t.Fatal("accepted branded legacy branch")
	}
}
