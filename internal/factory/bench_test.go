package factory

import (
	"fmt"
	"strings"
	"testing"
)

func benchWorkflow() Workflow {
	return Workflow{Version: 1, Name: "bench", Entry: "start", Exit: "end", MaxSteps: 100, Nodes: map[string]Node{
		"start": {Type: "start", Next: map[string]string{"success": "work"}},
		"work":  {Type: "command", Command: "true", Next: map[string]string{"success": "end"}},
		"end":   {Type: "end"},
	}}
}

// benchRun is a run whose attempts carry full-size outputs, the shape a long
// repair loop produces.
func benchRun(attempts int) Run {
	r := makeRun(benchWorkflow(), "rev", "", map[string]string{"task": "bench"})
	output := strings.Repeat("line of command output\n", outputLimit/23)
	for i := 0; i < attempts; i++ {
		t := now()
		a := Attempt{ID: newID(), Node: "work", StartedAt: t, FinishedAt: &t, Finalized: true, CheckpointSHA: strings.Repeat("a", 40), Result: Result{Outcome: "success", Output: output}}
		r.Attempts = append(r.Attempts, a)
		r.Outputs["work"] = a.Result
	}
	return r
}

func BenchmarkRender(b *testing.B) {
	for _, n := range []int{1, 20, 100} {
		r := benchRun(n)
		b.Run(fmt.Sprintf("attempts=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := render("{{ .inputs.task }} {{ .outputs.work.outcome }}", r); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// benchStore holds runs terminal runs plus ten queued ones, half of them
// owned by an automation, each with one full-size attempt.
func benchStore(b *testing.B, runs int) *Store {
	b.Helper()
	s, err := OpenStore(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	changes := make([]change, 0, runs+10)
	for i := 0; i < runs+10; i++ {
		r := benchRun(1)
		if i%2 == 0 {
			r.AutomationID = "nightly"
		}
		r.Status = "succeeded"
		if i >= runs {
			r.Status = "queued"
		}
		changes = append(changes, change{"run", r.ID, r})
	}
	if err := s.commit(changes, nil, nil); err != nil {
		b.Fatal(err)
	}
	return s
}

func BenchmarkListRuns(b *testing.B) {
	s := benchStore(b, 1000)
	b.Run("all/page", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := list[Run](s, "run", "", 50, 0); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("queued", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := list[Run](s, "run", "queued", 14, 0); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkAutomationBusy(b *testing.B) {
	e := &Engine{store: benchStore(b, 1000)}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := e.automationBusy("nightly"); err != nil {
			b.Fatal(err)
		}
	}
}

// Node environments render one template per variable against the same run.
func BenchmarkNodeVariables(b *testing.B) {
	r := benchRun(100)
	n := Node{Type: "command", Command: "true", Env: map[string]string{}}
	for i := 0; i < 10; i++ {
		n.Env[fmt.Sprintf("VAR_%d", i)] = "{{ .inputs.task }} {{ .outputs.work.outcome }}"
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := nodeVariables(n, r); err != nil {
			b.Fatal(err)
		}
	}
}
