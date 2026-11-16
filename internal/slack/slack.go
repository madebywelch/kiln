// Package slack connects the agent to Slack over Socket Mode: an outbound
// WebSocket, so kiln needs no public URL.
//
// It hears direct messages, @mentions, everything else said in the channels it
// is in (as ambient events, for the agent to judge), reactions on its own
// messages, and clicks on Block Kit elements. It shows the agent the recent
// conversation around each of those. It sends messages (Markdown, or Block Kit
// when the model supplies blocks), threaded replies, reactions, and approval
// prompts with buttons.
package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/madebywelch/kiln/internal/agent"
)

const (
	name = "slack"

	actionApprove = "kiln_approve"
	actionDecline = "kiln_decline"
	// approvalBlock prefixes the block_id of an approval prompt's buttons; the
	// rest is the kiln user the prompt is for, so nobody else's click counts.
	approvalBlock = "kiln_approval:"

	// Slack's limits: all markdown blocks in one message share 12,000
	// characters, and a section's text holds 3,000.
	maxMarkdown = 11000
	maxSection  = 3000
	maxBlocks   = 50

	keepalive = 30 * time.Second

	// contextMessages is how much of a conversation the agent is shown.
	contextMessages = 20

	// defaultUser is the kiln user for a workspace with no user mapping: one
	// agent, with one memory, that everyone in the workspace talks to.
	defaultUser = "slack"
)

// Config is everything the adapter needs.
//
// Who the agent listens to is decided by Users and Everyone. Users maps a
// Slack member id to the kiln user that person is. Everyone is the kiln user
// for any member not in Users. With both empty, Everyone is defaultUser: the
// workspace is the boundary and its members share one agent. With Users set
// and Everyone empty, only the listed members are heard.
type Config struct {
	BotToken string // xoxb-..., for the Web API
	AppToken string // xapp-..., for Socket Mode
	Users    map[string]string
	Everyone string
	APIURL   string // defaults to https://slack.com/api
}

type Adapter struct {
	cfg     Config
	slackOf map[string]string // kiln user -> Slack member id
	http    *http.Client
	log     *slog.Logger

	mu sync.Mutex
	// keepalive is how often the socket is pinged.
	keepalive time.Duration

	botUser string            // the bot's member id, learned from auth.test
	names   map[string]string // member id -> display name
	ignored map[string]bool   // members outside the mapping, already logged
}

// FromEnv builds the adapter from KILN_SLACK_* variables. It returns nil
// when none is set: Slack is simply not configured.
func FromEnv(getenv func(string) string, log *slog.Logger) (*Adapter, error) {
	bot, app, users := getenv("KILN_SLACK_BOT_TOKEN"), getenv("KILN_SLACK_APP_TOKEN"), strings.TrimSpace(getenv("KILN_SLACK_USERS"))
	if bot == "" && app == "" {
		if users != "" {
			return nil, errors.New("KILN_SLACK_USERS is set but the Slack tokens are not")
		}
		return nil, nil
	}
	if !strings.HasPrefix(bot, "xoxb-") {
		return nil, errors.New("KILN_SLACK_BOT_TOKEN must be the bot token, which starts with xoxb-")
	}
	if !strings.HasPrefix(app, "xapp-") {
		return nil, errors.New("KILN_SLACK_APP_TOKEN must be the app-level token, which starts with xapp-")
	}
	cfg := Config{BotToken: bot, AppToken: app, Users: map[string]string{}}
	for _, pair := range strings.Split(users, ",") {
		if users == "" {
			break
		}
		member, user, ok := strings.Cut(strings.TrimSpace(pair), ":")
		if !ok || member == "" || user == "" {
			return nil, fmt.Errorf("KILN_SLACK_USERS must look like U0123ABCD:robert,*:team; got %q", users)
		}
		if member == "*" {
			if cfg.Everyone != "" {
				return nil, errors.New("KILN_SLACK_USERS has more than one * entry")
			}
			cfg.Everyone = user
			continue
		}
		if _, dup := cfg.Users[member]; dup {
			return nil, fmt.Errorf("KILN_SLACK_USERS lists %s twice", member)
		}
		cfg.Users[member] = user
	}
	return New(cfg, log), nil
}

