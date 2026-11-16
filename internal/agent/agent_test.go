package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// testToken is a placeholder of valid length, built so that no secret scanner
// mistakes it for a credential.
var testToken = strings.Repeat("t", 32)

func post(t *testing.T, h http.Handler, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestIngestRejectsBeforeWriting(t *testing.T) {
	h := newHarness(t, nil)
	handler := h.Handler(testToken)
	tests := []struct {
		name, path, token, body string
		want                    int
	}{
		{"no token", "/inbox/ann", "", "hi", http.StatusUnauthorized},
		{"wrong token", "/inbox/ann", "wrong", "hi", http.StatusUnauthorized},
		{"token prefix", "/inbox/ann", testToken[:16], "hi", http.StatusUnauthorized},
		{"bad user", "/inbox/Ann..", testToken, "hi", http.StatusBadRequest},
		{"bad source", "/inbox/ann?source=Git%20Hub", testToken, "hi", http.StatusBadRequest},
		{"reserved source", "/inbox/ann?source=timer", testToken, "hi", http.StatusBadRequest},
		{"empty body", "/inbox/ann", testToken, "  \n", http.StatusBadRequest},
		{"binary body", "/inbox/ann", testToken, "\xff\xfe", http.StatusBadRequest},
		{"oversized body", "/inbox/ann", testToken, strings.Repeat("x", maxPayloadBytes+1), http.StatusRequestEntityTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if rec := post(t, handler, tt.path, tt.token, tt.body); rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
	equal(t, "inbox stays empty", h.strs(`SELECT id FROM inbox`), nil)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/inbox/ann", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /inbox/ann = %d", rec.Code)
	}
}

func TestIngestIsOneInsertAndNeverCallsTheModel(t *testing.T) {
	h := newHarness(t, nil)
	handler := h.Handler(testToken)

	rec := post(t, handler, "/inbox/ann", testToken, "hello")
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var ack struct{ ID int64 }
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil || ack.ID != 1 {
		t.Fatalf("ack = %s", rec.Body)
	}
	if rec := post(t, handler, "/inbox/ann?source=github", testToken, `{"action":"opened"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	equal(t, "inbox", h.strs(`SELECT user_id || ' ' || source || ' ' || status || ' ' || payload FROM inbox ORDER BY id`),
		[]string{"ann user pending hello", `ann github pending {"action":"opened"}`})
	if got := len(h.model.reqs()); got != 0 {
		t.Fatalf("ingestion called the model %d times", got)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("healthz = %d", health.Code)
	}
}

func TestDispatcherRecordsDeliveryAndRetriesFailures(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.setFail(errors.New("channel down"))
	h.store.db.Exec(`INSERT INTO outbox (user_id, body) VALUES ('ann', 'one'), ('ann', 'two')`)

	if err := h.tickOutbox(ctx); err != nil {
		t.Fatal(err)
	}
	equal(t, "after failure", h.strs(`SELECT status || ' ' || attempts FROM outbox ORDER BY id`), []string{"pending 1", "pending 0"})

	h.chat.setFail(nil)
	h.tickOutbox(ctx) // still backing off
	h.clock.Advance(30 * time.Second)
	h.tickOutbox(ctx) // delivers "one"
	h.tickOutbox(ctx) // "two" is inside the pace window
	equal(t, "paced", h.chat.delivered(), []string{"message chat:dm-ann one"})
	h.clock.Advance(h.pace)
	h.tickOutbox(ctx)
	equal(t, "in order, to the user's default route", h.chat.delivered(), []string{"message chat:dm-ann one", "message chat:dm-ann two"})
	equal(t, "statuses and delivered addresses", h.strs(`SELECT status || ' ' || remote_id FROM outbox ORDER BY id`),
		[]string{"sent chat:room:m1", "sent chat:room:m2"})
}

func TestDispatcherRoutesByAddress(t *testing.T) {
	h := newHarness(t, nil)
	for _, row := range [][2]string{
		{"ann", ""},                // default route: chat knows ann
		{"bob", ""},                // default route: chat does not know bob, log takes everyone
		{"ann", "log:somewhere"},   // explicit address wins over the default
		{"ann", "chat:room:m7:t1"}, // an address may name a message in a thread
		{"ann", "pager:x"},         // an adapter that is not configured
	} {
		if _, err := h.store.db.Exec(`INSERT INTO outbox (user_id, address, body) VALUES (?, ?, 'hi')`, row[0], row[1]); err != nil {
			t.Fatal(err)
		}
	}
	h.pace = 0
	for i := 0; i < 5; i++ {
		if err := h.tickOutbox(ctx); err != nil {
			t.Fatal(err)
		}
	}
	equal(t, "chat", h.chat.delivered(), []string{"message chat:dm-ann hi", "message chat:room:m7:t1 hi"})
	equal(t, "log", h.log.delivered(), []string{"message log hi", "message log:somewhere hi"})
	equal(t, "an unroutable entry fails at once instead of blocking the queue",
		h.strs(`SELECT status || ' ' || attempts FROM outbox WHERE address = 'pager:x'`), []string{"failed 1"})
}

func TestPermanentDeliveryFailureIsNotRetried(t *testing.T) {
	h := newHarness(t, nil)
	h.pace = 0
	h.store.db.Exec(`INSERT INTO outbox (user_id, body) VALUES ('ann', 'refused'), ('ann', 'next')`)
	h.chat.setFail(fmt.Errorf("%w: channel_not_found", ErrPermanent))
	h.tickOutbox(ctx)
	h.chat.setFail(nil)
	h.tickOutbox(ctx)
	equal(t, "statuses", h.strs(`SELECT status FROM outbox ORDER BY id`), []string{"failed", "sent"})
	equal(t, "the queue moved on", h.chat.delivered(), []string{"message chat:dm-ann next"})
}

func TestNewRejectsConflictingAdapters(t *testing.T) {
	prop := Features{MessageProperties: map[string]Property{"blocks": {}}}
	cases := map[string][]Adapter{
		"duplicate name":          {&fakeAdapter{name: "chat"}, &fakeAdapter{name: "chat"}},
		"invalid name":            {&fakeAdapter{name: "Has Space"}},
		"property defined twice":  {&fakeAdapter{name: "a", features: prop}, &fakeAdapter{name: "b", features: prop}},
		"core property redefined": {&fakeAdapter{name: "a", features: Features{MessageProperties: map[string]Property{"body": {}}}}},
	}
	for name, adapters := range cases {
		if _, err := New(nil, nil, "", nil, adapters, nil); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestIngestValidatesAndDeduplicates(t *testing.T) {
	h := newHarness(t, nil)
	for name, in := range map[string]Inbound{
		"bad user":       {User: "../x", Source: SourceUser, Text: "hi"},
		"bad source":     {User: "ann", Source: "Not Valid", Text: "hi"},
		"timer source":   {User: "ann", Source: SourceTimer, Text: "hi"},
		"empty text":     {User: "ann", Source: SourceUser, Text: "  "},
		"unknown origin": {User: "ann", Source: SourceUser, Text: "hi", Origin: "pager:x"},
	} {
		if err := h.Ingest(ctx, in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	equal(t, "nothing recorded", h.strs(`SELECT id FROM inbox`), nil)

	in := Inbound{User: "ann", Source: SourceUser, Text: "hi", Origin: "chat:room:m1", Dedupe: "chat:evt-1"}
	for i := 0; i < 3; i++ {
		if err := h.Ingest(ctx, in); err != nil {
			t.Fatalf("delivery %d: %v", i, err)
		}
	}
	in.Dedupe = ""
	h.Ingest(ctx, in)
	h.Ingest(ctx, in)
	equal(t, "a redelivery is dropped; events without a key never collide",
		h.strs(`SELECT COALESCE(dedupe, '-') || ' ' || origin FROM inbox ORDER BY id`),
		[]string{"chat:evt-1 chat:room:m1", "- chat:room:m1", "- chat:room:m1"})
}

// flaky is an adapter whose Run keeps ending, as a dropped connection does.
type flaky struct {
	fakeAdapter
	runs chan IngestFunc
}

func (f *flaky) Run(ctx context.Context, ingest IngestFunc) error {
	select {
	case f.runs <- ingest:
	case <-ctx.Done():
		return nil
	}
	return errors.New("connection lost")
}

func TestAdapterIsRestartedAndItsEventsReachTheInbox(t *testing.T) {
	h := newHarness(t, nil)
	ad := &flaky{fakeAdapter: fakeAdapter{name: "chat"}, runs: make(chan IngestFunc)}
	runCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.listen(runCtx, ad); close(done) }()

	for i := 0; i < 2; i++ {
		select {
		case ingest := <-ad.runs:
			if err := ingest(ctx, Inbound{User: "ann", Source: SourceUser, Text: fmt.Sprintf("run %d", i)}); err != nil {
				t.Fatal(err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("adapter was not started for run %d", i)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("listen did not stop with its context")
	}
	equal(t, "inbox", h.strs(`SELECT payload FROM inbox ORDER BY id`), []string{"run 0", "run 1"})
}

func TestBuiltInAdapters(t *testing.T) {
	var got Outbound
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
	}))
	defer srv.Close()
	hook := NewWebhook(srv.URL)
	m := Outbound{ID: 7, UserID: "ann", Kind: KindMessage, Address: "webhook", Body: "hi", Options: Options{StartThread: true}}
	if _, err := hook.Send(ctx, m); err != nil {
		t.Fatal(err)
	}
	if got.ID != 7 || got.UserID != "ann" || got.Body != "hi" || !got.Options.StartThread {
		t.Fatalf("webhook received %+v", got)
	}
	status = http.StatusBadGateway
	if _, err := hook.Send(ctx, Outbound{ID: 8}); err == nil || errors.Is(err, ErrPermanent) {
		t.Fatalf("a 502 from the channel must be a retryable failure, got %v", err)
	}

	var buf bytes.Buffer
	w := NewWriter(&buf)
	if _, err := w.Send(ctx, Outbound{ID: 9, UserID: "ann", Kind: KindMessage, Body: "line"}); err != nil {
		t.Fatal(err)
	}
	if buf.String() != `{"id":9,"user_id":"ann","kind":"message","body":"line"}`+"\n" {
		t.Fatalf("writer wrote %q", buf.String())
	}
	for _, ad := range []Adapter{hook, w} {
		if address, ok := ad.Route("anyone"); !ok || address != ad.Name() {
			t.Errorf("%s must route every user to itself, got %q %v", ad.Name(), address, ok)
		}
	}
}

func TestModelClient(t *testing.T) {
	t.Run("tool-only assistant message round-trips with null content", func(t *testing.T) {
		msg := ChatMessage{Role: "assistant", ToolCalls: []ToolCall{{ID: "c1", Type: "function", Function: FunctionCall{Name: "x", Arguments: "{}"}}}}
		raw, err := json.Marshal([]ChatMessage{msg, {Role: "assistant", Content: ""}, {Role: "tool", ToolCallID: "c1", Content: ""}})
		if err != nil {
			t.Fatal(err)
		}
		want := `[{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"x","arguments":"{}"}}],"content":null},{"role":"assistant","content":""},{"role":"tool","content":"","tool_call_id":"c1"}]`
		if string(raw) != want {
			t.Fatalf("got  %s\nwant %s", raw, want)
		}
		var back []ChatMessage
		if err := json.Unmarshal(raw, &back); err != nil || back[0].Content != "" || back[0].ToolCalls[0].ID != "c1" {
			t.Fatalf("round trip: %+v %v", back, err)
		}
	})

	t.Run("permanent error fails at once with the provider's message", func(t *testing.T) {
		f := newFakeModel(t)
		f.push(reply{status: http.StatusUnauthorized})
		m := &Model{BaseURL: f.srv.URL + "/", Name: "m", HTTP: http.DefaultClient}
		_, err := m.Complete(ctx, []ChatMessage{{Role: "user", Content: "hi"}}, nil)
		if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "scripted failure") {
			t.Fatalf("err = %v", err)
		}
		if len(f.reqs()) != 1 {
			t.Fatalf("a 401 was retried: %d calls", len(f.reqs()))
		}
		if f.reqs()[0].auth != "" {
			t.Fatal("an empty key must send no Authorization header")
		}
	})

	t.Run("transient error is retried", func(t *testing.T) {
		f := newFakeModel(t)
		f.push(reply{status: http.StatusServiceUnavailable}, say("recovered"))
		m := &Model{BaseURL: f.srv.URL, Name: "m", HTTP: http.DefaultClient}
		c, err := m.Complete(ctx, []ChatMessage{{Role: "user", Content: "hi"}}, nil)
		if err != nil || c.Message.Content != "recovered" || c.InputTokens != 10 || c.OutputTokens != 5 {
			t.Fatalf("completion = %+v, err = %v", c, err)
		}
	})

	t.Run("extra params are sent but cannot replace the core fields", func(t *testing.T) {
		f := newFakeModel(t)
		f.push(say("ok"))
		m := &Model{BaseURL: f.srv.URL, Name: "real-model", HTTP: http.DefaultClient, Params: map[string]json.RawMessage{
			"reasoning_effort": json.RawMessage(`"low"`),
			"model":            json.RawMessage(`"other-model"`),
		}}
		if _, err := m.Complete(ctx, []ChatMessage{{Role: "user", Content: "hi"}}, nil); err != nil {
			t.Fatal(err)
		}
		req := f.reqs()[0]
		if req.Model != "real-model" || !strings.Contains(req.raw, `"reasoning_effort":"low"`) {
			t.Fatalf("request = %s", req.raw)
		}
	})

	t.Run("a 200 without choices is an error", func(t *testing.T) {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			io.WriteString(w, `{"error":{"message":"model overloaded"}}`)
		}))
		defer srv.Close()
		m := &Model{BaseURL: srv.URL, Name: "m", HTTP: http.DefaultClient}
		if _, err := m.Complete(ctx, nil, nil); err == nil || !strings.Contains(err.Error(), "model overloaded") {
			t.Fatalf("err = %v", err)
		}
		if calls != 3 {
			t.Fatalf("calls = %d, want the first try and two retries", calls)
		}
	})
}

func TestToolSpecsAreStableAndWellFormed(t *testing.T) {
	origins := Origins{"https://b.example": nil, "https://a.example": {"X-Key": "secret-value"}}
	props := map[string]Property{"blocks": {Schema: map[string]any{"type": "array", "description": "rich layout"}}}
	first, second := toolSpecs(origins, props, true), toolSpecs(origins, props, true)
	if len(first) != 10 {
		t.Fatalf("tools = %d, want 10 with origins and reactions", len(first))
	}
	if plain := toolSpecs(nil, nil, false); len(plain) != 8 {
		t.Fatalf("tools = %d, want 8 with no origins and no reactions", len(plain))
	}
	for i := range first {
		if !bytes.Equal(first[i], second[i]) {
			t.Fatalf("tool %d is not byte-stable across calls", i)
		}
		var spec struct {
			Type     string
			Function struct {
				Name        string
				Description string
				Parameters  struct {
					Type       string
					Properties map[string]any
					Required   []string
				}
			}
		}
		if err := json.Unmarshal(first[i], &spec); err != nil {
			t.Fatal(err)
		}
		if spec.Type != "function" || spec.Function.Name == "" || spec.Function.Description == "" || spec.Function.Parameters.Type != "object" {
			t.Fatalf("malformed tool: %s", first[i])
		}
		for _, name := range spec.Function.Parameters.Required {
			if _, ok := spec.Function.Parameters.Properties[name]; !ok {
				t.Fatalf("%s requires undeclared property %q", spec.Function.Name, name)
			}
		}
	}
	var joined bytes.Buffer
	for _, spec := range first {
		joined.Write(spec)
	}
	all := joined.String()
	if strings.Contains(all, "secret-value") {
		t.Fatal("tool list leaks a credential")
	}
	if !strings.Contains(all, "https://a.example, https://b.example") {
		t.Fatal("http_request should name the allowed origins, sorted")
	}
	for _, want := range []string{`"reply_to"`, `"start_thread"`, `"blocks":{"description":"rich layout"`, `"name":"react"`} {
		if !strings.Contains(all, want) {
			t.Errorf("tool list lacks %s", want)
		}
	}
}

// TestEndToEnd runs the real loops: an event posted to the HTTP surface is
// picked up by the worker, handled in one run, and delivered by the dispatcher.
func TestEndToEnd(t *testing.T) {
	h := newHarness(t, nil)
	deliveries := make(chan Outbound, 4)
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m Outbound
		json.NewDecoder(r.Body).Decode(&m)
		deliveries <- m
	}))
	defer sink.Close()
	a, err := New(h.store, h.Agent.model, h.dir, nil, []Adapter{NewWebhook(sink.URL)}, h.Agent.log)
	if err != nil {
		t.Fatal(err)
	}
	a.pace = 0
	h.model.push(call(t, tc{"c1", toolSendMessage, messageInput{Body: "pong"}}), say("done"))

	runCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.Run(runCtx); close(done) }()
	defer func() { cancel(); <-done }()

	api := httptest.NewServer(a.Handler(testToken))
	defer api.Close()
	req, _ := http.NewRequest(http.MethodPost, api.URL+"/inbox/ann", strings.NewReader("ping"))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusAccepted {
		t.Fatalf("ingest: %v %v", resp, err)
	}
	resp.Body.Close()

	select {
	case m := <-deliveries:
		if m.UserID != "ann" || m.Body != "pong" || m.Kind != KindMessage || m.Address != "webhook" {
			t.Fatalf("delivered %+v", m)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no delivery within 10s")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := h.strs(`SELECT status FROM outbox`); len(got) == 1 && got[0] == "sent" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("outbox never marked sent: %v", h.strs(`SELECT status FROM outbox`))
}
