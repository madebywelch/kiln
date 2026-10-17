package factory

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCandidatePreparationRecovery(t *testing.T) {
	t.Parallel()
	for _, window := range []string{"unrecorded", "journaled", "checkpointed"} {
		t.Run(window, func(t *testing.T) {
			t.Parallel()
			x, r := publicationFixture(t)
			writeFixture(t, r.Workspace, "file.txt", "changed")
			checkpointFixture(t, x, r)
			n := candidateNode()
			n.Command += "; printf x >> \"$KILN_ARTIFACT_DIR/validations\""
			n.Next = map[string]string{"success": "approval"}
			r.Workflow.Nodes["work"] = n
			r.Workflow.Nodes["approval"] = Node{Type: "human", Prompt: "Review", Choices: []string{"accept", "reject"}, Next: map[string]string{"accept": "end", "reject": "end"}}
			// The fixture helper executes a candidate with a persisted attempt identity.
			r, result := makeCandidate(t, x, r, n)
			if result.Outcome != "success" {
				t.Fatal(result.Error)
			}
			original := r.Candidate.ID
			r.Workflow.Nodes["candidate"] = n
			delete(r.Workflow.Nodes, "work")
			r.Workflow.Nodes["start"] = Node{Type: "start", Next: map[string]string{"success": "candidate"}}
			if err := r.Workflow.Validate(); err != nil {
				t.Fatal(err)
			}
			r.Status = "running"
			r.Steps = 1
			r.Visits["candidate"] = 1
			a := &r.Attempts[len(r.Attempts)-1]
			if window == "unrecorded" {
				r.Candidate = nil // Git side effects exist, but no result transaction reached SQLite.
				a.Result = Result{Outcome: "running"}
			} else {
				finished := now()
				a.FinishedAt = &finished
				a.Result = result
				r.Outputs["candidate"] = result
				if window == "checkpointed" {
					if _, err := x.Checkpoint(context.Background(), r, *a); err != nil {
						t.Fatal(err)
					}
				}
			}
			s, err := OpenStore(x.Root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if err := s.commit([]change{{"run", r.ID, r}}, nil, nil); err != nil {
				t.Fatal(err)
			}
			e, err := NewEngine(s, x, 1)
			if err != nil {
				t.Fatal(err)
			}
			e.Start()
			defer e.Close()
			if window == "unrecorded" {
				r = waitRun(t, e, r.ID, settled)
				if r.Status != "interrupted" || r.Candidate != nil {
					t.Fatal("unrecorded candidate was accepted", r.Status)
				}
				if _, err := e.Retry(r.ID); err != nil {
					t.Fatal(err)
				}
			}
			r = waitRun(t, e, r.ID, settled)
			if r.Status != "waiting" || r.Candidate == nil || r.Question.CandidateID != r.Candidate.ID {
				t.Fatalf("%+v", r)
			}
			checks, err := os.ReadFile(filepath.Join(r.Artifacts, "validations"))
			if err != nil {
				t.Fatal(err)
			}
			if window == "unrecorded" {
				if string(checks) != "xx" || r.Candidate.ID == original {
					t.Fatal("explicit retry did not build a new candidate")
				}
			} else if string(checks) != "x" || r.Candidate.ID != original {
				t.Fatal("known validation replayed or candidate changed")
			}
			if err := x.verifyCandidate(context.Background(), r); err != nil {
				t.Fatal(err)
			}
		})
	}
}
