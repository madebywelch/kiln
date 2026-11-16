package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// An Adapter connects one messaging channel to the agent. It does two things
// and holds no agent logic: it writes what it hears to the inbox, and it
// delivers what the outbox holds for it.
//
// Addresses are strings of the form "name:rest". The agent reads only the
// name, to pick the adapter; the rest is the adapter's own business. An
// address can name a place (a channel, a DM) or a single message in it.
//
// To add a channel: implement this interface in its own package and append
// it to the list in cmd/kiln. Nothing in this package needs to change.
type Adapter interface {
	// Name is the address prefix and must be unique among adapters.
	Name() string

	// Features says what the channel can do beyond plain text.
	Features() Features

	// Route returns the address where user is reached when a message answers
	// nothing in particular, or false if this channel does not know the user.
	// Adapters are asked in order; the first to know the user wins.
	Route(user string) (address string, ok bool)

	// Run listens until ctx ends, handing everything it hears to ingest. It
	// must acknowledge an event to its source only after ingest returns nil,
	// which means the event is durable. Returning early, with or without an
	// error, makes the agent call Run again after a pause, so reconnecting is
	// just returning. An adapter that only sends blocks until ctx is done.
	Run(ctx context.Context, ingest IngestFunc) error

	// Send delivers one outbox entry. For a message it returns the address of
	// what it created, which later reactions and replies refer to. An error
	// that wraps ErrPermanent is not retried.
	Send(ctx context.Context, m Outbound) (remote string, err error)
}

// A Contexter is an adapter that can show what was said around a message.
// Every run is a fresh session, so this is how the agent sees a conversation
// it is asked to take part in: read from the channel when needed, never copied.
type Contexter interface {
	// Context returns the recent messages of each conversation the addresses
	// belong to. A conversation it cannot read is left out, not an error.
	Context(ctx context.Context, addresses []string) ([]Conversation, error)
}

// Conversation is the recent part of one channel, thread or direct message.
type Conversation struct {
	Where     string   // what and where it is, for the model: "thread in channel C123"
	You       string   // how the agent appears there, so it can tell when it is named
	Addresses []string // which of the requested addresses belong to it
	Messages  []Said   // oldest first
}

// Said is one message in a conversation. From is "you" for the agent itself.
type Said struct {
	At   time.Time
	From string
	Text string
}

// IngestFunc records one inbound event durably. A nil return means it is safe
// to acknowledge the event, including when it was a redelivery.
type IngestFunc func(ctx context.Context, in Inbound) error

// ErrPermanent marks a delivery failure that retrying cannot fix: a channel
// that does not exist, content the channel rejects.
var ErrPermanent = errors.New("permanent delivery failure")

// Features is what a channel can do beyond plain text.
type Features struct {
	// Reactions: the channel can put an emoji on a message it carried.
	Reactions bool

	// MessageProperties are extra send_message parameters the channel
	// understands, by name: Slack's "blocks", for one. The agent offers them
	// to the model and hands the values back, untouched, in Options.Props.
	MessageProperties map[string]Property
}

type Property struct {
	// Schema is the JSON Schema shown to the model, description included.
	Schema map[string]any
	// Check rejects a bad value during the run, while the model can still
	// correct it. Nil accepts anything.
	Check func(value json.RawMessage) error
}

// Inbound is one event an adapter heard.
type Inbound struct {
	User string // kiln user the event is for
	// Source is SourceUser for what the user says or clicks when it is meant
	// for the agent, SourceAmbient for what they say within its hearing, and
	// otherwise a label for what produced the event.
	Source string
	Text   string
	// From names the speaker where a conversation has several people.
	From string
	// Origin is the address of the message this event is or points at. A
	// reply to the event goes there.
	Origin string
	// Approval is the nonce of the approval prompt this event is a click on.
	// Empty for everything typed.
	Approval string
	// Dedupe is unique to the event within its source. A second event with
	// the same key is dropped, which makes redelivery harmless.
	Dedupe string
}

const (
	KindMessage  = "message"
	KindReaction = "reaction"
)

// Outbound is one outbox entry on its way to an adapter.
type Outbound struct {
	ID     int64  `json:"id"`
	UserID string `json:"user_id"`
	Kind   string `json:"kind"`
	// Address is where a message goes: a place, or a message to reply to. For
	// a reaction it is the message to react to.
	Address string `json:"address,omitempty"`
	// Body is the message text in Markdown, or a reaction's emoji name.
	Body     string  `json:"body"`
	Options  Options `json:"options,omitzero"`
	Attempts int     `json:"-"`
}

type Options struct {
	// StartThread asks for a new thread under the addressed message. A reply
	// to a message that is already in a thread stays in that thread either way.
	StartThread bool `json:"start_thread,omitempty"`
	// Approval is set on a message that asks the user to approve a call. An
	// adapter with buttons renders them and returns the nonce in
	// Inbound.Approval when one is clicked.
	Approval string `json:"approval,omitempty"`
	// Props holds the adapter-declared send_message parameters the model set.
	Props map[string]json.RawMessage `json:"props,omitempty"`
}

// sendOnly is the Run of an adapter that never hears anything.
func sendOnly(ctx context.Context) error {
	<-ctx.Done()
	return nil
}

// Writer is the adapter of last resort: every entry as a JSON line on w.
// It routes any user, so placed last it catches whoever no channel knows.
type Writer struct {
	w  io.Writer
	mu sync.Mutex
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

func (*Writer) Name() string                                { return "stdout" }
func (*Writer) Features() Features                          { return Features{} }
func (*Writer) Route(string) (string, bool)                 { return "stdout", true }
func (*Writer) Run(ctx context.Context, _ IngestFunc) error { return sendOnly(ctx) }

func (a *Writer) Send(_ context.Context, m Outbound) (string, error) {
	line, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, err = a.w.Write(append(line, '\n'))
	return "", err
}

// Webhook delivers every entry as a JSON POST to one URL. Delivery is
// at-least-once; receivers deduplicate on id.
type Webhook struct {
	url    string
	client *http.Client
}

func NewWebhook(url string) *Webhook { return &Webhook{url: url, client: &http.Client{}} }

func (*Webhook) Name() string                                { return "webhook" }
func (*Webhook) Features() Features                          { return Features{} }
func (*Webhook) Route(string) (string, bool)                 { return "webhook", true }
func (*Webhook) Run(ctx context.Context, _ IngestFunc) error { return sendOnly(ctx) }

func (a *Webhook) Send(ctx context.Context, m Outbound) (string, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("webhook returned %d", resp.StatusCode)
	}
	return "", nil
}