func New(cfg Config, log *slog.Logger) *Adapter {
	if cfg.APIURL == "" {
		cfg.APIURL = "https://slack.com/api"
	}
	if len(cfg.Users) == 0 && cfg.Everyone == "" {
		cfg.Everyone = defaultUser
	}
	a := &Adapter{cfg: cfg, slackOf: map[string]string{}, http: &http.Client{Timeout: 30 * time.Second}, log: log,
		keepalive: keepalive, names: map[string]string{}, ignored: map[string]bool{}}
	for member, user := range cfg.Users {
		// With several Slack accounts for one kiln user, the default route is
		// the first in id order, so it does not change between restarts.
		if current, ok := a.slackOf[user]; !ok || member < current {
			a.slackOf[user] = member
		}
	}
	return a
}

func (*Adapter) Name() string { return name }

func (*Adapter) Features() agent.Features {
	return agent.Features{
		Reactions: true,
		MessageProperties: map[string]agent.Property{
			"blocks": {
				Schema: map[string]any{
					"type":  "array",
					"items": map[string]any{"type": "object"},
					"description": "Slack Block Kit blocks, for a layout Markdown cannot express: fields, images, dividers, context lines, buttons, menus. " +
						"Used when the message goes to Slack; body stays required and becomes the notification text. " +
						"A click on a button or menu comes back to you as an event from the user. Omit for ordinary replies.",
				},
				Check: checkBlocks,
			},
		},
	}
}

func checkBlocks(value json.RawMessage) error {
	var blocks []struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(value, &blocks); err != nil {
		return errors.New("must be an array of Block Kit block objects")
	}
	if len(blocks) == 0 || len(blocks) > maxBlocks {
		return fmt.Errorf("must hold between 1 and %d blocks", maxBlocks)
	}
	for i, b := range blocks {
		if b.Type == "" {
			return fmt.Errorf("block %d has no type", i)
		}
	}
	return nil
}

// Route sends a mapped user's unaddressed messages to their DM with the bot.
// Slack accepts a member id wherever it takes a channel. A kiln user shared by
// several members has no single DM, so it has no route here.
func (a *Adapter) Route(user string) (string, bool) {
	member, ok := a.slackOf[user]
	return address{channel: member}.String(), ok
}

// address is "slack:<channel>[:<ts>[:<thread_ts>]]". With only a channel it
// names a place; with a ts it names one message, and thread is set when that
// message sits in a thread.
type address struct{ channel, ts, thread string }

func (a address) String() string {
	parts := []string{name, a.channel}
	if a.ts != "" {
		parts = append(parts, a.ts)
		if a.thread != "" && a.thread != a.ts {
			parts = append(parts, a.thread)
		}
	}
	return strings.Join(parts, ":")
}

func parseAddress(s string) (address, error) {
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 4 || parts[0] != name || parts[1] == "" {
		return address{}, fmt.Errorf("%w: %q is not a slack address", agent.ErrPermanent, s)
	}
	a := address{channel: parts[1]}
	if len(parts) > 2 {
		a.ts = parts[2]
	}
	if len(parts) > 3 {
		a.thread = parts[3]
	}
	return a, nil
}

// apiError is an ok:false answer from the Web API. needed is the scope Slack
// says is missing, when that is the problem.
type apiError struct{ method, code, needed string }

func (e *apiError) Error() string {
	if e.needed != "" {
		return fmt.Sprintf("slack %s: %s: the app needs the %s scope; add it and reinstall the app", e.method, e.code, e.needed)
	}
	return fmt.Sprintf("slack %s: %s", e.method, e.code)
}

// permanent lists the errors no retry can fix: the destination is gone or the
// content is refused. Auth and rate-limit errors are absent on purpose; an
// operator can fix those while the outbox waits.
var permanent = map[string]bool{
	"channel_not_found": true, "not_in_channel": true, "is_archived": true, "user_not_found": true,
	"message_not_found": true, "thread_not_found": true, "cannot_reply_to_message": true,
	"no_text": true, "msg_too_long": true, "invalid_arguments": true,
	"invalid_blocks": true, "invalid_blocks_format": true, "msg_blocks_too_long": true,
	"invalid_name": true, "too_many_reactions": true, "too_many_emoji": true, "no_item_specified": true,
}

func (e *apiError) Unwrap() error {
	if permanent[e.code] {
		return agent.ErrPermanent
	}
	return nil
}

func code(err error) string {
	var api *apiError
	if errors.As(err, &api) {
		return api.code
	}
	return ""
}

