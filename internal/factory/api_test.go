package factory

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testToken = "test-token-with-more-than-32-characters"

func request(t *testing.T, h http.Handler, method, path string, body any, headers map[string]string, status int) []byte {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+testToken)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: want %d, got %d: %s", method, path, status, w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}
func decode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAPIAuthenticationValidationAndLifecycle(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	request(t, h, "GET", "/v1/runs", nil, map[string]string{"Authorization": ""}, 401)
	request(t, h, "GET", "/healthz", nil, map[string]string{"Authorization": ""}, 200)
	request(t, h, "GET", "/openapi.json", nil, map[string]string{"Authorization": ""}, 401)
	request(t, h, "POST", "/v1/workflows", map[string]string{"yaml": "invalid"}, nil, 422)
	request(t, h, "GET", "/v1/runs?limit=0", nil, nil, 422)
	request(t, h, "GET", "/v1/runs?status=typo", nil, nil, 422)
	request(t, h, "GET", "/v1/runs/missing", nil, nil, 404)
	request(t, h, "POST", "/v1/runs", map[string]any{"workflow_id": "x", "typo": true}, nil, 422)
	w := basicWorkflow()
	w.Nodes["work"] = Node{Type: "human", Prompt: "Approve?", Choices: []string{"yes", "no"}, Next: map[string]string{"yes": "end", "no": "end"}}
	request(t, h, "POST", "/v1/workflows", map[string]string{"yaml": workflowYAML(t, w)}, nil, 200)
	run := decode[Run](t, request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name}, map[string]string{"Idempotency-Key": "api-one"}, 200))
	same := decode[Run](t, request(t, h, "POST", "/v1/runs", SubmitRequest{WorkflowID: w.Name}, map[string]string{"Idempotency-Key": "api-one"}, 200))
	if same.ID != run.ID {
		t.Fatal("API idempotency failed")
	}
	run = waitRun(t, e, run.ID, settled)
	questions := decode[[]RunSummary](t, request(t, h, "GET", "/v1/questions", nil, nil, 200))
	if len(questions) != 1 || questions[0].Question.ID != run.Question.ID {
		t.Fatal("missing question")
	}
	request(t, h, "POST", "/v1/runs/"+run.ID+"/decisions", Decision{QuestionID: run.Question.ID, Choice: "yes"}, nil, 200)
	request(t, h, "POST", "/v1/runs/"+run.ID+"/decisions", Decision{QuestionID: run.Question.ID, Choice: "yes"}, nil, 409)
	run = waitRun(t, e, run.ID, settled)
	if run.Status != "succeeded" {
		t.Fatal(run.Status)
	}
	request(t, h, "POST", "/v1/runs/"+run.ID+"/retry", map[string]bool{"acknowledge_side_effects": false}, nil, 422)
	request(t, h, "POST", "/v1/runs/"+run.ID+"/retry", map[string]bool{"acknowledge_side_effects": true}, nil, 409)
	events := decode[[]Event](t, request(t, h, "GET", "/v1/runs/"+run.ID+"/events", nil, nil, 200))
	if len(events) == 0 {
		t.Fatal("missing events")
	}
	request(t, h, "DELETE", "/v1/workflows/"+w.Name, nil, nil, 200)
	request(t, h, "GET", "/v1/runs/"+run.ID, nil, nil, 200)
}
func TestSSEReplayAndDisconnect(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	r := submitWorkflow(t, e, basicWorkflow())
	waitRun(t, e, r.ID, settled)
	events, err := e.store.Events(r.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewAPI(e, APIConfig{Token: testToken}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/v1/runs/"+r.ID+"/stream", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Last-Event-ID", json.Number("2").String())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal(response.Status)
	}
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			event := decode[Event](t, []byte(strings.TrimPrefix(scanner.Text(), "data: ")))
			if event.ID != events[2].ID {
				t.Fatalf("wrong cursor: %d", event.ID)
			}
			return
		}
	}
	t.Fatal("no SSE event received")
}
func TestGitHubWebhookSignaturesDedupAndRepositoryScope(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken, WebhookSecret: "secret"})
	w := basicWorkflow()
	_, err := e.Register(workflowYAML(t, w), "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.PutAutomation("issues", AutomationRequest{WorkflowID: w.Name, Event: "github.issues.opened", GitHubRepository: "owner/repo", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"action": "opened", "repository": map[string]string{"full_name": "owner/repo"}}
	signed := func(p any, id string) map[string]string {
		b, _ := json.Marshal(p)
		m := hmac.New(sha256.New, []byte("secret"))
		m.Write(b)
		return map[string]string{"Authorization": "", "X-Hub-Signature-256": "sha256=" + hex.EncodeToString(m.Sum(nil)), "X-GitHub-Delivery": id, "X-GitHub-Event": "issues"}
	}
	request(t, h, "POST", "/v1/webhooks/github", payload, nil, 401)
	headers := signed(payload, "delivery")
	a := decode[TriggerResult](t, request(t, h, "POST", "/v1/webhooks/github", payload, headers, 200))
	b := decode[TriggerResult](t, request(t, h, "POST", "/v1/webhooks/github", payload, headers, 200))
	if len(a.RunIDs) != 1 || a.RunIDs[0] != b.RunIDs[0] {
		t.Fatal("webhook replay created duplicate")
	}
	payload["action"] = "closed"
	request(t, h, "POST", "/v1/webhooks/github", payload, signed(payload, "delivery"), 409)
	payload["action"] = "opened"
	payload["repository"] = map[string]string{"full_name": "other/repo"}
	c := decode[TriggerResult](t, request(t, h, "POST", "/v1/webhooks/github", payload, signed(payload, "other"), 200))
	if len(c.RunIDs) != 0 {
		t.Fatal("cross-repository event matched")
	}
}
func TestOpenAPICoversPublicRoutes(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	doc := decode[map[string]any](t, request(t, h, "GET", "/openapi.json", nil, nil, 200))
	paths := doc["paths"].(map[string]any)
	for _, path := range []string{"/v1/workflows", "/v1/runs", "/v1/runs/{id}/decisions", "/v1/runs/{id}/stream", "/v1/webhooks/github", "/v1/automations/{id}/fire"} {
		if paths[path] == nil {
			t.Fatalf("missing OpenAPI path %s", path)
		}
	}
	request(t, h, "GET", "/docs", nil, nil, 200)
}
func TestBodyLimit(t *testing.T) {
	t.Parallel()
	e := testEngine(t, nil)
	h := NewAPI(e, APIConfig{Token: testToken})
	r := httptest.NewRequest("POST", "/v1/workflows", strings.NewReader(`{"yaml":"`+strings.Repeat("x", 2<<20)+`"}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, r)
	if recorder.Code != 413 {
		b, _ := io.ReadAll(recorder.Body)
		t.Fatalf("expected 413 got %d %s", recorder.Code, b)
	}
}
