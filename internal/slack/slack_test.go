package slack

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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/madebywelch/kiln/internal/agent"
)

const (
	botUser = "UBOT"
	annID   = "UANN"
	bobID   = "UBOB"
)

type apiCall struct {
	method string
	token  string
	body   map[string]any
}

// fakeSlack is the Web API and a Socket Mode endpoint in one server.
type fakeSlack struct {
	t     *testing.T
	srv   *httptest.Server
	mu    sync.Mutex
	calls []apiCall
	// scripted answers per method, consumed in order; the default is success.
	scripted map[string][]func(w http.ResponseWriter)
	conns    chan *websocket.Conn
	posted   int
}

func newFakeSlack(t *testing.T) *fakeSlack {
	f := &fakeSlack{t: t, scripted: map[string][]func(http.ResponseWriter){}, conns: make(chan *websocket.Conn, 4)}
	mux := http.NewServeMux()
	mux.HandleFunc("/socket", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"hello","num_connections":1}`))
		f.conns <- conn
		<-r.Context().Done()
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		method := strings.TrimPrefix(r.URL.Path, "/api/")
		call := apiCall{method: method, token: strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), body: map[string]any{}}
		switch method {
		case "conversations.history", "conversations.replies", "users.info":
			// Slack ignores JSON bodies on these; arguments must be in the query.
			if r.Method != http.MethodGet {
				t.Errorf("%s: sent as %s, want GET with query arguments", method, r.Method)
			}
			for k, v := range r.URL.Query() {
				call.body[k] = v[0]
			}
		default:
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &call.body); err != nil {
				t.Errorf("%s: body is not JSON: %s", method, raw)
			}
			if ct := r.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
				t.Errorf("%s: Content-Type %q", method, ct)
			}
		}
		f.mu.Lock()
		f.calls = append(f.calls, call)
		var scripted func(http.ResponseWriter)
		if queue := f.scripted[method]; len(queue) > 0 {
			scripted, f.scripted[method] = queue[0], queue[1:]
		}
		f.posted++
		n := f.posted
		f.mu.Unlock()
		if scripted != nil {
			scripted(w)
			return
		}
		switch method {
		case "auth.test":
			fmt.Fprintf(w, `{"ok":true,"user_id":%q,"team":"Kiln Test"}`, botUser)
		case "apps.connections.open":
			fmt.Fprintf(w, `{"ok":true,"url":%q}`, "ws"+strings.TrimPrefix(f.srv.URL, "http")+"/socket")
		case "chat.postMessage":
			channel, _ := call.body["channel"].(string)
			if strings.HasPrefix(channel, "U") {
				channel = "D" + channel[1:] // Slack opens the DM and answers with its id
			}
			fmt.Fprintf(w, `{"ok":true,"channel":%q,"ts":"1700000000.%06d"}`, channel, n)
		case "users.info":
			member, _ := call.body["user"].(string)
			names := map[string]string{botUser: "Matthias", annID: "Ann", bobID: ""}
			fmt.Fprintf(w, `{"ok":true,"user":{"name":"handle-%s","real_name":"Real %s","profile":{"display_name":%q}}}`, member, member, names[member])
		case "conversations.history", "conversations.replies":
			io.WriteString(w, `{"ok":true,"messages":[]}`)
		default:
			io.WriteString(w, `{"ok":true}`)
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSlack) fail(method, code string) {
	f.script(method, func(w http.ResponseWriter) { fmt.Fprintf(w, `{"ok":false,"error":%q}`, code) })
}

func (f *fakeSlack) script(method string, answer func(http.ResponseWriter)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scripted[method] = append(f.scripted[method], answer)
}

// to returns the bodies of every call to one method.
func (f *fakeSlack) to(method string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, c := range f.calls {
		if c.method == method {
			out = append(out, c.body)
		}
	}
	return out
}

func (f *fakeSlack) adapter() *Adapter {
	return New(Config{
		BotToken: "xoxb-test", AppToken: "xapp-test", APIURL: f.srv.URL + "/api",
		Users: map[string]string{annID: "ann", bobID: "bob"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// session is a running adapter with the server side of its socket in hand.
type session struct {
	t      *testing.T
	slack  *fakeSlack
	conn   *websocket.Conn
	mu     sync.Mutex
	heard  []agent.Inbound
	reject error // returned by ingest while set
	done   chan error
	n      int
}

func connect(t *testing.T) *session {
	t.Helper()
	s := &session{t: t, slack: newFakeSlack(t), done: make(chan error, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	ad := s.slack.adapter()
	go func() { s.done <- ad.Run(ctx, s.ingest) }()
	select {
	case s.conn = <-s.slack.conns:
	case err := <-s.done:
		t.Fatalf("adapter stopped before connecting: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("adapter did not connect")
	}
	t.Cleanup(func() {
		cancel()
		s.conn.CloseNow()
	})
	return s
}

func (s *session) ingest(_ context.Context, in agent.Inbound) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reject != nil {
		return s.reject
	}
	s.heard = append(s.heard, in)
	return nil
}

func (s *session) inbound() []agent.Inbound {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]agent.Inbound(nil), s.heard...)
}

// push sends one envelope and returns its id.
func (s *session) push(kind string, payload any) string {
	s.t.Helper()
	s.n++
	id := fmt.Sprintf("env-%d", s.n)
	frame, err := json.Marshal(map[string]any{"type": kind, "envelope_id": id, "payload": payload, "accepts_response_payload": false})
	if err != nil {
		s.t.Fatal(err)
	}
	if err := s.conn.Write(context.Background(), websocket.MessageText, frame); err != nil {
		s.t.Fatal(err)
	}
	return id
}

// ack waits for the adapter's next frame and checks it acknowledges id.
func (s *session) ack(id string) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := s.conn.Read(ctx)
	if err != nil {
		s.t.Fatalf("no acknowledgement for %s: %v", id, err)
	}
	if string(data) != fmt.Sprintf(`{"envelope_id":%q}`, id) {
		s.t.Fatalf("acknowledgement = %s, want %s", data, id)
	}
}

func (s *session) event(event map[string]any) {
	s.t.Helper()
	s.ack(s.push("events_api", map[string]any{"event_id": fmt.Sprintf("Ev%d", s.n+1), "event": event}))
}

func TestInboundEvents(t *testing.T) {
	tests := []struct {
		name  string
		event map[string]any
		want  *agent.Inbound
	}{
		{"direct message",
			map[string]any{"type": "message", "channel_type": "im", "channel": "D1", "user": annID, "text": "hello there", "ts": "100.1"},
			&agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "hello there", Origin: "slack:D1:100.1", Dedupe: "slack:msg:D1:100.1"}},
		{"direct message in a thread",
			map[string]any{"type": "message", "channel_type": "im", "channel": "D1", "user": annID, "text": "more", "ts": "100.3", "thread_ts": "100.1"},
			&agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "more", Origin: "slack:D1:100.3:100.1", Dedupe: "slack:msg:D1:100.3"}},
		{"thread parent is not in a thread",
			map[string]any{"type": "message", "channel_type": "im", "channel": "D1", "user": annID, "text": "parent", "ts": "100.1", "thread_ts": "100.1"},
			&agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "parent", Origin: "slack:D1:100.1", Dedupe: "slack:msg:D1:100.1"}},
		{"mention in a channel, with Slack's escaping",
			map[string]any{"type": "app_mention", "channel": "C9", "user": bobID, "text": "<@" + botUser + "> is 1 &lt; 2 &amp;&amp; 3 &gt; 2?", "ts": "200.1"},
			&agent.Inbound{User: "bob", Source: "user", From: "<@UBOB>", Text: "is 1 < 2 && 3 > 2?", Origin: "slack:C9:200.1", Dedupe: "slack:msg:C9:200.1"}},
		{"mention inside a channel thread",
			map[string]any{"type": "app_mention", "channel": "C9", "user": annID, "text": "and this? <@" + botUser + ">", "ts": "200.5", "thread_ts": "200.1"},
			&agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "and this?", Origin: "slack:C9:200.5:200.1", Dedupe: "slack:msg:C9:200.5"}},
		{"file with a comment",
			map[string]any{"type": "message", "subtype": "file_share", "channel_type": "im", "channel": "D1", "user": annID, "text": "the report", "ts": "100.7",
				"files": []map[string]any{{"name": "q3.pdf"}}},
			&agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "the report\n[attached file: q3.pdf]", Origin: "slack:D1:100.7", Dedupe: "slack:msg:D1:100.7"}},
		{"reaction to the bot's message",
			map[string]any{"type": "reaction_added", "user": annID, "reaction": "thumbsup", "item_user": botUser,
				"item": map[string]any{"type": "message", "channel": "D1", "ts": "100.2"}},
			&agent.Inbound{User: "ann", Source: "reaction", From: "<@UANN>", Text: "The user reacted with :thumbsup: to your message.", Origin: "slack:D1:100.2", Dedupe: "slack:Ev1"}},

		{"channel message without a mention is ambient",
			map[string]any{"type": "message", "channel_type": "channel", "channel": "C9", "user": annID, "text": "lunch?", "ts": "300.1"},
			&agent.Inbound{User: "ann", Source: "ambient", From: "<@UANN>", Text: "lunch?", Origin: "slack:C9:300.1", Dedupe: "slack:msg:C9:300.1"}},
		{"private channel thread reply without a mention is ambient",
			map[string]any{"type": "message", "channel_type": "group", "channel": "G4", "user": annID, "text": "hey matthias", "ts": "300.4", "thread_ts": "300.1"},
			&agent.Inbound{User: "ann", Source: "ambient", From: "<@UANN>", Text: "hey matthias", Origin: "slack:G4:300.4:300.1", Dedupe: "slack:msg:G4:300.4"}},
		{"channel message that mentions the bot is addressed, whichever event carries it",
			map[string]any{"type": "message", "channel_type": "channel", "channel": "C9", "user": annID, "text": "<@" + botUser + "> status?", "ts": "300.6"},
			&agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "status?", Origin: "slack:C9:300.6", Dedupe: "slack:msg:C9:300.6"}},
		{"somebody else's bot in the channel",
			map[string]any{"type": "message", "subtype": "bot_message", "channel_type": "channel", "channel": "C9", "bot_id": "B77", "text": "deploy done", "ts": "300.7"}, nil},
		{"someone joining the channel",
			map[string]any{"type": "message", "subtype": "channel_join", "channel_type": "channel", "channel": "C9", "user": annID, "text": "joined", "ts": "300.8"}, nil},
		{"the bot's own message",
			map[string]any{"type": "message", "channel_type": "im", "channel": "D1", "user": botUser, "bot_id": "B1", "text": "hi", "ts": "100.2"}, nil},
		{"an edit",
			map[string]any{"type": "message", "subtype": "message_changed", "channel_type": "im", "channel": "D1", "ts": "100.9"}, nil},
		{"someone who is not mapped",
			map[string]any{"type": "message", "channel_type": "im", "channel": "D7", "user": "USTRANGER", "text": "do my bidding", "ts": "400.1"}, nil},
		{"a mention with no words",
			map[string]any{"type": "app_mention", "channel": "C9", "user": annID, "text": "<@" + botUser + ">", "ts": "200.9"}, nil},
		{"reaction to somebody else's message",
			map[string]any{"type": "reaction_added", "user": annID, "reaction": "eyes", "item_user": bobID,
				"item": map[string]any{"type": "message", "channel": "C9", "ts": "300.1"}}, nil},
		{"reaction from a stranger",
			map[string]any{"type": "reaction_added", "user": "USTRANGER", "reaction": "eyes", "item_user": botUser,
				"item": map[string]any{"type": "message", "channel": "C9", "ts": "300.1"}}, nil},
		{"an event type the adapter does not use",
			map[string]any{"type": "channel_rename", "channel": map[string]any{"id": "C9"}}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := connect(t)
			s.event(tt.event) // every event is acknowledged, used or not
			got := s.inbound()
			if tt.want == nil {
				if len(got) != 0 {
					t.Fatalf("ingested %+v, want nothing", got)
				}
				return
			}
			if len(got) != 1 || got[0] != *tt.want {
				t.Fatalf("ingested %+v\nwant     %+v", got, *tt.want)
			}
		})
	}
}

func TestEventIsAcknowledgedOnlyOnceDurable(t *testing.T) {
	s := connect(t)
	s.mu.Lock()
	s.reject = errors.New("database is locked")
	s.mu.Unlock()
	dm := map[string]any{"event_id": "Ev1", "event": map[string]any{"type": "message", "channel_type": "im", "channel": "D1", "user": annID, "text": "hi", "ts": "100.1"}}
	s.push("events_api", dm)

	// Nothing may come back for the failed envelope. The next frame the
	// adapter writes must be the acknowledgement of the redelivery.
	time.Sleep(100 * time.Millisecond)
	s.mu.Lock()
	s.reject = nil
	s.mu.Unlock()
	s.ack(s.push("events_api", dm))
	if got := s.inbound(); len(got) != 1 {
		t.Fatalf("ingested %d events, want the redelivery only", len(got))
	}
}

func TestReconnectSignals(t *testing.T) {
	t.Run("slack asks for a refresh", func(t *testing.T) {
		s := connect(t)
		s.conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"disconnect","reason":"refresh_requested"}`))
		select {
		case err := <-s.done:
			if err != nil {
				t.Fatalf("a requested refresh is not an error: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Run did not return")
		}
	})
	t.Run("slack hangs up without a word", func(t *testing.T) {
		s := connect(t)
		s.conn.CloseNow()
		select {
		case err := <-s.done:
			if err != nil {
				t.Fatalf("a hang-up is routine and just means reconnect: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Run did not return")
		}
	})
	t.Run("the connection goes silent", func(t *testing.T) {
		// A server that accepts the socket and then never reads cannot answer
		// pings. Two missed pongs in a row end the connection.
		f := newFakeSlack(t)
		ad := f.adapter()
		ad.keepalive = 60 * time.Millisecond
		done := make(chan error, 1)
		go func() { done <- ad.Run(context.Background(), nil) }()
		conn := <-f.conns
		defer conn.CloseNow()
		started := time.Now()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if took := time.Since(started); took < 100*time.Millisecond {
				t.Fatalf("gave up after %s: one missed pong must not end the connection", took)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("a silent connection was never closed")
		}
	})
	t.Run("bad credentials", func(t *testing.T) {
		f := newFakeSlack(t)
		f.fail("auth.test", "invalid_auth")
		err := f.adapter().Run(context.Background(), nil)
		if err == nil || !strings.Contains(err.Error(), "invalid_auth") || errors.Is(err, agent.ErrPermanent) {
			t.Fatalf("err = %v", err)
		}
	})
}

