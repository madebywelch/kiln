package slack

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/madebywelch/kiln/internal/agent"
)

// TestLiveModel is the acceptance run for the Slack adapter: a real model on
// one side, the fake Slack on the other, the real loops in between. It spends
// tokens, so it runs only when asked:
//
//	KILN_LIVE_MODEL=anthropic/claude-haiku-5.5 KILN_MODEL_KEY=... go test ./internal/slack -run TestLiveModel -v
//
// KILN_MODEL_URL and KILN_MODEL_PARAMS mean what they mean to kiln itself.
func TestLiveModel(t *testing.T) {
	name := os.Getenv("KILN_LIVE_MODEL")
	if name == "" {
		t.Skip("set KILN_LIVE_MODEL to run against a real model")
	}
	model := &agent.Model{
		BaseURL:   "https://openrouter.ai/api/v1",
		APIKey:    os.Getenv("KILN_MODEL_KEY"),
		Name:      name,
		HTTP:      &http.Client{Timeout: 5 * time.Minute},
		RetryWait: 2 * time.Second,
	}
	if url := os.Getenv("KILN_MODEL_URL"); url != "" {
		model.BaseURL = url
	}
	if raw := os.Getenv("KILN_MODEL_PARAMS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &model.Params); err != nil {
			t.Fatal(err)
		}
	}

	f := newFakeSlack(t)
	dir := t.TempDir()
	store, err := agent.OpenStore(filepath.Join(dir, "kiln.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	log := slog.New(slog.NewTextHandler(testWriter{t}, nil))
	a, err := agent.New(store, model, dir, nil, []agent.Adapter{f.adapter(), agent.NewWriter(io.Discard)}, log)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	var conn *websocket.Conn
	select {
	case conn = <-f.conns:
	case <-time.After(10 * time.Second):
		t.Fatal("the adapter did not connect")
	}
	defer conn.CloseNow()
	go func() { // drain acknowledgements
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()
	n := 0
	push := func(kind string, payload any) {
		t.Helper()
		n++
		frame := jsonOf(map[string]any{"type": kind, "envelope_id": "env-" + string(rune('a'+n)), "payload": payload})
		if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
			t.Fatal(err)
		}
	}
	dm := func(ts, text string) {
		t.Helper()
		push("events_api", map[string]any{"event_id": "Ev" + ts, "event": map[string]any{
			"type": "message", "channel_type": "im", "channel": "D1", "user": annID, "text": text, "ts": ts}})
	}
	await := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Minute)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s\nposts: %s\nreactions: %s", what, jsonOf(f.to("chat.postMessage")), jsonOf(f.to("reactions.add")))
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	posts := func() []map[string]any { return f.to("chat.postMessage") }

	// 1. A threaded reply and a reaction.
	dm("100.1", "Open a thread under this message and say pong in it. Also react to this message with the eyes emoji.")
	await("a threaded reply and a reaction", func() bool { return len(posts()) >= 1 && len(f.to("reactions.add")) >= 1 })
	if p := posts()[0]; p["channel"] != "D1" || p["thread_ts"] != "100.1" || !strings.Contains(strings.ToLower(p["text"].(string)), "pong") {
		t.Errorf("threaded reply = %s", jsonOf(p))
	}
	if r := f.to("reactions.add")[0]; r["timestamp"] != "100.1" || r["name"] != "eyes" {
		t.Errorf("reaction = %s", jsonOf(r))
	}

	// 2. Block Kit authored by the model.
	before := len(posts())
	dm("100.2", "Send me a Slack Block Kit message: a section saying Deploy 42 is ready, and a button labelled Ship it with the value ship_42.")
	await("a message with the model's blocks", func() bool {
		for _, p := range posts()[before:] {
			if raw := jsonOf(p["blocks"]); strings.Contains(raw, `"button"`) && strings.Contains(raw, "ship_42") {
				return true
			}
		}
		return false
	})

	// 3. An approval prompt with buttons, approved by a click.
	before = len(posts())
	dm("100.3", "Make it a standing instruction that you always sign messages with the word Kiln.")
	await("an approval prompt", func() bool {
		for _, p := range posts()[before:] {
			if strings.Contains(jsonOf(p["blocks"]), actionApprove) {
				return true
			}
		}
		return false
	})
	var prompt map[string]any
	for _, p := range posts()[before:] {
		if strings.Contains(jsonOf(p["blocks"]), actionApprove) {
			prompt = p
		}
	}
	var blocks []struct {
		BlockID  string `json:"block_id"`
		Elements []struct {
			ActionID string `json:"action_id"`
			Value    string `json:"value"`
		} `json:"elements"`
	}
	json.Unmarshal([]byte(jsonOf(prompt["blocks"])), &blocks)
	actions := blocks[len(blocks)-1]
	click := click(annID, actions.BlockID, actionApprove, actions.Elements[0].Value, nil)
	click["message"] = map[string]any{"ts": "100.9", "text": prompt["text"]}
	push("interactive", click)
	instructions := filepath.Join(dir, "users", "ann", "instructions.md")
	await("the approved edit", func() bool {
		data, _ := os.ReadFile(instructions)
		return strings.Contains(string(data), "Kiln")
	})
	await("the prompt to lose its buttons", func() bool { return len(f.to("chat.update")) == 1 })

	// 4. A shared channel: stay out of chatter, answer when named without a mention.
	inChannel := func() []map[string]any {
		var out []map[string]any
		for _, p := range posts() {
			if p["channel"] == "C9" {
				out = append(out, p)
			}
		}
		return out
	}
	overheard := func(ts, text string) {
		t.Helper()
		push("events_api", map[string]any{"event_id": "Ev" + ts, "event": map[string]any{
			"type": "message", "channel_type": "channel", "channel": "C9", "user": bobID, "text": text, "ts": ts}})
	}
	lunch := `{"user":"UBOB","text":"anyone want lunch at noon?","ts":"1794800100.000100"}`
	f.script("conversations.history", history(lunch))
	overheard("1794800100.000100", "anyone want lunch at noon?")
	time.Sleep(25 * time.Second) // long enough for a reply to appear, if one were coming
	if got := inChannel(); len(got) != 0 {
		t.Errorf("the agent joined a conversation that was not addressed to it: %s", jsonOf(got))
	}
	f.script("conversations.history", history(`{"user":"UBOB","text":"matthias, what is six times seven?","ts":"1794800200.000100"}`, lunch))
	overheard("1794800200.000100", "matthias, what is six times seven?")
	await("an answer to a question that names it", func() bool { return len(inChannel()) > 0 })
	if p := inChannel()[0]; !strings.Contains(p["text"].(string), "42") {
		t.Errorf("answer = %s", jsonOf(p))
	}
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}