// call invokes a Web API method that takes a JSON body: the ones that write.
func (a *Adapter) call(ctx context.Context, token, method string, in, out any) error {
	body := []byte("{}")
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.APIURL+"/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	return a.do(req, token, method, out)
}

// get invokes a Web API method that reads. Those ignore JSON bodies and take
// their arguments from the query string.
func (a *Adapter) get(ctx context.Context, method string, args url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.APIURL+"/"+method+"?"+args.Encode(), nil)
	if err != nil {
		return err
	}
	return a.do(req, a.cfg.BotToken, method, out)
}

func (a *Adapter) do(req *http.Request, token, method string, out any) error {
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("slack %s: %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("slack %s: %w", method, err)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("slack %s: rate limited, retry after %ss", method, resp.Header.Get("Retry-After"))
	}
	var envelope struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Needed string `json:"needed"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("slack %s: HTTP %d with a body that is not JSON", method, resp.StatusCode)
	}
	if !envelope.OK {
		return &apiError{method: method, code: envelope.Error, needed: envelope.Needed}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// self returns the bot's own member id, asking Slack once.
func (a *Adapter) self(ctx context.Context) (string, error) {
	a.mu.Lock()
	id := a.botUser
	a.mu.Unlock()
	if id != "" {
		return id, nil
	}
	var auth struct {
		UserID string `json:"user_id"`
		Team   string `json:"team"`
	}
	if err := a.call(ctx, a.cfg.BotToken, "auth.test", nil, &auth); err != nil {
		return "", err
	}
	a.mu.Lock()
	a.botUser = auth.UserID
	a.mu.Unlock()
	a.log.Info("slack identified", "team", auth.Team, "bot_user", auth.UserID)
	return auth.UserID, nil
}

// Run holds one Socket Mode connection. It returns nil when Slack asks for a
// reconnect and an error when the connection breaks; the agent calls it again
// either way.
func (a *Adapter) Run(ctx context.Context, ingest agent.IngestFunc) error {
	bot, err := a.self(ctx)
	if err != nil {
		return err
	}
	var open struct {
		URL string `json:"url"`
	}
	if err := a.call(ctx, a.cfg.AppToken, "apps.connections.open", nil, &open); err != nil {
		return err
	}
	conn, _, err := websocket.Dial(ctx, open.URL, nil)
	if err != nil {
		return fmt.Errorf("slack socket: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20)

	// A connection that dies without a close frame would leave Read waiting
	// forever, so it is pinged, and closed when it stops answering, which
	// makes Read return. Slack skips the odd pong on a healthy connection;
	// only two misses in a row count as dead.
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stale atomic.Bool
	go func() {
		t := time.NewTicker(a.keepalive)
		defer t.Stop()
		missed := 0
		for {
			select {
			case <-connCtx.Done():
				return
			case <-t.C:
				pingCtx, done := context.WithTimeout(connCtx, a.keepalive/3)
				err := conn.Ping(pingCtx)
				done()
				if err == nil {
					missed = 0
					continue
				}
				if connCtx.Err() != nil {
					return
				}
				if missed++; missed < 2 {
					continue
				}
				stale.Store(true)
				conn.CloseNow()
				return
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			switch {
			case ctx.Err() != nil:
				return nil
			case stale.Load():
				a.log.Info("slack connection stopped answering pings; reconnecting")
				return nil
			case errors.Is(err, io.EOF) || websocket.CloseStatus(err) != -1:
				// Slack rotates connections and often just hangs up.
				a.log.Info("slack closed the connection; reconnecting")
				return nil
			}
			return fmt.Errorf("slack socket: %w", err)
		}
		var env struct {
			Type       string          `json:"type"`
			EnvelopeID string          `json:"envelope_id"`
			Reason     string          `json:"reason"`
			Payload    json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			a.log.Warn("slack sent a frame that is not JSON", "err", err)
			continue
		}
		switch env.Type {
		case "hello":
			a.log.Info("slack connected", "bot_user", bot)
			continue
		case "disconnect":
			a.log.Info("slack asked for a reconnect", "reason", env.Reason)
			return nil
		}
		if env.EnvelopeID == "" {
			continue
		}
		// Acknowledge only what is durable. Slack redelivers the rest, and
		// the dedupe key makes a redelivery harmless.
		if err := a.handle(ctx, bot, env.Type, env.Payload, ingest); err != nil {
			a.log.Error("slack event not recorded, leaving it unacknowledged", "type", env.Type, "err", err)
			continue
		}
		ack, _ := json.Marshal(map[string]string{"envelope_id": env.EnvelopeID})
		if err := conn.Write(ctx, websocket.MessageText, ack); err != nil {
			return fmt.Errorf("slack socket: %w", err)
		}
	}
}

func (a *Adapter) handle(ctx context.Context, bot, kind string, payload json.RawMessage, ingest agent.IngestFunc) error {
	switch kind {
	case "events_api":
		var p struct {
			EventID string          `json:"event_id"`
			Event   json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil // malformed: acknowledge and drop, a retry would be the same
		}
		return a.event(ctx, bot, p.EventID, p.Event, ingest)
	case "interactive":
		return a.interaction(ctx, payload, ingest)
	}
	return nil
}

// kilnUser maps a Slack member to a kiln user. Under a mapping that excludes
// them it logs each stranger once, so the operator can see who was turned away.
func (a *Adapter) kilnUser(member string) (string, bool) {
	if user, ok := a.cfg.Users[member]; ok {
		return user, true
	}
	if a.cfg.Everyone != "" && member != "" {
		return a.cfg.Everyone, true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if member != "" && !a.ignored[member] {
		a.ignored[member] = true
		a.log.Warn("ignoring Slack user who is not in KILN_SLACK_USERS", "slack_user", member)
	}
	return "", false
}

func (a *Adapter) event(ctx context.Context, bot, eventID string, raw json.RawMessage, ingest agent.IngestFunc) error {
	var e struct {
		Type        string `json:"type"`
		Subtype     string `json:"subtype"`
		User        string `json:"user"`
		BotID       string `json:"bot_id"`
		Text        string `json:"text"`
		TS          string `json:"ts"`
		ThreadTS    string `json:"thread_ts"`
		Channel     string `json:"channel"`
		ChannelType string `json:"channel_type"`
		Files       []struct {
			Name string `json:"name"`
		} `json:"files"`
		Reaction string `json:"reaction"`
		ItemUser string `json:"item_user"`
		Item     struct {
			Type    string `json:"type"`
			Channel string `json:"channel"`
			TS      string `json:"ts"`
		} `json:"item"`
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil
	}
	// A message is addressed to the agent in a DM or when it mentions the bot.
	// Anything else said where the bot is present is ambient: the agent hears
	// it and judges for itself whether it is meant to answer.
	source := agent.SourceUser
	switch e.Type {
	case "message":
		switch e.ChannelType {
		case "im":
		case "channel", "group", "mpim":
			if !strings.Contains(e.Text, "<@"+bot+">") {
				source = agent.SourceAmbient
			}
		default:
			return nil
		}
	case "app_mention":
	case "reaction_added":
		// Only reactions to the agent's own messages are feedback for it.
		if e.Item.Type != "message" || e.ItemUser != bot {
			return nil
		}
		user, ok := a.kilnUser(e.User)
		if !ok {
			return nil
		}
		return ingest(ctx, agent.Inbound{
			User:   user,
			Source: "reaction",
			From:   mention(e.User),
			Text:   fmt.Sprintf("The user reacted with :%s: to your message.", e.Reaction),
			Origin: address{channel: e.Item.Channel, ts: e.Item.TS}.String(),
			Dedupe: "slack:" + eventID,
		})
	default:
		return nil
	}

	// The bot's own posts, edits, deletions and joins all arrive as messages.
	if e.BotID != "" || e.User == bot || !spoken(e.Subtype) {
		return nil
	}
	user, ok := a.kilnUser(e.User)
	if !ok {
		return nil
	}
	text := cleanText(e.Text, bot)
	for _, f := range e.Files {
		text = strings.TrimSpace(text + "\n[attached file: " + f.Name + "]")
	}
	if text == "" {
		return nil
	}
	return ingest(ctx, agent.Inbound{
		User:   user,
		Source: source,
		From:   mention(e.User),
		Text:   text,
		Origin: address{channel: e.Channel, ts: e.TS, thread: e.ThreadTS}.String(),
		// A mention in a channel arrives as both message and app_mention;
		// keying on the message itself collapses the pair.
		Dedupe: "slack:msg:" + e.Channel + ":" + e.TS,
	})
}

// spoken reports whether a message subtype is something a person said, as
// opposed to an edit, a deletion, or a notice that someone joined.
func spoken(subtype string) bool {
	return subtype == "" || subtype == "file_share" || subtype == "thread_broadcast"
}

// mention is how a member is written in Slack text. The agent sees the same
// form in events and, beside the member's name, in conversation context.
func mention(member string) string { return "<@" + member + ">" }

// cleanText removes the mention that summoned the bot and undoes Slack's
// escaping of &, < and >.
func cleanText(text, botUser string) string {
	text = strings.ReplaceAll(text, "<@"+botUser+">", "")
	text = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(text)
	return strings.TrimSpace(text)
}

// interaction turns a click on a Block Kit element into an event from the
// user. A click on an approval prompt carries the prompt's nonce, so it can
// answer that approval and nothing else.
func (a *Adapter) interaction(ctx context.Context, payload json.RawMessage, ingest agent.IngestFunc) error {
	var p struct {
		Type string `json:"type"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		Channel struct {
			ID string `json:"id"`
		} `json:"channel"`
		Container struct {
			ChannelID string `json:"channel_id"`
			MessageTS string `json:"message_ts"`
			ThreadTS  string `json:"thread_ts"`
		} `json:"container"`
		Message struct {
			TS       string `json:"ts"`
			ThreadTS string `json:"thread_ts"`
			Text     string `json:"text"`
		} `json:"message"`
		Actions []struct {
			ActionID string `json:"action_id"`
			BlockID  string `json:"block_id"`
			Value    string `json:"value"`
			ActionTS string `json:"action_ts"`
			Text     struct {
				Text string `json:"text"`
			} `json:"text"`
			SelectedOption struct {
				Value string `json:"value"`
				Text  struct {
					Text string `json:"text"`
				} `json:"text"`
			} `json:"selected_option"`
		} `json:"actions"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || p.Type != "block_actions" || len(p.Actions) == 0 {
		return nil
	}
	user, ok := a.kilnUser(p.User.ID)
	if !ok {
		return nil
	}
	act := p.Actions[0]
	at := address{
		channel: first(p.Container.ChannelID, p.Channel.ID),
		ts:      first(p.Container.MessageTS, p.Message.TS),
		thread:  first(p.Container.ThreadTS, p.Message.ThreadTS),
	}
	in := agent.Inbound{
		User:   user,
		Source: agent.SourceUser,
		From:   mention(p.User.ID),
		Origin: at.String(),
		Dedupe: "slack:action:" + at.channel + ":" + at.ts + ":" + act.ActionTS,
	}

	if owner, isApproval := strings.CutPrefix(act.BlockID, approvalBlock); isApproval {
		if owner != user || (act.ActionID != actionApprove && act.ActionID != actionDecline) {
			return nil
		}
		in.Approval = act.Value
		in.Text = "no"
		if act.ActionID == actionApprove {
			in.Text = "yes"
		}
		if err := ingest(ctx, in); err != nil {
			return err
		}
		// Take the buttons away so the prompt cannot be clicked twice. This is
		// cosmetic: the nonce is what makes a second click harmless.
		go a.settle(context.WithoutCancel(ctx), at, p.Message.Text, act.ActionID == actionApprove, p.User.ID)
		return nil
	}

	// Any other element is one the model put in its own blocks.
	switch {
	case act.SelectedOption.Value != "":
		in.Text = fmt.Sprintf("Selected %q (value: %s)", act.SelectedOption.Text.Text, act.SelectedOption.Value)
	case act.Text.Text != "" || act.Value != "":
		in.Text = fmt.Sprintf("Clicked %q (value: %s)", act.Text.Text, act.Value)
	default:
		in.Text = fmt.Sprintf("Used the %q control", act.ActionID)
	}
	return ingest(ctx, in)
}

func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// settle rewrites an approval prompt without its buttons.
func (a *Adapter) settle(ctx context.Context, at address, text string, approved bool, member string) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	verdict := ":no_entry_sign: Declined by <@" + member + ">"
	if approved {
		verdict = ":white_check_mark: Approved by <@" + member + ">"
	}
	blocks := append(plainSections(text), map[string]any{
		"type":     "context",
		"elements": []any{map[string]any{"type": "mrkdwn", "text": verdict}},
	})
	err := a.call(ctx, a.cfg.BotToken, "chat.update", map[string]any{
		"channel": at.channel, "ts": at.ts, "text": text, "blocks": blocks,
	}, nil)
	if err != nil {
		a.log.Warn("approval prompt not updated", "err", err)
	}
}

// plainSections shows text exactly as written, split to fit Slack's section
// limit. An approval prompt must not be reformatted on its way to the user.
func plainSections(text string) []any {
	var blocks []any
	runes := []rune(text)
	for len(runes) > 0 {
		n := min(len(runes), maxSection)
		blocks = append(blocks, map[string]any{
			"type": "section",
			"text": map[string]any{"type": "plain_text", "text": string(runes[:n]), "emoji": false},
		})
		runes = runes[n:]
	}
	return blocks
}

func button(label, style, action, value string) map[string]any {
	return map[string]any{
		"type": "button", "style": style, "action_id": action, "value": value,
		"text": map[string]any{"type": "plain_text", "text": label},
	}
}

// blocks chooses how a message is laid out: approval buttons, the model's own
// blocks, or a markdown block so that ordinary Markdown renders as written.
func blocks(m agent.Outbound) any {
	switch {
	case m.Options.Approval != "":
		return append(plainSections(m.Body), map[string]any{
			"type":     "actions",
			"block_id": approvalBlock + m.UserID,
			"elements": []any{
				button("Approve", "primary", actionApprove, m.Options.Approval),
				button("Decline", "danger", actionDecline, m.Options.Approval),
			},
		})
	case m.Options.Props["blocks"] != nil:
		return m.Options.Props["blocks"]
	case utf8.RuneCountInString(m.Body) <= maxMarkdown:
		return []any{map[string]any{"type": "markdown", "text": m.Body}}
	}
	return nil
}

// Send delivers a message or a reaction.
func (a *Adapter) Send(ctx context.Context, m agent.Outbound) (string, error) {
	to, err := parseAddress(m.Address)
	if err != nil {
		return "", err
	}
	switch m.Kind {
	case agent.KindReaction:
		if to.ts == "" {
			return "", fmt.Errorf("%w: a reaction needs a message, and %q names only a place", agent.ErrPermanent, m.Address)
		}
		err := a.call(ctx, a.cfg.BotToken, "reactions.add", map[string]any{
			"channel": to.channel, "timestamp": to.ts, "name": emojiName(m.Body),
		}, nil)
		if code(err) == "already_reacted" {
			err = nil
		}
		return "", err
	case agent.KindMessage:
	default:
		return "", fmt.Errorf("%w: slack cannot send a %q", agent.ErrPermanent, m.Kind)
	}

	req := map[string]any{"channel": to.channel, "text": m.Body, "unfurl_links": false}
	// A reply to a message in a thread stays in the thread. A reply to a
	// top-level message sits beside it unless a thread was asked for.
	thread := to.thread
	if thread == "" && m.Options.StartThread {
		thread = to.ts
	}
	if thread != "" {
		req["thread_ts"] = thread
	}
	if layout := blocks(m); layout != nil {
		req["blocks"] = layout
	}
	var posted struct {
		Channel string `json:"channel"`
		TS      string `json:"ts"`
	}
	err = a.call(ctx, a.cfg.BotToken, "chat.postMessage", req, &posted)
	if c := code(err); req["blocks"] != nil && (c == "invalid_blocks" || c == "invalid_blocks_format" || c == "msg_blocks_too_long") {
		// The words matter more than the layout: send them plain.
		a.log.Warn("slack refused the blocks, sending text only", "outbox", m.ID, "err", err)
		delete(req, "blocks")
		err = a.call(ctx, a.cfg.BotToken, "chat.postMessage", req, &posted)
	}
	if err != nil {
		return "", err
	}
	return address{channel: posted.Channel, ts: posted.TS}.String(), nil
}

// Context reads the recent messages around each address from Slack: the
// thread for a message in one, otherwise the channel or DM up to that message.
func (a *Adapter) Context(ctx context.Context, addresses []string) ([]agent.Conversation, error) {
	bot, err := a.self(ctx)
	if err != nil {
		return nil, err
	}
	type place struct {
		channel, thread, latest string
		addresses               []string
	}
	var places []*place
	for _, raw := range addresses {
		at, err := parseAddress(raw)
		if err != nil {
			continue
		}
		i := slices.IndexFunc(places, func(p *place) bool { return p.channel == at.channel && p.thread == at.thread })
		if i < 0 {
			places = append(places, &place{channel: at.channel, thread: at.thread})
			i = len(places) - 1
		}
		places[i].addresses = append(places[i].addresses, raw)
		if at.ts > places[i].latest { // Slack timestamps are fixed-width, so they compare as strings
			places[i].latest = at.ts
		}
	}

	var out []agent.Conversation
	for _, p := range places {
		var page struct {
			Messages []struct {
				Subtype  string `json:"subtype"`
				User     string `json:"user"`
				BotID    string `json:"bot_id"`
				Username string `json:"username"`
				Text     string `json:"text"`
				TS       string `json:"ts"`
			} `json:"messages"`
		}
		where := "channel " + p.channel
		if strings.HasPrefix(p.channel, "D") {
			where = "direct message"
		}
		if p.thread != "" {
			// Replies come oldest first; a thread longer than one page loses its newest end.
			where = "thread in " + where
			err = a.get(ctx, "conversations.replies", url.Values{"channel": {p.channel}, "ts": {p.thread}, "limit": {"200"}}, &page)
		} else {
			args := url.Values{"channel": {p.channel}, "limit": {strconv.Itoa(contextMessages)}}
			if p.latest != "" {
				args.Set("latest", p.latest)
				args.Set("inclusive", "true")
			}
			err = a.get(ctx, "conversations.history", args, &page)
			slices.Reverse(page.Messages) // history comes newest first
		}
		if err != nil {
			a.log.Warn("slack conversation not readable", "channel", p.channel, "err", err)
			continue
		}
		conv := agent.Conversation{Where: where, Addresses: p.addresses, You: a.name(ctx, bot) + " (" + mention(bot) + ")"}
		for _, m := range page.Messages[max(0, len(page.Messages)-contextMessages):] {
			if !spoken(m.Subtype) && m.Subtype != "bot_message" {
				continue
			}
			from := "you"
			switch {
			case m.User == bot:
			case m.User != "":
				from = a.name(ctx, m.User) + " (" + mention(m.User) + ")"
			case m.Username != "":
				from = m.Username + " (a bot)"
			default:
				from = "a bot"
			}
			secs, _ := strconv.ParseFloat(m.TS, 64)
			conv.Messages = append(conv.Messages, agent.Said{
				At:   time.Unix(int64(secs), 0),
				From: from,
				Text: a.readable(ctx, m.Text),
			})
		}
		out = append(out, conv)
	}
	return out, nil
}

var mentionPattern = regexp.MustCompile(`<@([UW][A-Z0-9]+)(?:\|[^>]*)?>`)

// readable undoes Slack's escaping and puts a name beside each member id.
func (a *Adapter) readable(ctx context.Context, text string) string {
	text = mentionPattern.ReplaceAllStringFunc(text, func(m string) string {
		member := mentionPattern.FindStringSubmatch(m)[1]
		return "@" + a.name(ctx, member) + " (" + mention(member) + ")"
	})
	return strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(text)
}

// name returns a member's display name, asking Slack once per member. If
// Slack will not say, the id stands in; it is still unambiguous.
func (a *Adapter) name(ctx context.Context, member string) string {
	a.mu.Lock()
	name, ok := a.names[member]
	a.mu.Unlock()
	if ok {
		return name
	}
	var info struct {
		User struct {
			Name     string `json:"name"`
			RealName string `json:"real_name"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := a.get(ctx, "users.info", url.Values{"user": {member}}, &info); err != nil {
		a.log.Warn("slack member name unavailable", "member", member, "err", err)
		return member
	}
	name = first(info.User.Profile.DisplayName, info.User.Profile.RealName, info.User.RealName, info.User.Name, member)
	a.mu.Lock()
	a.names[member] = name
	a.mu.Unlock()
	return name
}

// unicodeEmoji covers the reactions a model is likely to write as a character
// instead of a name. Slack's API takes names only.
var unicodeEmoji = map[string]string{
	"👍": "thumbsup", "👎": "thumbsdown", "✅": "white_check_mark", "❌": "x", "👀": "eyes",
	"❤️": "heart", "❤": "heart", "🎉": "tada", "🙏": "pray", "🚀": "rocket", "🔥": "fire",
	"⚠️": "warning", "⚠": "warning", "🤔": "thinking_face", "😄": "smile", "👋": "wave",
	"⏳": "hourglass_flowing_sand", "💯": "100", "🙌": "raised_hands", "👏": "clap",
}

func emojiName(s string) string {
	s = strings.Trim(strings.TrimSpace(s), ":")
	if name, ok := unicodeEmoji[s]; ok {
		return name
	}
	return strings.ToLower(s)
}