func click(user, blockID, actionID, value string, extra map[string]any) map[string]any {
	action := map[string]any{"action_id": actionID, "block_id": blockID, "value": value, "action_ts": "500.1", "type": "button",
		"text": map[string]any{"type": "plain_text", "text": "Label"}}
	for k, v := range extra {
		action[k] = v
	}
	return map[string]any{
		"type":      "block_actions",
		"user":      map[string]any{"id": user},
		"channel":   map[string]any{"id": "D1"},
		"container": map[string]any{"type": "message", "channel_id": "D1", "message_ts": "100.4"},
		"message":   map[string]any{"ts": "100.4", "text": "Approval needed: http_request {\"method\":\"POST\"}"},
		"actions":   []any{action},
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestApprovalButtons(t *testing.T) {
	t.Run("approve", func(t *testing.T) {
		s := connect(t)
		s.ack(s.push("interactive", click(annID, approvalBlock+"ann", actionApprove, "nonce-1", nil)))
		want := agent.Inbound{User: "ann", Source: "user", From: "<@UANN>", Text: "yes", Approval: "nonce-1", Origin: "slack:D1:100.4", Dedupe: "slack:action:D1:100.4:500.1"}
		if got := s.inbound(); len(got) != 1 || got[0] != want {
			t.Fatalf("ingested %+v\nwant     %+v", got, want)
		}
		// The prompt is rewritten without its buttons.
		waitFor(t, "chat.update", func() bool { return len(s.slack.to("chat.update")) == 1 })
		update := s.slack.to("chat.update")[0]
		raw, _ := json.Marshal(update["blocks"])
		if update["channel"] != "D1" || update["ts"] != "100.4" || strings.Contains(string(raw), `"actions"`) ||
			!strings.Contains(string(raw), ":white_check_mark: Approved by") || !strings.Contains(string(raw), annID) || !strings.Contains(string(raw), "Approval needed: http_request") {
			t.Fatalf("chat.update = %s", raw)
		}
	})
	t.Run("decline", func(t *testing.T) {
		s := connect(t)
		s.ack(s.push("interactive", click(annID, approvalBlock+"ann", actionDecline, "nonce-1", nil)))
		if got := s.inbound(); len(got) != 1 || got[0].Text != "no" || got[0].Approval != "nonce-1" {
			t.Fatalf("ingested %+v", got)
		}
		waitFor(t, "chat.update", func() bool { return len(s.slack.to("chat.update")) == 1 })
		if raw, _ := json.Marshal(s.slack.to("chat.update")[0]["blocks"]); !strings.Contains(string(raw), "Declined by") {
			t.Fatalf("chat.update = %s", raw)
		}
	})
	t.Run("someone else clicks the prompt", func(t *testing.T) {
		s := connect(t)
		s.ack(s.push("interactive", click(bobID, approvalBlock+"ann", actionApprove, "nonce-1", nil)))
		s.ack(s.push("interactive", click("USTRANGER", approvalBlock+"ann", actionApprove, "nonce-1", nil)))
		if got := s.inbound(); len(got) != 0 {
			t.Fatalf("another person's click was ingested: %+v", got)
		}
		if n := len(s.slack.to("chat.update")); n != 0 {
			t.Fatalf("the prompt was rewritten %d times", n)
		}
	})
}

func TestModelAuthoredBlocksComeBackAsEvents(t *testing.T) {
	s := connect(t)
	s.ack(s.push("interactive", click(annID, "b1", "snooze", "1h", map[string]any{"text": map[string]any{"type": "plain_text", "text": "Snooze 1h"}})))
	s.ack(s.push("interactive", click(annID, "b2", "priority", "", map[string]any{"type": "static_select",
		"selected_option": map[string]any{"value": "p1", "text": map[string]any{"type": "plain_text", "text": "High"}}})))
	got := s.inbound()
	if len(got) != 2 {
		t.Fatalf("ingested %+v", got)
	}
	if got[0].Text != `Clicked "Snooze 1h" (value: 1h)` || got[0].Approval != "" || got[0].Source != "user" || got[0].Origin != "slack:D1:100.4" {
		t.Fatalf("button click = %+v", got[0])
	}
	if got[1].Text != `Selected "High" (value: p1)` {
		t.Fatalf("select = %+v", got[1])
	}
	if n := len(s.slack.to("chat.update")); n != 0 {
		t.Fatalf("the model's own message was rewritten %d times", n)
	}
}

func jsonOf(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

func TestSendMessages(t *testing.T) {
	card := json.RawMessage(`[{"type":"section","text":{"type":"mrkdwn","text":"*Build 81*"}},{"type":"divider"}]`)
	tests := []struct {
		name       string
		m          agent.Outbound
		want       string // the chat.postMessage body
		wantRemote string
	}{
		{"default route opens the DM; Markdown renders through a markdown block",
			agent.Outbound{Kind: "message", Address: "slack:" + annID, Body: "**Done.** See `notes`."},
			`{"blocks":[{"text":"**Done.** See ` + "`notes`" + `.","type":"markdown"}],"channel":"UANN","text":"**Done.** See ` + "`notes`" + `.","unfurl_links":false}`,
			"slack:DANN:"},
		{"reply beside a top-level message",
			agent.Outbound{Kind: "message", Address: "slack:C9:200.1", Body: "ok"},
			`{"blocks":[{"text":"ok","type":"markdown"}],"channel":"C9","text":"ok","unfurl_links":false}`, "slack:C9:"},
		{"open a thread under a top-level message",
			agent.Outbound{Kind: "message", Address: "slack:C9:200.1", Body: "ok", Options: agent.Options{StartThread: true}},
			`{"blocks":[{"text":"ok","type":"markdown"}],"channel":"C9","text":"ok","thread_ts":"200.1","unfurl_links":false}`, "slack:C9:"},
		{"reply to a message in a thread stays in the thread",
			agent.Outbound{Kind: "message", Address: "slack:C9:200.5:200.1", Body: "ok"},
			`{"blocks":[{"text":"ok","type":"markdown"}],"channel":"C9","text":"ok","thread_ts":"200.1","unfurl_links":false}`, "slack:C9:"},
		{"start_thread on a threaded message does not nest",
			agent.Outbound{Kind: "message", Address: "slack:C9:200.5:200.1", Body: "ok", Options: agent.Options{StartThread: true}},
			`{"blocks":[{"text":"ok","type":"markdown"}],"channel":"C9","text":"ok","thread_ts":"200.1","unfurl_links":false}`, "slack:C9:"},
		{"the model's Block Kit blocks are sent as given, with body as the fallback",
			agent.Outbound{Kind: "message", Address: "slack:D1:100.1", Body: "Build 81 failed", Options: agent.Options{Props: map[string]json.RawMessage{"blocks": card}}},
			`{"blocks":[{"text":{"text":"*Build 81*","type":"mrkdwn"},"type":"section"},{"type":"divider"}],"channel":"D1","text":"Build 81 failed","unfurl_links":false}`, "slack:D1:"},
		{"a body too long for a markdown block goes as plain text",
			agent.Outbound{Kind: "message", Address: "slack:D1", Body: strings.Repeat("é", maxMarkdown+1)},
			`{"channel":"D1","text":"` + strings.Repeat("é", maxMarkdown+1) + `","unfurl_links":false}`, "slack:D1:"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeSlack(t)
			remote, err := f.adapter().Send(context.Background(), tt.m)
			if err != nil {
				t.Fatal(err)
			}
			posts := f.to("chat.postMessage")
			if len(posts) != 1 || jsonOf(posts[0]) != tt.want {
				t.Fatalf("chat.postMessage = %s\nwant               %s", jsonOf(posts), tt.want)
			}
			if !strings.HasPrefix(remote, tt.wantRemote) || strings.Count(remote, ":") != 2 {
				t.Fatalf("remote = %q, want %s<ts>", remote, tt.wantRemote)
			}
		})
	}
}

func TestSendApprovalPrompt(t *testing.T) {
	f := newFakeSlack(t)
	body := "Approval needed: write_file {\"path\":\"instructions.md\",\"content\":\"*not* _markdown_ " + strings.Repeat("x", maxSection) + "\"}\nWhy: it rewrites your standing instructions."
	_, err := f.adapter().Send(context.Background(), agent.Outbound{
		UserID: "ann", Kind: "message", Address: "slack:D1:100.1", Body: body, Options: agent.Options{Approval: "nonce-7"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var post struct {
		Text   string `json:"text"`
		Blocks []struct {
			Type    string `json:"type"`
			BlockID string `json:"block_id"`
			Text    struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"text"`
			Elements []struct {
				ActionID string `json:"action_id"`
				Value    string `json:"value"`
				Style    string `json:"style"`
			} `json:"elements"`
		} `json:"blocks"`
	}
	json.Unmarshal([]byte(jsonOf(f.to("chat.postMessage")[0])), &post)
	if post.Text != body || len(post.Blocks) != 3 {
		t.Fatalf("post = %+v", post)
	}
	// The call is shown verbatim, never as Markdown, split to fit a section.
	shown := ""
	for _, b := range post.Blocks[:2] {
		if b.Type != "section" || b.Text.Type != "plain_text" || len([]rune(b.Text.Text)) > maxSection {
			t.Fatalf("block = %+v", b)
		}
		shown += b.Text.Text
	}
	if shown != body {
		t.Fatal("the prompt does not show the call exactly as written")
	}
	actions := post.Blocks[2]
	if actions.Type != "actions" || actions.BlockID != approvalBlock+"ann" || len(actions.Elements) != 2 ||
		actions.Elements[0].ActionID != actionApprove || actions.Elements[0].Value != "nonce-7" || actions.Elements[0].Style != "primary" ||
		actions.Elements[1].ActionID != actionDecline || actions.Elements[1].Value != "nonce-7" || actions.Elements[1].Style != "danger" {
		t.Fatalf("buttons = %+v", actions)
	}
}

func TestSendReactions(t *testing.T) {
	f := newFakeSlack(t)
	ad := f.adapter()
	f.fail("reactions.add", "already_reacted") // answers the first call; not an error
	for _, emoji := range []string{"eyes", ":white_check_mark:", "👍", "Tada"} {
		if _, err := ad.Send(context.Background(), agent.Outbound{Kind: "reaction", Address: "slack:C9:200.5:200.1", Body: emoji}); err != nil {
			t.Fatalf("%s: %v", emoji, err)
		}
	}
	var names []string
	for _, call := range f.to("reactions.add") {
		if call["channel"] != "C9" || call["timestamp"] != "200.5" {
			t.Fatalf("reactions.add = %v", call)
		}
		names = append(names, call["name"].(string))
	}
	if got := strings.Join(names, ","); got != "eyes,white_check_mark,thumbsup,tada" {
		t.Fatalf("emoji names = %s", got)
	}
}

func TestSendFailures(t *testing.T) {
	msg := agent.Outbound{Kind: "message", Address: "slack:C9:200.1", Body: "hi"}
	t.Run("refused blocks fall back to text", func(t *testing.T) {
		f := newFakeSlack(t)
		f.fail("chat.postMessage", "invalid_blocks")
		m := msg
		m.Options.Props = map[string]json.RawMessage{"blocks": json.RawMessage(`[{"type":"nonsense"}]`)}
		remote, err := f.adapter().Send(context.Background(), m)
		if err != nil || remote == "" {
			t.Fatalf("remote=%q err=%v", remote, err)
		}
		posts := f.to("chat.postMessage")
		if len(posts) != 2 || posts[0]["blocks"] == nil || posts[1]["blocks"] != nil || posts[1]["text"] != "hi" {
			t.Fatalf("posts = %s", jsonOf(posts))
		}
	})
	permanentCases := map[string]func(*fakeSlack) agent.Outbound{
		"channel is gone":           func(f *fakeSlack) agent.Outbound { f.fail("chat.postMessage", "channel_not_found"); return msg },
		"bot is not in the channel": func(f *fakeSlack) agent.Outbound { f.fail("chat.postMessage", "not_in_channel"); return msg },
		"unknown emoji": func(f *fakeSlack) agent.Outbound {
			f.fail("reactions.add", "invalid_name")
			return agent.Outbound{Kind: "reaction", Address: "slack:C9:200.1", Body: "nope"}
		},
		"reaction with nothing to react to": func(*fakeSlack) agent.Outbound {
			return agent.Outbound{Kind: "reaction", Address: "slack:C9", Body: "eyes"}
		},
		"not a slack address": func(*fakeSlack) agent.Outbound {
			return agent.Outbound{Kind: "message", Address: "pager:x", Body: "hi"}
		},
		"empty channel": func(*fakeSlack) agent.Outbound { return agent.Outbound{Kind: "message", Address: "slack:", Body: "hi"} },
		"unknown kind":  func(*fakeSlack) agent.Outbound { return agent.Outbound{Kind: "poll", Address: "slack:C9", Body: "hi"} },
	}
	for name, setup := range permanentCases {
		t.Run(name+" is permanent", func(t *testing.T) {
			f := newFakeSlack(t)
			if _, err := f.adapter().Send(context.Background(), setup(f)); !errors.Is(err, agent.ErrPermanent) {
				t.Fatalf("err = %v, want a permanent failure", err)
			}
		})
	}
	retryable := map[string]func(*fakeSlack){
		"rate limit": func(f *fakeSlack) {
			f.script("chat.postMessage", func(w http.ResponseWriter) {
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(http.StatusTooManyRequests)
			})
		},
		"revoked token": func(f *fakeSlack) { f.fail("chat.postMessage", "token_revoked") },
		"slack is down": func(f *fakeSlack) {
			f.script("chat.postMessage", func(w http.ResponseWriter) { w.WriteHeader(http.StatusBadGateway) })
		},
		"internal error": func(f *fakeSlack) { f.fail("chat.postMessage", "internal_error") },
	}
	for name, setup := range retryable {
		t.Run(name+" is retried", func(t *testing.T) {
			f := newFakeSlack(t)
			setup(f)
			if _, err := f.adapter().Send(context.Background(), msg); err == nil || errors.Is(err, agent.ErrPermanent) {
				t.Fatalf("err = %v, want a retryable failure", err)
			}
		})
	}
}

func TestBlocksPropertyCheck(t *testing.T) {
	check := (&Adapter{}).Features().MessageProperties["blocks"].Check
	if err := check(json.RawMessage(`[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]`)); err != nil {
		t.Fatal(err)
	}
	many := "[" + strings.TrimSuffix(strings.Repeat(`{"type":"divider"},`, maxBlocks+1), ",") + "]"
	for _, bad := range []string{`"a string"`, `{"type":"section"}`, `[]`, `[{"text":"no type"}]`, `["section"]`, many} {
		if err := check(json.RawMessage(bad)); err == nil {
			t.Errorf("accepted %.60s", bad)
		}
	}
}

func TestAddressAndRoute(t *testing.T) {
	for _, s := range []string{"slack:C9", "slack:C9:200.1", "slack:C9:200.5:200.1"} {
		a, err := parseAddress(s)
		if err != nil || a.String() != s {
			t.Errorf("round trip of %q = %q, %v", s, a, err)
		}
	}
	for _, s := range []string{"", "slack", "slack:", "pager:C9", "slack:C9:1:2:3"} {
		if _, err := parseAddress(s); !errors.Is(err, agent.ErrPermanent) {
			t.Errorf("parseAddress(%q) = %v", s, err)
		}
	}
	ad := New(Config{Users: map[string]string{"U2": "ann", "U1": "ann", "U3": "bob"}}, nil)
	if got, ok := ad.Route("ann"); !ok || got != "slack:U1" {
		t.Errorf("Route(ann) = %q %v, want the lowest member id", got, ok)
	}
	if _, ok := ad.Route("carol"); ok {
		t.Error("Route knows a user who is not mapped")
	}
}

func TestFromEnv(t *testing.T) {
	env := func(pairs ...string) func(string) string {
		m := map[string]string{}
		for i := 0; i < len(pairs); i += 2 {
			m[pairs[i]] = pairs[i+1]
		}
		return func(k string) string { return m[k] }
	}
	if ad, err := FromEnv(env(), nil); ad != nil || err != nil {
		t.Fatalf("unconfigured: %v %v", ad, err)
	}
	ad, err := FromEnv(env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_APP_TOKEN", "xapp-1", "KILN_SLACK_USERS", " U1:ann , U2:bob"), nil)
	if err != nil || ad.cfg.Users["U1"] != "ann" || ad.cfg.Users["U2"] != "bob" || ad.cfg.Everyone != "" || ad.cfg.APIURL != "https://slack.com/api" {
		t.Fatalf("mapped: %+v %v", ad, err)
	}
	// The mapping is optional: with none, the workspace shares one agent.
	ad, err = FromEnv(env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_APP_TOKEN", "xapp-1"), nil)
	if err != nil || len(ad.cfg.Users) != 0 || ad.cfg.Everyone != "slack" {
		t.Fatalf("unmapped: %+v %v", ad, err)
	}
	ad, err = FromEnv(env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_APP_TOKEN", "xapp-1", "KILN_SLACK_USERS", "U1:robert,*:team"), nil)
	if err != nil || ad.cfg.Users["U1"] != "robert" || ad.cfg.Everyone != "team" {
		t.Fatalf("wildcard: %+v %v", ad, err)
	}
	for name, e := range map[string]func(string) string{
		"tokens swapped":      env("KILN_SLACK_BOT_TOKEN", "xapp-1", "KILN_SLACK_APP_TOKEN", "xoxb-1", "KILN_SLACK_USERS", "U1:ann"),
		"no app token":        env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_USERS", "U1:ann"),
		"users but no tokens": env("KILN_SLACK_USERS", "U1:ann"),
		"two wildcards":       env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_APP_TOKEN", "xapp-1", "KILN_SLACK_USERS", "*:a,*:b"),
		"malformed users":     env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_APP_TOKEN", "xapp-1", "KILN_SLACK_USERS", "U1=ann"),
		"duplicate member":    env("KILN_SLACK_BOT_TOKEN", "xoxb-1", "KILN_SLACK_APP_TOKEN", "xapp-1", "KILN_SLACK_USERS", "U1:ann,U1:bob"),
	} {
		if _, err := FromEnv(e, nil); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestThroughTheAgent runs the whole path: a Slack DM becomes an inbox event,
// the agent handles it, and the reply is posted back in a thread with a
// reaction, all through the real loops.
func TestThroughTheAgent(t *testing.T) {
	f := newFakeSlack(t)
	steps := []string{
		`{"tool_calls":[
			{"id":"c1","type":"function","function":{"name":"react","arguments":"{\"event_id\":1,\"emoji\":\"eyes\"}"}},
			{"id":"c2","type":"function","function":{"name":"send_message","arguments":"{\"body\":\"pong\",\"start_thread\":true}"}}]}`,
		`{"content":"done"}`,
	}
	var mu sync.Mutex
	var firstRequest string
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		if firstRequest == "" {
			firstRequest = string(raw)
		}
		if len(steps) == 0 {
			t.Error("unexpected model call")
			http.Error(w, "script exhausted", http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, `{"choices":[{"message":%s,"finish_reason":"stop"}]}`, steps[0])
		steps = steps[1:]
	}))
	defer model.Close()

	dir := t.TempDir()
	store, err := agent.OpenStore(filepath.Join(dir, "kiln.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := agent.New(store, &agent.Model{BaseURL: model.URL, Name: "m", HTTP: http.DefaultClient}, dir, nil,
		[]agent.Adapter{f.adapter(), agent.NewWriter(io.Discard)}, log)
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
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not start the adapter")
	}
	defer conn.CloseNow()
	frame := jsonOf(map[string]any{"type": "events_api", "envelope_id": "env-1", "payload": map[string]any{"event_id": "Ev1",
		"event": map[string]any{"type": "message", "channel_type": "im", "channel": "D1", "user": annID, "text": "ping", "ts": "100.1"}}})
	if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "the reaction and the reply", func() bool {
		return len(f.to("reactions.add")) == 1 && len(f.to("chat.postMessage")) == 1
	})
	if got := jsonOf(f.to("reactions.add")[0]); got != `{"channel":"D1","name":"eyes","timestamp":"100.1"}` {
		t.Fatalf("reaction = %s", got)
	}
	post := f.to("chat.postMessage")[0]
	if post["channel"] != "D1" || post["text"] != "pong" || post["thread_ts"] != "100.1" {
		t.Fatalf("reply = %s", jsonOf(post))
	}
	mu.Lock()
	defer mu.Unlock()
	for _, want := range []string{`\"via\":\"slack\"`, `\"text\":\"ping\"`, `"name":"react"`, `"blocks":{"description":"Slack Block Kit blocks`} {
		if !strings.Contains(firstRequest, want) {
			t.Errorf("the model's first request lacks %s", want)
		}
	}
}

func TestWhoIsHeard(t *testing.T) {
	stranger := map[string]any{"type": "message", "channel_type": "im", "channel": "D7", "user": "USTRANGER", "text": "hello", "ts": "400.1"}
	hear := func(t *testing.T, cfg Config) []agent.Inbound {
		t.Helper()
		f := newFakeSlack(t)
		cfg.BotToken, cfg.AppToken, cfg.APIURL = "xoxb-test", "xapp-test", f.srv.URL+"/api"
		ad := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
		var heard []agent.Inbound
		ingest := func(_ context.Context, in agent.Inbound) error { heard = append(heard, in); return nil }
		raw, _ := json.Marshal(stranger)
		if err := ad.event(context.Background(), botUser, "Ev1", raw, ingest); err != nil {
			t.Fatal(err)
		}
		return heard
	}
	t.Run("no mapping: the workspace shares one agent", func(t *testing.T) {
		got := hear(t, Config{})
		if len(got) != 1 || got[0].User != "slack" || got[0].From != "<@USTRANGER>" {
			t.Fatalf("heard %+v", got)
		}
	})
	t.Run("a mapping without a wildcard is an allowlist", func(t *testing.T) {
		if got := hear(t, Config{Users: map[string]string{annID: "ann"}}); len(got) != 0 {
			t.Fatalf("heard %+v", got)
		}
	})
	t.Run("a wildcard takes everyone not listed", func(t *testing.T) {
		got := hear(t, Config{Users: map[string]string{annID: "ann"}, Everyone: "team"})
		if len(got) != 1 || got[0].User != "team" {
			t.Fatalf("heard %+v", got)
		}
	})
	if _, ok := New(Config{}, nil).Route("slack"); ok {
		t.Error("a shared agent has no single DM to route to")
	}
}

func history(messages ...string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		fmt.Fprintf(w, `{"ok":true,"messages":[%s]}`, strings.Join(messages, ","))
	}
}

func TestContextReadsTheConversationFromSlack(t *testing.T) {
	f := newFakeSlack(t)
	ad := f.adapter()
	// conversations.history answers newest first.
	f.script("conversations.history", history(
		`{"user":"UANN","text":"<@UBOT> did you see my previous msg?","ts":"1794800658.585299"}`,
		`{"user":"UBOT","bot_id":"B1","text":"On it.","ts":"1794800600.000100"}`,
		`{"user":"UBOB","text":"is 1 &lt; 2? ask <@UANN>","ts":"1794800500.000100"}`,
		`{"subtype":"bot_message","bot_id":"B9","username":"deploybot","text":"deploy done","ts":"1794800400.000100"}`,
		`{"subtype":"channel_join","user":"UANN","text":"<@UANN> has joined the channel","ts":"1794800300.000100"}`,
		`{"user":"UANN","text":"hey matthias","ts":"1794800200.000100"}`,
	))
	// conversations.replies answers oldest first, parent included.
	f.script("conversations.replies", history(
		`{"user":"UANN","text":"build a site","ts":"1794800668.733729","thread_ts":"1794800668.733729"}`,
		`{"user":"UBOT","text":"What kind?","ts":"1794800700.000100","thread_ts":"1794800668.733729"}`,
		`{"user":"UANN","text":"landscaping","ts":"1794801019.277699","thread_ts":"1794800668.733729"}`,
	))

	convs, err := ad.Context(context.Background(), []string{
		"slack:C9:1794800658.585299",
		"slack:C9:1794800200.000100",                   // same channel: one conversation, read up to the later message
		"slack:C9:1794801019.277699:1794800668.733729", // a thread in that channel is its own conversation
		"pager:x", // not ours: skipped
	})
	if err != nil || len(convs) != 2 {
		t.Fatalf("convs = %+v, err = %v", convs, err)
	}

	channel := convs[0]
	if channel.Where != "channel C9" || channel.You != "Matthias (<@UBOT>)" || strings.Join(channel.Addresses, ",") != "slack:C9:1794800658.585299,slack:C9:1794800200.000100" {
		t.Fatalf("channel conversation = %+v", channel)
	}
	var lines []string
	for _, m := range channel.Messages {
		lines = append(lines, m.From+": "+m.Text)
	}
	want := []string{
		"Ann (<@UANN>): hey matthias",
		"deploybot (a bot): deploy done",
		"Real UBOB (<@UBOB>): is 1 < 2? ask @Ann (<@UANN>)", // no display name: falls back to the real name
		"you: On it.",
		"Ann (<@UANN>): @Matthias (<@UBOT>) did you see my previous msg?",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("channel messages:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
	if got := channel.Messages[0].At.Unix(); got != 1794800200 {
		t.Fatalf("timestamp = %d", got)
	}
	if q := f.to("conversations.history")[0]; q["channel"] != "C9" || q["latest"] != "1794800658.585299" || q["inclusive"] != "true" || q["limit"] != "20" {
		t.Fatalf("history query = %v", q)
	}

	thread := convs[1]
	if thread.Where != "thread in channel C9" || len(thread.Messages) != 3 || thread.Messages[1].From != "you" || thread.Messages[2].Text != "landscaping" {
		t.Fatalf("thread conversation = %+v", thread)
	}
	if q := f.to("conversations.replies")[0]; q["channel"] != "C9" || q["ts"] != "1794800668.733729" {
		t.Fatalf("replies query = %v", q)
	}
	if n := len(f.to("users.info")); n != 3 {
		t.Fatalf("users.info called %d times, want once per member", n)
	}

	// A direct message is labelled as one, and only the last messages are kept.
	var many []string
	for i := 0; i < 30; i++ {
		many = append(many, fmt.Sprintf(`{"user":"UANN","text":"m%d","ts":"17948%05d.000100"}`, i, i))
	}
	f.script("conversations.replies", history(many...))
	convs, _ = ad.Context(context.Background(), []string{"slack:D1:1794800029.000100:1794800000.000100"})
	if len(convs) != 1 || convs[0].Where != "thread in direct message" || len(convs[0].Messages) != contextMessages || convs[0].Messages[contextMessages-1].Text != "m29" {
		t.Fatalf("dm thread = %+v", convs)
	}
}

func TestContextSkipsWhatItCannotRead(t *testing.T) {
	f := newFakeSlack(t)
	f.script("conversations.history", func(w http.ResponseWriter) {
		io.WriteString(w, `{"ok":false,"error":"missing_scope","needed":"groups:history","provided":"chat:write"}`)
	})
	f.script("conversations.history", history(`{"user":"UANN","text":"hi","ts":"1794800200.000100"}`))
	var logged strings.Builder
	ad := New(Config{BotToken: "xoxb-test", AppToken: "xapp-test", APIURL: f.srv.URL + "/api"}, slog.New(slog.NewTextHandler(&logged, nil)))
	convs, err := ad.Context(context.Background(), []string{"slack:G4:1794800100.000100", "slack:D1:1794800200.000100"})
	if err != nil || len(convs) != 1 || convs[0].Where != "direct message" {
		t.Fatalf("convs = %+v, err = %v", convs, err)
	}
	if !strings.Contains(logged.String(), "the app needs the groups:history scope") {
		t.Fatalf("the missing scope is not named in the log:\n%s", logged.String())
	}
}
