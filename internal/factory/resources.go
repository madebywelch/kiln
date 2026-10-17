package factory

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Server-side registry. Workflows reference names, never transport credentials.
// The small common subset is intentional: stdio or HTTP, without interactive OAuth.
type MCPServer struct {
	Command string            `yaml:"command,omitempty" json:"command,omitempty"`
	Args    []string          `yaml:"args,omitempty" json:"args,omitempty"`
	Env     map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
	URL     string            `yaml:"url,omitempty" json:"url,omitempty"`
	Headers map[string]string `yaml:"headers,omitempty" json:"headers,omitempty"`
}

var envReference = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func ValidateMCP(servers map[string]MCPServer) error {
	names := map[string]bool{}
	for name, s := range servers {
		normalized := strings.ReplaceAll(name, "-", "_")
		if !namePattern.MatchString(name) || names[normalized] {
			return fmt.Errorf("invalid or colliding MCP name %q", name)
		}
		names[normalized] = true
		if (s.Command == "") == (s.URL == "") {
			return fmt.Errorf("MCP %s requires exactly one of command or url", name)
		}
		if s.URL != "" {
			u, err := url.Parse(s.URL)
			if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
				return fmt.Errorf("MCP %s requires an HTTP(S) URL without userinfo", name)
			}
			if len(s.Args) > 0 || len(s.Env) > 0 {
				return fmt.Errorf("MCP %s: args/env require command", name)
			}
		} else if len(s.Headers) > 0 {
			return fmt.Errorf("MCP %s: headers require url", name)
		}
		for key := range s.Env {
			if !envPattern.MatchString(key) {
				return fmt.Errorf("MCP %s: invalid environment name", name)
			}
		}
		for _, values := range []map[string]string{s.Env, s.Headers} {
			for _, value := range values {
				for _, match := range envReference.FindAllStringSubmatch(value, -1) {
					switch match[1] {
					case "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "CODEX_HOME", "KILN_INFERENCE_KEY", "KILN_CONTEXT_FILE", "KILN_WORKSPACE", "KILN_RUN_ID", "KILN_BASE_SHA", "KILN_ARTIFACT_DIR":
						return fmt.Errorf("MCP %s: %s is reserved by KILN", name, match[1])
					}
				}
				if strings.HasPrefix(value, "!") {
					return fmt.Errorf("MCP %s: command interpolation is not supported; use ${ENV_NAME}", name)
				}
				if strings.Contains(envReference.ReplaceAllString(value, ""), "$") {
					return fmt.Errorf("MCP %s: use ${ENV_NAME} interpolation", name)
				}
			}
		}
	}
	return nil
}
func (x *Executor) selectedMCP(names []string) (map[string]any, map[string]string, error) {
	selected := map[string]any{}
	env := map[string]string{}
	for _, name := range names {
		s, ok := x.MCP[name]
		if !ok {
			return nil, nil, fmt.Errorf("MCP server %q is not configured", name)
		}
		for _, values := range []map[string]string{s.Env, s.Headers} {
			for _, value := range values {
				for _, match := range envReference.FindAllStringSubmatch(value, -1) {
					key := match[1]
					v, ok := os.LookupEnv(key)
					if !ok || v == "" {
						return nil, nil, fmt.Errorf("MCP %s credential environment %s is not set", name, key)
					}
					env[key] = v
				}
			}
		}
		entry := map[string]any{"exposure": "direct", "timeout": 60}
		if s.Command != "" {
			entry["command"], entry["args"], entry["env"] = s.Command, s.Args, s.Env
		} else {
			entry["url"], entry["headers"] = s.URL, s.Headers
		}
		selected[name] = entry
	}
	return selected, env, nil
}
func readRepositoryFile(workspace, path string, limit int64) ([]byte, error) {
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	f, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s exceeds %d bytes", path, limit)
	}
	return b, nil
}
func repositoryInstructions(workspace string) (string, error) {
	b, err := readRepositoryFile(workspace, "AGENTS.md", 64<<10)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return "Repository AGENTS.md (applies to this workspace):\n\n" + string(b), nil
}
func skillPath(workspace, name string) (string, error) {
	if !namePattern.MatchString(name) {
		return "", errors.New("invalid skill name")
	}
	relative := filepath.Join(".agents", "skills", name, "SKILL.md")
	b, err := readRepositoryFile(workspace, relative, 256<<10)
	if err != nil {
		return "", fmt.Errorf("skill %s: %w", name, err)
	}
	parts := strings.SplitN(strings.ReplaceAll(string(b), "\r\n", "\n"), "---\n", 3)
	if len(parts) != 3 || parts[0] != "" {
		return "", fmt.Errorf("skill %s requires YAML frontmatter", name)
	}
	var metadata struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(parts[1]), &metadata); err != nil {
		return "", err
	}
	if metadata.Name != name || strings.TrimSpace(metadata.Description) == "" {
		return "", fmt.Errorf("skill %s requires matching name and nonempty description", name)
	}
	return filepath.Join(workspace, relative), nil
}
