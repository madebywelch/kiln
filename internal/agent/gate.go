package agent

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

type verdict string

const (
	allow verdict = "allow"
	deny  verdict = "deny"
	ask   verdict = "ask"
)

type decision struct {
	verdict verdict
	reason  string
}

// Origins maps an allowed origin (scheme://host[:port]) to the headers the
// executor adds to requests for it. The values are credentials: they are read
// from disk by the process and never shown to the model.
type Origins map[string]map[string]string

// gate is the single function between a tool call and its execution. Anything
// it does not recognize is denied.
func gate(call ToolCall, origins Origins) decision {
	args := []byte(call.Function.Arguments)
	switch call.Function.Name {
	case toolReadFile, toolListFiles, toolSendMessage, toolReact, toolSetTimer, toolCancelTimer, toolOpenTask, toolUpdateTask:
		return decision{verdict: allow}

	case toolWriteFile:
		var in fileInput
		if err := json.Unmarshal(args, &in); err != nil {
			return decision{deny, "arguments are not valid JSON for write_file"}
		}
		// Case-folded: macOS volumes are case-insensitive by default.
		p := strings.ToLower(path.Clean(filepath.ToSlash(in.Path)))
		switch {
		case p == instructionsFile:
			return decision{ask, "it rewrites your standing instructions"}
		case p == transcriptsDir || strings.HasPrefix(p, transcriptsDir+"/"):
			return decision{deny, "transcripts are the record of past runs and are written only by the system"}
		}
		return decision{verdict: allow}

	case toolHTTPRequest:
		var in httpInput
		if err := json.Unmarshal(args, &in); err != nil {
			return decision{deny, "arguments are not valid JSON for http_request"}
		}
		origin, err := originOf(in.URL)
		if err != nil {
			return decision{deny, err.Error()}
		}
		if _, ok := origins[origin]; !ok {
			return decision{deny, fmt.Sprintf("%s is not an allowed origin; allowed: %s", origin, strings.Join(origins.names(), ", "))}
		}
		switch strings.ToUpper(in.Method) {
		case "GET", "HEAD":
			return decision{verdict: allow}
		case "POST", "PUT", "PATCH", "DELETE":
			return decision{ask, "it changes state on " + origin}
		}
		return decision{deny, fmt.Sprintf("method %q is not supported", in.Method)}
	}
	return decision{deny, fmt.Sprintf("unknown tool %q", call.Function.Name)}
}

func originOf(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("url does not parse: %v", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("url must be absolute http or https")
	}
	if u.User != nil {
		return "", fmt.Errorf("url must not carry credentials")
	}
	return strings.ToLower(u.Scheme + "://" + u.Host), nil
}

// NormalizeOrigin validates a configured origin and returns its canonical form.
func NormalizeOrigin(s string) (string, error) {
	origin, err := originOf(s)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(strings.TrimSuffix(s, "/"), origin) {
		return "", fmt.Errorf("an origin is scheme://host[:port] with no path or query")
	}
	return origin, nil
}

func (o Origins) names() []string {
	names := make([]string, 0, len(o))
	for name := range o {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
