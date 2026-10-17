package factory

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
)

type APIConfig struct {
	Token         string
	WebhookSecret string
}
type Response[T any] struct{ Body T }
type IDInput struct {
	ID string `path:"id"`
}
type PageInput struct {
	Limit  int `query:"limit" default:"50" minimum:"1" maximum:"100"`
	Offset int `query:"offset" default:"0" minimum:"0" maximum:"1000000"`
}
type RunPageInput struct {
	PageInput
	Status string `query:"status" enum:"queued,running,waiting,succeeded,failed,canceled,interrupted"`
}
type RunSummary struct {
	ID           string    `json:"id"`
	Workflow     string    `json:"workflow"`
	Revision     string    `json:"revision"`
	AutomationID string    `json:"automation_id,omitempty"`
	Status       string    `json:"status"`
	Current      string    `json:"current"`
	Steps        int       `json:"steps"`
	Error        string    `json:"error,omitempty"`
	Question     *Question `json:"question,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func summary(r Run) RunSummary {
	return RunSummary{r.ID, r.Workflow.Name, r.Revision, r.AutomationID, r.Status, r.Current, r.Steps, r.Error, r.Question, r.CreatedAt, r.UpdatedAt}
}
func reply[T any](v T, err error) (*Response[T], error) {
	if err != nil {
		return nil, apiError(err)
	}
	return &Response[T]{Body: v}, nil
}
func apiError(err error) error {
	var validation *validationError
	if errors.As(err, &validation) {
		return huma.Error422UnprocessableEntity(validation.Error())
	}
	if errors.Is(err, ErrNotFound) {
		return huma.Error404NotFound("resource not found")
	}
	if errors.Is(err, ErrConflict) {
		return huma.Error409Conflict(err.Error())
	}
	slog.Error("API operation failed", "error", err)
	return huma.Error500InternalServerError("internal operation failed; inspect daemon logs")
}
func register[I, O any](api huma.API, method, path, id, description string, h func(context.Context, *I) (*O, error)) {
	huma.Register(api, huma.Operation{
		OperationID: id, Method: method, Path: path, Summary: description,
		MaxBodyBytes: 1 << 20, Errors: []int{400, 401, 404, 409, 422, 500},
	}, h)
}

func NewAPI(e *Engine, cfg APIConfig) http.Handler {
	mux := http.NewServeMux()
	config := huma.DefaultConfig("KILN API", "0.1.0")
	config.Info.Description = "Durable, single-host software workflows. Workflow authors are trusted code operators. All /v1 endpoints require a bearer token."
	config.Components.SecuritySchemes = map[string]*huma.SecurityScheme{"bearer": {Type: "http", Scheme: "bearer"}}
	config.Security = []map[string][]string{{"bearer": {}}}
	api := humago.New(mux, config)

	register(api, "POST", "/v1/workflows/validate", "validate-workflow", "Validate YAML without saving it", func(ctx context.Context, in *struct {
		Body struct {
			YAML string `json:"yaml" minLength:"1"`
		}
	}) (*Response[Workflow], error) {
		w, err := ParseWorkflow([]byte(in.Body.YAML))
		if err != nil {
			return nil, huma.Error422UnprocessableEntity(err.Error())
		}
		return reply(w, nil)
	})
	register(api, "POST", "/v1/workflows", "register-workflow", "Create or update a named workflow", func(ctx context.Context, in *struct {
		Body struct {
			YAML             string `json:"yaml" minLength:"1"`
			ExpectedRevision string `json:"expected_revision,omitempty"`
		}
	}) (*Response[WorkflowRecord], error) {
		return reply(e.Register(in.Body.YAML, in.Body.ExpectedRevision))
	})
	register(api, "GET", "/v1/workflows", "list-workflows", "List workflow definitions", func(ctx context.Context, in *PageInput) (*Response[[]WorkflowRecord], error) {
		return reply(list[WorkflowRecord](e.store, "workflow", "", in.Limit, in.Offset))
	})
	register(api, "GET", "/v1/workflows/{id}", "get-workflow", "Read a workflow and its content revision", func(ctx context.Context, in *IDInput) (*Response[WorkflowRecord], error) {
		return reply(get[WorkflowRecord](e.store, "workflow", in.ID))
	})
	register(api, "DELETE", "/v1/workflows/{id}", "delete-workflow", "Delete a definition; pinned runs and automations are retained", func(ctx context.Context, in *IDInput) (*Response[map[string]bool], error) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if _, err := get[WorkflowRecord](e.store, "workflow", in.ID); err != nil {
			return reply[map[string]bool](nil, err)
		}
		return reply(map[string]bool{"deleted": true}, e.store.commit([]change{{"workflow", in.ID, nil}}, nil, nil))
	})
	register(api, "POST", "/v1/runs", "create-run", "Queue a run with a pinned workflow snapshot", func(ctx context.Context, in *struct {
		Key  string `header:"Idempotency-Key" maxLength:"200"`
		Body SubmitRequest
	}) (*Response[Run], error) {
		return reply(e.Submit(in.Body, in.Key))
	})
	register(api, "GET", "/v1/runs", "list-runs", "List run summaries, oldest first", func(ctx context.Context, in *RunPageInput) (*Response[[]RunSummary], error) {
		runs, err := list[Run](e.store, "run", in.Status, in.Limit, in.Offset)
		result := []RunSummary{}
		for _, r := range runs {
			result = append(result, summary(r))
		}
		return reply(result, err)
	})
	register(api, "GET", "/v1/runs/{id}", "get-run", "Read run state, outputs, attempts, and pinned workflow", func(ctx context.Context, in *IDInput) (*Response[Run], error) { return reply(e.GetRun(in.ID)) })
	register(api, "POST", "/v1/runs/{id}/cancel", "cancel-run", "Cancel execution and terminate its process group", func(ctx context.Context, in *IDInput) (*Response[Run], error) { return reply(e.Cancel(in.ID)) })
	register(api, "POST", "/v1/runs/{id}/retry", "retry-run", "Explicitly retry a failed or interrupted run; side effects may repeat", func(ctx context.Context, in *struct {
		IDInput
		Body struct {
			Acknowledge bool `json:"acknowledge_side_effects"`
		}
	}) (*Response[Run], error) {
		if !in.Body.Acknowledge {
			return nil, huma.Error422UnprocessableEntity("acknowledge_side_effects must be true")
		}
		return reply(e.Retry(in.ID))
	})
	register(api, "POST", "/v1/runs/{id}/decisions", "answer-question", "Answer a specific pending human gate; stale answers are rejected", func(ctx context.Context, in *struct {
		IDInput
		Body Decision
	}) (*Response[Run], error) {
		return reply(e.Decide(in.ID, in.Body))
	})
	register(api, "GET", "/v1/questions", "list-questions", "List runs awaiting human decisions", func(ctx context.Context, in *PageInput) (*Response[[]RunSummary], error) {
		runs, err := list[Run](e.store, "run", "waiting", in.Limit, in.Offset)
		result := []RunSummary{}
		for _, r := range runs {
			result = append(result, summary(r))
		}
		return reply(result, err)
	})
	register(api, "GET", "/v1/runs/{id}/events", "list-run-events", "Replay durable events after a cursor", func(ctx context.Context, in *struct {
		IDInput
		After int64 `query:"after" minimum:"0" default:"0"`
		Limit int   `query:"limit" default:"100" minimum:"1" maximum:"1000"`
	}) (*Response[[]Event], error) {
		if _, err := e.GetRun(in.ID); err != nil {
			return reply[[]Event](nil, err)
		}
		return reply(e.store.Events(in.ID, in.After, in.Limit))
	})
	register(api, "GET", "/v1/runs/{id}/diff", "get-run-diff", "Read the tracked-file diff against the pinned base (64 KiB limit)", func(ctx context.Context, in *IDInput) (*Response[DiffResult], error) {
		r, err := e.GetRun(in.ID)
		if err != nil {
			return reply(DiffResult{}, err)
		}
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return reply(e.exec.Diff(c, r))
	})
	register(api, "GET", "/v1/runs/{id}/candidate/diff", "get-candidate-diff", "Read only the selected, validated publication diff", func(ctx context.Context, in *IDInput) (*Response[DiffResult], error) {
		r, err := e.GetRun(in.ID)
		if err != nil {
			return reply(DiffResult{}, err)
		}
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return reply(e.exec.CandidateDiff(c, r))
	})
	register(api, "DELETE", "/v1/runs/{id}/workspace", "cleanup-workspace", "Remove an inactive terminal run's workspace; history and remote branch remain", func(ctx context.Context, in *IDInput) (*Response[Run], error) {
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return reply(e.Cleanup(c, in.ID))
	})
	register(api, "PUT", "/v1/automations/{id}", "put-automation", "Save a pinned workflow and cron or event trigger; overlap is skipped", func(ctx context.Context, in *struct {
		IDInput
		Body AutomationRequest
	}) (*Response[Automation], error) {
		return reply(e.PutAutomation(in.ID, in.Body))
	})
	register(api, "GET", "/v1/automations", "list-automations", "List scheduled and event automations", func(ctx context.Context, in *PageInput) (*Response[[]Automation], error) {
		return reply(list[Automation](e.store, "automation", "", in.Limit, in.Offset))
	})
	register(api, "GET", "/v1/automations/{id}", "get-automation", "Read an automation", func(ctx context.Context, in *IDInput) (*Response[Automation], error) {
		return reply(get[Automation](e.store, "automation", in.ID))
	})
	register(api, "DELETE", "/v1/automations/{id}", "delete-automation", "Delete a trigger without canceling its existing runs", func(ctx context.Context, in *IDInput) (*Response[map[string]bool], error) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if _, err := get[Automation](e.store, "automation", in.ID); err != nil {
			return reply[map[string]bool](nil, err)
		}
		return reply(map[string]bool{"deleted": true}, e.store.commit([]change{{"automation", in.ID, nil}}, nil, nil))
	})
	register(api, "POST", "/v1/automations/{id}/fire", "fire-automation", "Manually fire an enabled automation", func(ctx context.Context, in *struct {
		IDInput
		Key string `header:"Idempotency-Key" maxLength:"200"`
	}) (*Response[Run], error) {
		return reply(e.Fire(in.ID, in.Key))
	})
	register(api, "POST", "/v1/events", "trigger-event", "Trigger matching automations with caller-supplied inputs", func(ctx context.Context, in *struct {
		Key  string `header:"Idempotency-Key" maxLength:"200"`
		Body TriggerRequest
	}) (*Response[TriggerResult], error) {
		return reply(e.Trigger(in.Body, in.Key))
	})
	register(api, "GET", "/v1/status", "get-status", "Inspect worker capacity, storage health, and run counts", func(ctx context.Context, in *struct{}) (*Response[map[string]any], error) {
		e.mu.Lock()
		defer e.mu.Unlock()
		counts := map[string]int{}
		rows, err := e.store.db.Query("SELECT json_extract(data,'$.status'),count(*) FROM documents WHERE kind='run' GROUP BY json_extract(data,'$.status')")
		if err != nil {
			return reply[map[string]any](nil, err)
		}
		defer rows.Close()
		for rows.Next() {
			var status string
			var count int
			if err := rows.Scan(&status, &count); err != nil {
				return reply[map[string]any](nil, err)
			}
			counts[status] = count
		}
		return reply(map[string]any{"healthy": e.fault == nil && !e.closing, "workers": e.workers, "active": len(e.active), "runs": counts}, rows.Err())
	})

	// Streaming and signature-authenticated endpoints use raw HTTP bodies.
	mux.HandleFunc("GET /v1/runs/{id}/stream", e.stream)
	mux.HandleFunc("GET /v1/runs/{id}/attempts/{attempt}/transcript", e.transcript)
	mux.HandleFunc("GET /v1/runs/{id}/artifacts/{path...}", e.artifact)
	api.OpenAPI().AddOperation(&huma.Operation{OperationID: "get-run-artifact", Method: "GET", Path: "/v1/runs/{id}/artifacts/{path}", Summary: "Download an internal artifact, confined to this run's artifact directory",
		Parameters: []*huma.Param{{Name: "id", In: "path", Required: true, Schema: &huma.Schema{Type: "string"}}, {Name: "path", In: "path", Required: true, Schema: &huma.Schema{Type: "string"}}},
		Responses:  map[string]*huma.Response{"200": {Description: "Private artifact download", Content: map[string]*huma.MediaType{"application/octet-stream": {Schema: &huma.Schema{Type: "string", Format: "binary"}}}}, "404": {Description: "Artifact unavailable"}, "401": {Description: "Authentication required"}, "500": {Description: "Storage failure"}}})
	api.OpenAPI().AddOperation(&huma.Operation{OperationID: "get-agent-transcript", Method: "GET", Path: "/v1/runs/{id}/attempts/{attempt}/transcript", Summary: "Download raw agent JSONL, including partial interrupted attempts",
		Parameters: []*huma.Param{{Name: "id", In: "path", Required: true, Schema: &huma.Schema{Type: "string"}}, {Name: "attempt", In: "path", Required: true, Schema: &huma.Schema{Type: "string"}}},
		Responses:  map[string]*huma.Response{"200": {Description: "Agent JSONL; an active attempt may end in a partial record", Content: map[string]*huma.MediaType{"application/x-ndjson": {Schema: &huma.Schema{Type: "string"}}}}, "404": {Description: "Unknown run, attempt, or transcript"}, "401": {Description: "Authentication required"}, "500": {Description: "Storage failure"}}})
	mux.HandleFunc("POST /v1/webhooks/github", func(w http.ResponseWriter, r *http.Request) { e.githubWebhook(w, r, cfg.WebhookSecret) })
	api.OpenAPI().AddOperation(&huma.Operation{OperationID: "stream-run-events", Method: "GET", Path: "/v1/runs/{id}/stream", Summary: "SSE event replay and live tail; use Last-Event-ID or after",
		Parameters: []*huma.Param{{Name: "id", In: "path", Required: true, Schema: &huma.Schema{Type: "string"}}, {Name: "after", In: "query", Schema: &huma.Schema{Type: "integer"}}, {Name: "Last-Event-ID", In: "header", Schema: &huma.Schema{Type: "integer"}}},
		Responses:  map[string]*huma.Response{"200": {Description: "Durable events with id, event, and JSON data fields", Content: map[string]*huma.MediaType{"text/event-stream": {Schema: &huma.Schema{Type: "string"}}}}}})
	api.OpenAPI().AddOperation(&huma.Operation{OperationID: "github-webhook", Method: "POST", Path: "/v1/webhooks/github", Summary: "Receive HMAC-SHA256 signed GitHub events; delivery IDs are deduplicated",
		Security: []map[string][]string{}, Parameters: []*huma.Param{{Name: "X-Hub-Signature-256", In: "header", Required: true, Schema: &huma.Schema{Type: "string"}}, {Name: "X-GitHub-Delivery", In: "header", Required: true, Schema: &huma.Schema{Type: "string"}}, {Name: "X-GitHub-Event", In: "header", Required: true, Schema: &huma.Schema{Type: "string"}}},
		RequestBody: &huma.RequestBody{Required: true, Content: map[string]*huma.MediaType{"application/json": {Schema: &huma.Schema{Type: "object", AdditionalProperties: true}}}},
		Responses:   map[string]*huma.Response{"200": {Description: "Matching run IDs and skipped automation IDs"}, "401": {Description: "Invalid signature"}, "409": {Description: "Delivery ID reused with a different payload"}}})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if r.URL.Path != "/healthz" && r.URL.Path != "/v1/webhooks/github" && cfg.Token != "" {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(token), []byte(cfg.Token)) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				writeJSON(w, 401, map[string]string{"error": "valid bearer token required"})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (e *Engine) stream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := e.GetRun(id); err != nil {
		writeJSON(w, 404, map[string]string{"error": "run not found"})
		return
	}
	cursor := r.URL.Query().Get("after")
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		cursor = v
	}
	var after int64
	if cursor != "" {
		v, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || v < 0 {
			writeJSON(w, 400, map[string]string{"error": "invalid event cursor"})
			return
		}
		after = v
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		events, err := e.store.Events(id, after, 100)
		if err != nil {
			slog.Error("event stream read failed", "run", id, "error", err)
			return
		}
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		for _, event := range events {
			b, _ := json.Marshal(event)
			if _, err = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, b); err != nil {
				return
			}
			after = event.ID
		}
		if len(events) == 0 {
			if _, err = io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
		}
		if err := rc.Flush(); err != nil {
			return
		}
		if len(events) == 100 {
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-e.stop:
			return
		case <-tick.C:
		}
	}
}
func (e *Engine) githubWebhook(w http.ResponseWriter, r *http.Request, secret string) {
	if secret == "" {
		writeJSON(w, 503, map[string]string{"error": "GitHub webhooks are not configured"})
		return
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, 413, map[string]string{"error": "body exceeds limit"})
		return
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(data)
	sig := strings.TrimPrefix(r.Header.Get("X-Hub-Signature-256"), "sha256=")
	decoded, err := hex.DecodeString(sig)
	if err != nil || !strings.HasPrefix(r.Header.Get("X-Hub-Signature-256"), "sha256=") || !hmac.Equal(decoded, mac.Sum(nil)) {
		writeJSON(w, 401, map[string]string{"error": "invalid signature"})
		return
	}
	delivery, event := r.Header.Get("X-GitHub-Delivery"), r.Header.Get("X-GitHub-Event")
	if delivery == "" || len(delivery) > 200 || event == "" {
		writeJSON(w, 400, map[string]string{"error": "delivery and event headers are required"})
		return
	}
	var payload struct {
		Action     string `json:"action"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	name := "github." + event
	if payload.Action != "" {
		name += "." + payload.Action
	}
	result, err := e.Trigger(TriggerRequest{Name: name, Repository: payload.Repository.FullName, Inputs: map[string]string{"event": string(data), "delivery_id": delivery}}, "github:"+delivery)
	if err != nil {
		status := 500
		if errors.Is(err, ErrConflict) {
			status = 409
		}
		writeJSON(w, status, map[string]string{"error": "webhook could not be accepted"})
		return
	}
	writeJSON(w, 200, result)
}
