package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// reply is one scripted answer from the fake model endpoint.
type reply struct {
	status int // 0 means 200
	msg    ChatMessage
	finish string
}

func say(text string) reply {
	return reply{msg: ChatMessage{Content: text}, finish: "stop"}
}

type tc struct {
	id, name string
	args     any
}

// call scripts an assistant message that requests the given tool calls.
func call(t *testing.T, calls ...tc) reply {
	t.Helper()
	msg := ChatMessage{}
	for _, c := range calls {
		args, err := json.Marshal(c.args)
		if err != nil {
			t.Fatal(err)
		}
		msg.ToolCalls = append(msg.ToolCalls, ToolCall{ID: c.id, Type: "function", Function: FunctionCall{Name: c.name, Arguments: string(args)}})
	}
	return reply{msg: msg, finish: "tool_calls"}
}

type chatRequest struct {
	Model    string            `json:"model"`
	Messages []ChatMessage     `json:"messages"`
	Tools    []json.RawMessage `json:"tools"`
	raw      string
	auth     string
}

// fakeModel is an OpenAI-compatible chat completions server with a script.
type fakeModel struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	script   []reply
	forever  *reply // served once the script runs out
	requests []chatRequest
}

func newFakeModel(t *testing.T) *fakeModel {
	f := &fakeModel{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		req := chatRequest{raw: string(raw), auth: r.Header.Get("Authorization")}
		if r.URL.Path != "/chat/completions" {
			t.Errorf("model called at %s", r.URL.Path)
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Errorf("model request is not JSON: %v", err)
		}
		f.mu.Lock()
		f.requests = append(f.requests, req)
		var next reply
		switch {
		case len(f.script) > 0:
			next, f.script = f.script[0], f.script[1:]
		case f.forever != nil:
			next = *f.forever
		default:
			f.mu.Unlock()
			t.Errorf("unexpected model call #%d", len(f.requests))
			http.Error(w, "script exhausted", http.StatusBadRequest)
			return
		}
		f.mu.Unlock()
		if next.status != 0 {
			http.Error(w, `{"error":{"message":"scripted failure"}}`, next.status)
			return
		}
		next.msg.Role = "assistant"
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": next.msg, "finish_reason": next.finish}},
			"usage":   map[string]int{"prompt_tokens": 10, "completion_tokens": 5},
		})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeModel) push(replies ...reply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.script = append(f.script, replies...)
}

func (f *fakeModel) reqs() []chatRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]chatRequest(nil), f.requests...)
}

// fakeAdapter is a channel that records what it is asked to send.
type fakeAdapter struct {
	name     string
	features Features
	routes   map[string]string // user -> address; nil routes everyone to the adapter's name
	mu       sync.Mutex
	sent     []Outbound
	fail     error // returned by Send while set
	n        int
}

// talkative is a fakeAdapter that can also show the conversation around a
// message: everything after "chat:" up to the next colon is the room.
type talkative struct {
	*fakeAdapter
	rooms map[string][]Said // room -> what was said there
	err   error
	asked [][]string
}

func (c *talkative) Context(_ context.Context, addresses []string) ([]Conversation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.asked = append(c.asked, addresses)
	if c.err != nil {
		return nil, c.err
	}
	var out []Conversation
	for _, address := range addresses {
		room := strings.Split(address, ":")[1]
		i := slices.IndexFunc(out, func(conv Conversation) bool { return conv.Where == "room "+room })
		if i < 0 {
			out = append(out, Conversation{Where: "room " + room, You: "Kiln (@kiln)", Messages: c.rooms[room]})
			i = len(out) - 1
		}
		out[i].Addresses = append(out[i].Addresses, address)
	}
	return out, nil
}

func (f *fakeAdapter) Name() string       { return f.name }
func (f *fakeAdapter) Features() Features { return f.features }

func (f *fakeAdapter) Route(user string) (string, bool) {
	if f.routes == nil {
		return f.name, true
	}
	address, ok := f.routes[user]
	return address, ok
}

func (f *fakeAdapter) Run(ctx context.Context, _ IngestFunc) error { return sendOnly(ctx) }

func (f *fakeAdapter) Send(_ context.Context, m Outbound) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return "", f.fail
	}
	f.sent = append(f.sent, m)
	f.n++
	if m.Kind != KindMessage {
		return "", nil
	}
	return fmt.Sprintf("%s:room:m%d", f.name, f.n), nil
}

func (f *fakeAdapter) setFail(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = err
}

// delivered returns what was sent, as "kind address body".
func (f *fakeAdapter) delivered() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.sent {
		out = append(out, m.Kind+" "+m.Address+" "+m.Body)
	}
	return out
}

func checkBlocks(value json.RawMessage) error {
	var blocks []map[string]any
	if err := json.Unmarshal(value, &blocks); err != nil || len(blocks) == 0 {
		return errors.New("must be a non-empty array")
	}
	return nil
}

type harness struct {
	*Agent
	t     *testing.T
	clock *fakeClock
	model *fakeModel
	dir   string
	// chat is a channel with threads, reactions and a "blocks" property that
	// knows ann. log reaches everyone and is last, as stdout is in production.
	chat, log *fakeAdapter
}

func newHarness(t *testing.T, origins Origins) *harness {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "kiln.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	h := &harness{t: t, clock: &fakeClock{t: t0}, model: newFakeModel(t), dir: dir}
	h.chat = &fakeAdapter{name: "chat", routes: map[string]string{"ann": "chat:dm-ann"}, features: Features{
		Reactions: true,
		MessageProperties: map[string]Property{"blocks": {
			Schema: map[string]any{"type": "array", "description": "rich layout"},
			Check:  checkBlocks,
		}},
	}}
	h.log = &fakeAdapter{name: "log"}
	model := &Model{BaseURL: h.model.srv.URL, APIKey: "model-key", Name: "test-model", HTTP: http.DefaultClient}
	h.Agent, err = New(store, model, dir, origins, []Adapter{h.chat, h.log}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	h.Agent.now = h.clock.Now
	return h
}

func (h *harness) event(user, source, payload string) int64 {
	h.t.Helper()
	return h.inbound(Inbound{User: user, Source: source, Text: payload})
}

func (h *harness) inbound(in Inbound) int64 {
	h.t.Helper()
	id, _, err := h.store.AddEvent(context.Background(), in, h.clock.Now())
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) tick() {
	h.t.Helper()
	if err := h.tickInbox(context.Background()); err != nil {
		h.t.Fatal(err)
	}
}

// deliver runs the dispatcher until the outbox is drained, stepping the clock
// past the pace between entries.
func (h *harness) deliver() {
	h.t.Helper()
	for i := 0; i < 20; i++ {
		if err := h.tickOutbox(context.Background()); err != nil {
			h.t.Fatal(err)
		}
		if len(h.strs(`SELECT id FROM outbox WHERE status = 'pending'`)) == 0 {
			return
		}
		h.clock.Advance(h.pace)
	}
	h.t.Fatal("outbox did not drain")
}

// strs runs a query and returns its first column as strings.
func (h *harness) strs(query string, args ...any) []string {
	h.t.Helper()
	return queryStrings(h.t, h.store, query, args...)
}

func queryStrings(t *testing.T, s *Store, query string, args ...any) []string {
	t.Helper()
	rows, err := s.db.Query(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(filepath.Join(t.TempDir(), "kiln.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func equal(t *testing.T, what string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %q, want %q", what, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s: got %q, want %q", what, got, want)
		}
	}
}
