package factory

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"text/template"
	"time"

	"gopkg.in/yaml.v3"
)

var namePattern = regexp.MustCompile("^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")
var envPattern = regexp.MustCompile("^[A-Za-z_][A-Za-z0-9_]*$")
var repoPattern = regexp.MustCompile("^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$")

type Workflow struct {
	Version     int               `json:"version" yaml:"version"`
	Name        string            `json:"name" yaml:"name"`
	Description string            `json:"description,omitempty" yaml:"description,omitempty"`
	Repository  *Repository       `json:"repository,omitempty" yaml:"repository,omitempty"`
	Entry       string            `json:"entry" yaml:"entry"`
	Exit        string            `json:"exit" yaml:"exit"`
	MaxSteps    int               `json:"max_steps" yaml:"max_steps"`
	Inputs      map[string]string `json:"inputs,omitempty" yaml:"inputs,omitempty"`
	Nodes       map[string]Node   `json:"nodes" yaml:"nodes"`
}

type Repository struct {
	GitHub string `json:"github,omitempty" yaml:"github,omitempty"`
	Local  string `json:"local,omitempty" yaml:"local,omitempty"`
	Base   string `json:"base,omitempty" yaml:"base,omitempty"`
}

type Node struct {
	Selection    string            `json:"selection,omitempty" yaml:"selection,omitempty"`
	Files        []string          `json:"files,omitempty" yaml:"files,omitempty"`
	Exclude      []string          `json:"exclude,omitempty" yaml:"exclude,omitempty"`
	Skills       []string          `json:"skills,omitempty" yaml:"skills,omitempty"`
	MCP          []string          `json:"mcp,omitempty" yaml:"mcp,omitempty"`
	Type         string            `json:"type" yaml:"type"`
	Next         map[string]string `json:"next,omitempty" yaml:"next,omitempty"`
	Command      string            `json:"command,omitempty" yaml:"command,omitempty"`
	Prompt       string            `json:"prompt,omitempty" yaml:"prompt,omitempty"`
	Model        string            `json:"model,omitempty" yaml:"model,omitempty"`
	Provider     string            `json:"provider,omitempty" yaml:"provider,omitempty"`
	ArtifactFile string            `json:"artifact_file,omitempty" yaml:"artifact_file,omitempty"`
	Choices      []string          `json:"choices,omitempty" yaml:"choices,omitempty"`
	Timeout      string            `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	MaxTokens    int               `json:"max_tokens,omitempty" yaml:"max_tokens,omitempty"`
	MaxVisits    int               `json:"max_visits,omitempty" yaml:"max_visits,omitempty"`
	Env          map[string]string `json:"env,omitempty" yaml:"env,omitempty"`
	PassEnv      []string          `json:"pass_env,omitempty" yaml:"pass_env,omitempty"`
	Title        string            `json:"title,omitempty" yaml:"title,omitempty"`
	Body         string            `json:"body,omitempty" yaml:"body,omitempty"`
	Draft        bool              `json:"draft,omitempty" yaml:"draft,omitempty"`
}

func ParseWorkflow(data []byte) (Workflow, error) {
	var w Workflow
	d := yaml.NewDecoder(bytes.NewReader(data))
	d.KnownFields(true)
	if err := d.Decode(&w); err != nil {
		return w, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return w, errors.New("expected exactly one YAML document")
	}
	if w.MaxSteps == 0 {
		w.MaxSteps = 100
	}
	return w, w.Validate()
}

func (w Workflow) Validate() error {
	if w.Version != 1 {
		return errors.New("version must be 1")
	}
	if !namePattern.MatchString(w.Name) {
		return errors.New("name must be an identifier of 1-64 characters")
	}
	if w.MaxSteps < 1 || w.MaxSteps > 1000 {
		return errors.New("max_steps must be between 1 and 1000")
	}
	if len(w.Nodes) < 2 || len(w.Nodes) > 100 {
		return errors.New("expected 2-100 nodes")
	}
	if w.Nodes[w.Entry].Type != "start" || w.Nodes[w.Exit].Type != "end" || w.Entry == w.Exit {
		return errors.New("entry must name a start node and exit must name an end node")
	}
	if r := w.Repository; r != nil {
		if (r.GitHub == "") == (r.Local == "") {
			return errors.New("repository requires exactly one of github or local")
		}
		if r.GitHub != "" && (!repoPattern.MatchString(r.GitHub) || strings.Contains(r.GitHub, "..") || strings.HasPrefix(r.GitHub, "-")) {
			return errors.New("repository.github must be owner/repo")
		}
		if strings.HasPrefix(r.Base, "-") || strings.ContainsAny(r.Base, "\n\r\x00") {
			return errors.New("invalid repository.base")
		}
	}
	changesets, publishers := 0, 0
	for id, n := range w.Nodes {
		if !namePattern.MatchString(id) {
			return fmt.Errorf("invalid node identifier %q", id)
		}
		if n.MaxTokens < 0 || n.MaxTokens > 32768 {
			return fmt.Errorf("%s: max_tokens must be 0-32768 (0 defaults to 4096)", id)
		}
		if n.Type == "human" && n.Timeout != "" {
			return fmt.Errorf("%s: human gates do not expire; timeout is not supported", id)
		}
		if n.MaxVisits < 0 || n.MaxVisits > 1000 {
			return fmt.Errorf("%s: max_visits must be 0-1000", id)
		}
		if n.Timeout != "" {
			d, err := time.ParseDuration(n.Timeout)
			if err != nil || d < time.Millisecond || d > 24*time.Hour {
				return fmt.Errorf("%s: timeout must be 1ms-24h", id)
			}
		}
		outcomes := []string{"success", "failure"}
		switch n.Type {
		case "start":
			if id != w.Entry {
				return errors.New("exactly one start node is required")
			}
			outcomes = []string{"success"}
		case "end":
			if id != w.Exit || len(n.Next) != 0 {
				return errors.New("exactly one end node is required, with no outgoing edges")
			}
			outcomes = nil
		case "command":
			if n.Command == "" {
				return fmt.Errorf("%s: command is required", id)
			}
		case "agent":
			if n.Prompt == "" || n.Model == "" || (n.Provider != "openrouter" && n.Provider != "codex") {
				return fmt.Errorf("%s: agent requires prompt, model, and provider (openrouter or codex)", id)
			}
			if strings.HasPrefix(n.Model, "-") || strings.ContainsAny(n.Model, "\r\n\x00") {
				return fmt.Errorf("%s: invalid model", id)
			}
		case "llm":
			if n.Prompt == "" || n.Model == "" || n.Provider == "" {
				return fmt.Errorf("%s: llm requires prompt, model and provider", id)
			}
		case "human":
			if n.Prompt == "" || len(n.Choices) < 2 {
				return fmt.Errorf("%s: human requires prompt and at least two choices", id)
			}
			seen := map[string]bool{}
			for _, c := range n.Choices {
				if !namePattern.MatchString(c) || seen[c] {
					return fmt.Errorf("%s: invalid or duplicate choice", id)
				}
				seen[c] = true
				if n.Next[c] == "" {
					return fmt.Errorf("%s: missing edge for choice %s", id, c)
				}
			}
			outcomes = n.Choices
		case "changeset":
			changesets++
			if w.Repository == nil || (len(n.Files) == 0 && n.Selection == "") || n.Command == "" || n.Title == "" || n.Body == "" {
				return fmt.Errorf("%s: changeset requires repository, files or selection, command, title and body", id)
			}
			if n.Selection != "" && (len(n.Files) > 0 || len(n.Exclude) > 0) {
				return fmt.Errorf("%s: selection cannot be combined with files/exclude", id)
			}
			if len(n.Files)+len(n.Exclude) > 256 {
				return fmt.Errorf("%s: at most 256 publication paths", id)
			}
			for _, p := range append(append([]string{}, n.Files...), n.Exclude...) {
				if !strings.Contains(p, "{{") {
					if err := validatePublicationPath(p); err != nil {
						return fmt.Errorf("%s: %w", id, err)
					}
				}
			}
			if !strings.Contains(n.Title, "{{") && !strings.Contains(n.Body, "{{") {
				if err := validatePublicationText(n.Title, n.Body); err != nil {
					return fmt.Errorf("%s: %w", id, err)
				}
			}
		case "pull_request":
			publishers++
			if w.Repository == nil || w.Repository.GitHub == "" {
				return fmt.Errorf("%s: pull_request requires a GitHub repository", id)
			}
		default:
			return fmt.Errorf("%s: unsupported type %q", id, n.Type)
		}
		for _, names := range [][]string{n.Skills, n.MCP} {
			seen := map[string]bool{}
			for _, name := range names {
				if !namePattern.MatchString(name) || seen[name] {
					return fmt.Errorf("%s: invalid or duplicate skill/MCP name %q", id, name)
				}
				seen[name] = true
			}
		}
		if (len(n.Skills) > 0 || len(n.MCP) > 0) && (n.Type != "agent" || n.Provider != "openrouter") {
			return fmt.Errorf("%s: skills/mcp are supported on Pi-backed OpenRouter agent nodes", id)
		}
		fields := []struct {
			present bool
			name    string
			types   []string
		}{
			{n.Command != "", "command", []string{"command", "changeset"}},
			{len(n.Files) > 0 || len(n.Exclude) > 0 || n.Selection != "", "files/exclude/selection", []string{"changeset"}},
			{n.Prompt != "", "prompt", []string{"agent", "llm", "human"}},
			{n.Provider != "" || n.Model != "", "provider/model", []string{"llm", "agent"}},
			{n.MaxTokens != 0 || n.ArtifactFile != "", "max_tokens/artifact_file", []string{"llm"}},
			{len(n.Choices) > 0, "choices", []string{"human"}},
			{len(n.Env) > 0 || len(n.PassEnv) > 0, "env/pass_env", []string{"command", "agent", "changeset"}},
			{n.Title != "" || n.Body != "", "title/body", []string{"changeset"}},
			{n.Draft, "draft", []string{"pull_request"}},
		}
		for _, field := range fields {
			if field.present && !slices.Contains(field.types, n.Type) {
				return fmt.Errorf("%s: %s is not supported on %s nodes", id, field.name, n.Type)
			}
		}
		if n.Type != "human" && n.Type != "end" && n.Next["success"] == "" {
			return fmt.Errorf("%s: success edge is required", id)
		}
		for outcome, dest := range n.Next {
			if !slices.Contains(outcomes, outcome) {
				return fmt.Errorf("%s: unknown outcome %q", id, outcome)
			}
			if _, ok := w.Nodes[dest]; !ok || dest == w.Entry {
				return fmt.Errorf("%s: invalid edge target %q", id, dest)
			}
		}
		// Shell source is intentionally not templated. Inputs are environment data.
		values := append([]string{n.Prompt, n.Title, n.Body, n.ArtifactFile, n.Selection}, n.Files...)
		values = append(values, n.Exclude...)
		for key, value := range n.Env {
			if !envPattern.MatchString(key) {
				return fmt.Errorf("%s: invalid environment key %q", id, key)
			}
			values = append(values, value)
		}
		for _, value := range values {
			if _, err := template.New("validate").Parse(value); err != nil {
				return fmt.Errorf("%s: invalid template: %w", id, err)
			}
		}
	}
	if changesets > 1 || publishers > 1 {
		return errors.New("one changeset node and one pull_request node per workflow; loops may revisit them")
	}
	if publishers > 0 && changesets != 1 {
		return errors.New("pull_request requires a changeset node")
	}
	reachable := func(from string, reverse bool) map[string]bool {
		seen := map[string]bool{}
		var walk func(string)
		walk = func(id string) {
			if seen[id] {
				return
			}
			seen[id] = true
			if reverse {
				for other, n := range w.Nodes {
					for _, dest := range n.Next {
						if dest == id {
							walk(other)
						}
					}
				}
			} else {
				for _, dest := range w.Nodes[id].Next {
					walk(dest)
				}
			}
		}
		walk(from)
		return seen
	}
	if len(reachable(w.Entry, false)) != len(w.Nodes) {
		return errors.New("every node must be reachable from entry")
	}
	if len(reachable(w.Exit, true)) != len(w.Nodes) {
		return errors.New("every node must have a path to exit")
	}
	return nil
}

func render(s string, r Run) (string, error) {
	t, err := template.New("node").Option("missingkey=error").Parse(s)
	if err != nil {
		return "", err
	}
	var b bytes.Buffer
	data, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	var normalized map[string]any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return "", err
	}
	err = t.Execute(&b, map[string]any{"inputs": r.Inputs, "outputs": normalized["outputs"], "run": normalized, "decision": normalized["decision"]})
	return b.String(), err
}
