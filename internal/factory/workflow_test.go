package factory

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func basicWorkflow() Workflow {
	return Workflow{Version: 1, Name: "test", Entry: "start", Exit: "end", MaxSteps: 30, Nodes: map[string]Node{
		"start": {Type: "start", Next: map[string]string{"success": "work"}},
		"work":  {Type: "command", Command: "printf done", Next: map[string]string{"success": "end"}},
		"end":   {Type: "end"},
	}}
}
func workflowYAML(t *testing.T, w Workflow) string {
	t.Helper()
	data, err := yaml.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestWorkflowValidation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Workflow)
		want   string
	}{
		{"unknown type", func(w *Workflow) { n := w.Nodes["work"]; n.Type = "typo"; w.Nodes["work"] = n }, "unsupported type"},
		{"missing target", func(w *Workflow) {
			w.Nodes["work"] = Node{Type: "command", Command: "true", Next: map[string]string{"success": "missing"}}
		}, "invalid edge target"},
		{"unreachable", func(w *Workflow) {
			w.Nodes["orphan"] = Node{Type: "command", Command: "true", Next: map[string]string{"success": "end"}}
		}, "reachable"},
		{"trap cycle", func(w *Workflow) {
			n := w.Nodes["work"]
			n.Next["failure"] = "trap"
			w.Nodes["work"] = n
			w.Nodes["trap"] = Node{Type: "command", Command: "true", Next: map[string]string{"success": "trap"}}
		}, "path to exit"},
		{"bad budget", func(w *Workflow) { w.MaxSteps = -1 }, "max_steps"},
		{"duplicate start", func(w *Workflow) { w.Nodes["work"] = Node{Type: "start", Next: map[string]string{"success": "end"}} }, "exactly one start"},
		{"invalid end", func(w *Workflow) { w.Nodes["end"] = Node{Type: "end", Next: map[string]string{"success": "work"}} }, "no outgoing"},
		{"return to start", func(w *Workflow) { n := w.Nodes["work"]; n.Next["failure"] = "start"; w.Nodes["work"] = n }, "invalid edge"},
		{"unknown outcome", func(w *Workflow) { n := w.Nodes["work"]; n.Next["sucess"] = "end"; w.Nodes["work"] = n }, "unknown outcome"},
		{"irrelevant model field", func(w *Workflow) { n := w.Nodes["work"]; n.Model = "ignored"; w.Nodes["work"] = n }, "not supported"},
		{"end with command", func(w *Workflow) { n := w.Nodes["end"]; n.Command = "echo ignored"; w.Nodes["end"] = n }, "not supported"},
		{"negative timeout", func(w *Workflow) { n := w.Nodes["work"]; n.Timeout = "-1s"; w.Nodes["work"] = n }, "timeout"},
		{"ambiguous repo", func(w *Workflow) { w.Repository = &Repository{GitHub: "a/b", Local: "/tmp/repo"} }, "exactly one"},
		{"option injection", func(w *Workflow) { w.Repository = &Repository{GitHub: "-bad/repo"} }, "owner/repo"},
		{"template syntax", func(w *Workflow) { n := w.Nodes["work"]; n.Env = map[string]string{"GOAL": "{{"}; w.Nodes["work"] = n }, "template"},
		{"human missing choice edge", func(w *Workflow) {
			w.Nodes["work"] = Node{Type: "human", Prompt: "approve?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "end"}}
		}, "missing edge"},
		{"PR without github", func(w *Workflow) {
			w.Nodes["work"] = Node{Type: "pull_request", Title: "x", Next: map[string]string{"success": "end"}}
		}, "GitHub"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := basicWorkflow()
			tt.mutate(&w)
			err := w.Validate()
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want %q, got %v", tt.want, err)
			}
		})
	}
	valid := workflowYAML(t, basicWorkflow())
	for _, data := range []string{valid + "\ntyop: 1\n", valid + "\n---\n" + valid, valid + "\nname: duplicate\n"} {
		if _, err := ParseWorkflow([]byte(data)); err == nil {
			t.Fatal("accepted malformed YAML")
		}
	}
	if _, err := ParseWorkflow([]byte(valid)); err != nil {
		t.Fatal(err)
	}
}
func TestTemplatesAreStrictAndUseJSONFieldNames(t *testing.T) {
	r := makeRun(basicWorkflow(), "revision", "", map[string]string{"goal": "fix"})
	r.Outputs["build"] = Result{Output: "bad build"}
	s, err := render("{{ .inputs.goal }}: {{ .outputs.build.output }} ({{ .run.id }})", r)
	if err != nil || !strings.Contains(s, "fix: bad build") {
		t.Fatalf("%q: %v", s, err)
	}
	if _, err := render("{{ .inputs.typo }}", r); err == nil {
		t.Fatal("missing input accepted")
	}
}
