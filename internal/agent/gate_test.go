package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGate(t *testing.T) {
	origins := Origins{"https://api.example.com": {"Authorization": "Bearer secret"}}
	tests := []struct {
		name string
		tool string
		args any
		want verdict
	}{
		{"read", toolReadFile, fileInput{Path: "notes/a.md"}, allow},
		{"list", toolListFiles, fileInput{}, allow},
		{"message", toolSendMessage, messageInput{Body: "hi"}, allow},
		{"timer", toolSetTimer, timerInput{When: "1h", Note: "x"}, allow},
		{"cancel", toolCancelTimer, cancelInput{ID: 1}, allow},

		{"write note", toolWriteFile, fileInput{Path: "notes/a.md"}, allow},
		{"write index", toolWriteFile, fileInput{Path: "index.md"}, allow},
		{"write instructions", toolWriteFile, fileInput{Path: "instructions.md"}, ask},
		{"write instructions via dot segments", toolWriteFile, fileInput{Path: "notes/../instructions.md"}, ask},
		{"write instructions via ./", toolWriteFile, fileInput{Path: "./instructions.md"}, ask},
		{"write instructions in other case", toolWriteFile, fileInput{Path: "Instructions.MD"}, ask},
		{"write instructions via backslash", toolWriteFile, fileInput{Path: `notes\..\instructions.md`}, allow}, // a literal filename on unix, not a traversal
		{"write transcript", toolWriteFile, fileInput{Path: "transcripts/fake.md"}, deny},
		{"write transcript in other case", toolWriteFile, fileInput{Path: "Transcripts/fake.md"}, deny},
		{"replace transcripts dir", toolWriteFile, fileInput{Path: "transcripts"}, deny},

		{"get allowed origin", toolHTTPRequest, httpInput{Method: "GET", URL: "https://api.example.com/v1/items"}, allow},
		{"lowercase method", toolHTTPRequest, httpInput{Method: "get", URL: "https://API.example.com/x"}, allow},
		{"head", toolHTTPRequest, httpInput{Method: "HEAD", URL: "https://api.example.com/"}, allow},
		{"post", toolHTTPRequest, httpInput{Method: "POST", URL: "https://api.example.com/v1/items"}, ask},
		{"delete", toolHTTPRequest, httpInput{Method: "DELETE", URL: "https://api.example.com/v1/items/1"}, ask},
		{"unknown method", toolHTTPRequest, httpInput{Method: "CONNECT", URL: "https://api.example.com/"}, deny},
		{"other host", toolHTTPRequest, httpInput{Method: "GET", URL: "https://evil.example/"}, deny},
		{"other scheme", toolHTTPRequest, httpInput{Method: "GET", URL: "http://api.example.com/"}, deny},
		{"other port", toolHTTPRequest, httpInput{Method: "GET", URL: "https://api.example.com:8443/"}, deny},
		{"allowed host as userinfo", toolHTTPRequest, httpInput{Method: "GET", URL: "https://api.example.com@evil.example/"}, deny},
		{"allowed host as subdomain label", toolHTTPRequest, httpInput{Method: "GET", URL: "https://api.example.com.evil.example/"}, deny},
		{"file scheme", toolHTTPRequest, httpInput{Method: "GET", URL: "file:///etc/passwd"}, deny},
		{"relative url", toolHTTPRequest, httpInput{Method: "GET", URL: "/v1/items"}, deny},

		{"unknown tool", "shell", map[string]string{"cmd": "rm -rf /"}, deny},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args, err := json.Marshal(tt.args)
			if err != nil {
				t.Fatal(err)
			}
			d := gate(ToolCall{Function: FunctionCall{Name: tt.tool, Arguments: string(args)}}, origins)
			if d.verdict != tt.want {
				t.Fatalf("verdict = %s (%s), want %s", d.verdict, d.reason, tt.want)
			}
			if d.verdict != allow && d.reason == "" {
				t.Fatal("a non-allow verdict must carry a reason")
			}
		})
	}
}

func TestGateDeniesMalformedArguments(t *testing.T) {
	for _, tool := range []string{toolWriteFile, toolHTTPRequest} {
		d := gate(ToolCall{Function: FunctionCall{Name: tool, Arguments: `{"path": `}}, nil)
		if d.verdict != deny {
			t.Errorf("%s with truncated JSON: %s", tool, d.verdict)
		}
	}
}

func TestGateNeverLeaksCredentialsInReasons(t *testing.T) {
	origins := Origins{"https://api.example.com": {"Authorization": "Bearer secret-token-value"}}
	d := gate(ToolCall{Function: FunctionCall{Name: toolHTTPRequest, Arguments: `{"method":"GET","url":"https://evil.example/"}`}}, origins)
	if strings.Contains(d.reason, "secret-token-value") {
		t.Fatalf("reason leaks a credential: %s", d.reason)
	}
	if !strings.Contains(d.reason, "https://api.example.com") {
		t.Fatalf("reason should name the allowed origins: %s", d.reason)
	}
}

func TestNormalizeOrigin(t *testing.T) {
	good := map[string]string{
		"https://api.example.com":  "https://api.example.com",
		"HTTPS://API.Example.com/": "https://api.example.com",
		"http://127.0.0.1:8080":    "http://127.0.0.1:8080",
	}
	for in, want := range good {
		if got, err := NormalizeOrigin(in); err != nil || got != want {
			t.Errorf("NormalizeOrigin(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"api.example.com", "https://api.example.com/v1", "https://user@api.example.com", "ftp://api.example.com", "https://api.example.com?x=1"} {
		if got, err := NormalizeOrigin(in); err == nil {
			t.Errorf("NormalizeOrigin(%q) = %q, want error", in, got)
		}
	}
}
