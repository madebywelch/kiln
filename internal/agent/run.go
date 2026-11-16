package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

const (
	// SourceUser marks what the user says to the agent: a direct message, a
	// mention, a click. Only these answer approvals.
	SourceUser = "user"
	// SourceAmbient marks what the user says in a shared conversation without
	// addressing the agent. The agent decides whether it is meant to join in.
	SourceAmbient = "ambient"
	SourceTimer   = "timer"
	// SourceTask marks a wake-up for a task the agent left open.
	SourceTask = "task"

	contextTimeout = 15 * time.Second

	// maxSteps caps model calls per run. A run that reaches it stops and says so.
	maxSteps = 40

	// silenceNudge is sent once when a run that includes a message from the
	// user is about to end with nothing queued for them. Models used to chat
	// answer in plain text, or stop early; this gives them one chance to fix it.
	silenceNudge = "This run is about to end and nothing has been sent to the user. " +
		"If their message calls for a reply, call send_message now. If silence is correct, reply with the single word done."

	// recentMessages is how much past conversation opens each fresh session.
	recentMessages = 8

	dreamInterval = 24 * time.Hour
	dreamNote     = "Dream: review the transcripts written since your last dream; keep the name of the last one you reviewed in notes/dream-log.md. " +
		"Curate memory from them: merge duplicate notes, replace what is outdated, record patterns that recur across runs, and make index.md match notes/. " +
		"Stay silent unless something needs the user's decision."
)

//go:embed prompt.md
var corePrompt string

// run is one agent session: a batch of events in, a set of effects out.
type run struct {
	a      *Agent
	user   string
	mem    *memory
	now    time.Time
	timers []Timer
	events []Event
	// touched lists the tasks this run opened or recorded progress on.
	touched []int64
	// replyTo is where a message goes when the model names no event: the
	// conversation of the latest thing said to the agent, failing that of the
	// latest event that has a conversation at all.
	replyTo string
	eff     effects
}

// run handles one batch for one user. It returns the effects to commit, or an
// error, in which case nothing is committed and the batch is retried.
func (a *Agent) run(ctx context.Context, user string, events []Event) (eff effects, err error) {
	mem, err := openMemory(a.dataDir, user)
	if err != nil {
		return eff, err
	}
	defer mem.close()
	now := a.now()

	if ok, err := mem.seeded(); err != nil {
		return eff, err
	} else if !ok {
		// Timer first, files second: SeedTimer is idempotent, so a crash
		// between the two repeats cleanly.
		if err := a.store.SeedTimer(ctx, user, Timer{DueAt: now.Add(dreamInterval), Note: dreamNote, Interval: dreamInterval}); err != nil {
			return eff, err
		}
		if err := mem.seed(); err != nil {
			return eff, err
		}
	}

	timers, err := a.store.Timers(ctx, user)
	if err != nil {
		return eff, err
	}
	approval, err := a.store.PendingApproval(ctx, user)
	if err != nil {
		return eff, err
	}
	tasks, err := a.store.OpenTasks(ctx, user)
	if err != nil {
		return eff, err
	}
	r := &run{a: a, user: user, mem: mem, now: now, timers: timers}

	var msgs []ChatMessage
	outcome := "failed"
	firstEvent := events[0].ID
	defer func() {
		if werr := r.writeTranscript(outcome, firstEvent, msgs); werr != nil {
			a.log.Warn("transcript not written", "user", user, "err", werr)
		}
	}()

	// A click on an approval prompt answers that prompt and no other. Buttons
	// outlive their approval in the chat history; a click on an old one must
	// neither approve nor decline whatever is pending now.
	live := make([]Event, 0, len(events))
	for _, e := range events {
		if e.Approval != "" && (approval == nil || approval.Nonce != e.Approval) {
			a.log.Info("stale approval click ignored", "user", user, "event", e.ID)
			r.eff.out = append(r.eff.out, Outbound{Kind: KindMessage, Address: e.Origin,
				Body: "That approval request is no longer open.", Options: Options{StartThread: true}})
			continue
		}
		live = append(live, e)
	}
	if len(live) == 0 {
		outcome = "stale clicks only"
		return r.eff, nil
	}
	events, r.events = live, live
	for _, e := range events {
		if e.Origin != "" {
			r.replyTo = e.Origin
		}
	}
	for _, e := range events {
		if e.Source == SourceUser && e.Origin != "" {
			r.replyTo = e.Origin
		}
	}

	// A parked run resumes only when the user has said something; timers and
	// webhooks cannot answer an approval and get a fresh run instead.
	resume := approval != nil && hasUserEvent(events)
	note := ""
	if resume {
		r.eff.resolved = approval.ID
		if err := json.Unmarshal([]byte(approval.Transcript), &msgs); err != nil || len(msgs) == 0 {
			a.log.Error("parked transcript unreadable, discarding approval", "user", user, "approval", approval.ID, "err", err)
			resume, msgs = false, nil
			note = "A parked approval request could not be restored and was discarded."
		}
	}
	approvalOpen := approval != nil && r.eff.resolved == 0
	if approvalOpen {
		note = "An approval request is still waiting on the user. Calls that need approval are refused until they answer it."
	}
	// Two kinds of context open a session. The agent's own recent exchanges,
	// from every place it is present: it is one agent, and what it learned in
	// a channel it knows in a DM. And the channel's record of the conversation
	// each event came from, including what was said before the agent was woken.
	recent, err := a.store.Recent(ctx, user, events[0].ID, recentMessages)
	if err != nil {
		return eff, err
	}
	convs := a.conversations(ctx, events)
	about := map[int64]string{}
	for _, e := range events {
		if e.Origin == "" {
			continue
		}
		if body, ok, err := a.store.SentBody(ctx, user, e.Origin); err != nil {
			return eff, err
		} else if ok {
			about[e.ID] = body
		}
	}
	batch := renderBatch(now, timers, tasks, note, recent, convs, events, about)

	if resume {
		var asked ToolCall
		if err := json.Unmarshal([]byte(approval.ToolCall), &asked); err != nil {
			return eff, fmt.Errorf("decode parked tool call: %w", err)
		}
		// The call is still owed an answer unless an earlier attempt at this
		// resume already executed it and saved that progress.
		if calls := pendingCalls(msgs); len(calls) > 0 && calls[0].ID == asked.ID {
			if approved(events) {
				a.log.Info("approved call executing", "user", user, "tool", asked.Function.Name)
				msgs = append(msgs, toolResult(asked.ID, r.execute(ctx, asked)))
				saved, err := json.Marshal(msgs)
				if err != nil {
					return eff, err
				}
				if err := a.store.SaveApprovalProgress(ctx, approval.ID, string(saved)); err != nil {
					return eff, err
				}
			} else {
				a.log.Info("call declined by user", "user", user, "tool", asked.Function.Name)
				msgs = append(msgs, toolResult(asked.ID, "Error: the user did not approve this call. Their reply is in the events that follow."))
			}
		}
	} else {
		system, err := r.systemPrompt()
		if err != nil {
			return eff, err
		}
		msgs = []ChatMessage{{Role: "system", Content: system}, {Role: "user", Content: batch}}
		batch = ""
	}

	nudged := false
	for step := 0; ; step++ {
		for _, call := range pendingCalls(msgs) {
			d := gate(call, a.origins)
			a.log.Info("gate", "user", user, "tool", call.Function.Name, "verdict", d.verdict, "reason", d.reason)
			switch d.verdict {
			case allow:
				msgs = append(msgs, toolResult(call.ID, r.execute(ctx, call)))
			case deny:
				msgs = append(msgs, toolResult(call.ID, "Error: denied: "+d.reason+". Take another route."))
			case ask:
				if approvalOpen {
					msgs = append(msgs, toolResult(call.ID, "Error: this call needs the user's approval, and an earlier approval request is still waiting on them. Take another route, or set a timer and retry later."))
					continue
				}
				// Park: save the session mid-call, ask, and end the run. The
				// answer arrives later as an ordinary inbox event.
				transcript, err := json.Marshal(msgs)
				if err != nil {
					return eff, err
				}
				pending, err := json.Marshal(call)
				if err != nil {
					return eff, err
				}
				nonce := rand.Text()
				r.eff.approval = &Approval{Transcript: string(transcript), ToolCall: string(pending), Nonce: nonce}
				r.eff.out = append(r.eff.out, Outbound{Kind: KindMessage, Address: r.replyTo, Options: Options{Approval: nonce},
					Body: fmt.Sprintf(
						"Approval needed: %s %s\nWhy: %s.\nReply \"yes\" to approve. Any other reply declines and is passed on as your answer.",
						call.Function.Name, clip(call.Function.Arguments, 4000), d.reason)})
				outcome = "parked"
				return r.eff, nil
			}
		}
		if batch != "" {
			msgs = append(msgs, ChatMessage{Role: "user", Content: batch})
			batch = ""
		}
		if step == maxSteps {
			outcome = "step limit"
			// Work tracked as a task is not lost to the limit: wake at once
			// and carry on from its notes. Only untracked work is reported.
			if len(r.touched) > 0 {
				if err := a.store.WakeTasks(ctx, user, r.touched, now); err != nil {
					return eff, err
				}
				a.log.Info("run reached its step limit, continuing from open tasks", "user", user, "tasks", len(r.touched))
				return r.eff, nil
			}
			r.eff.out = append(r.eff.out, Outbound{Kind: KindMessage, Address: r.replyTo,
				Body: fmt.Sprintf("Stopped a run at its limit of %d model calls. The work may be incomplete.", maxSteps)})
			return r.eff, nil
		}
		c, err := a.model.Complete(ctx, msgs, a.tools)
		if err != nil {
			return eff, err
		}
		a.log.Info("model call", "user", user, "step", step, "finish", c.FinishReason,
			"tool_calls", len(c.Message.ToolCalls), "input_tokens", c.InputTokens, "output_tokens", c.OutputTokens)
		// An empty turn carries nothing, and some providers reject it on replay.
		if c.Message.Content != "" || len(c.Message.ToolCalls) > 0 {
			msgs = append(msgs, c.Message)
		}
		if c.FinishReason == "length" {
			// Truncated output: any tool call in it may be incomplete, so none runs.
			a.log.Warn("model output truncated, ending run", "user", user)
			outcome = "truncated"
			return r.eff, nil
		}
		if len(c.Message.ToolCalls) == 0 {
			if !nudged && len(r.eff.out) == 0 && hasUserEvent(events) {
				nudged = true
				msgs = append(msgs, ChatMessage{Role: "user", Content: silenceNudge})
				continue
			}
			outcome = "done"
			return r.eff, nil
		}
	}
}

// execute runs a call and folds any error into the result text, which is how
// the model learns to try something else.
func (r *run) execute(ctx context.Context, call ToolCall) string {
	out, err := r.exec(ctx, call)
	if err != nil {
		return "Error: " + err.Error()
	}
	return out
}

// systemPrompt is the stable front of every session: core prompt, the user's
// instructions, then the index. Nothing else from memory is loaded up front.
func (r *run) systemPrompt() (string, error) {
	instructions, err := r.mem.read(instructionsFile)
	if err != nil {
		return "", err
	}
	index, err := r.mem.read(indexFile)
	if err != nil {
		return "", err
	}
	return corePrompt + "\n# instructions.md\n\n" + instructions + "\n# index.md\n\n" + index, nil
}

// pendingCalls returns the tool calls of the last assistant message that have
// no result yet. Results follow their assistant message in call order, so the
// transcript alone says where a session stands.
func pendingCalls(msgs []ChatMessage) []ToolCall {
	answered := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		switch msgs[i].Role {
		case "tool":
			answered++
		case "assistant":
			if answered >= len(msgs[i].ToolCalls) {
				return nil
			}
			return msgs[i].ToolCalls[answered:]
		default:
			return nil
		}
	}
	return nil
}

func toolResult(callID, content string) ChatMessage {
	return ChatMessage{Role: "tool", ToolCallID: callID, Content: content}
}

func hasUserEvent(events []Event) bool {
	for _, e := range events {
		if e.Source == SourceUser {
			return true
		}
	}
	return false
}

// approved reports whether the user's reply approves a parked call. It fails
// closed: every user event in the batch must be a plain yes.
func approved(events []Event) bool {
	yes := false
	for _, e := range events {
		if e.Source != SourceUser {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(e.Payload)) {
		case "yes", "y", "approve", "approved":
			yes = true
		default:
			return false
		}
	}
	return yes
}

// conversations asks each adapter what was said around the events it carried.
// Context is a courtesy from the channel: if it cannot be had, the run goes on
// without it.
func (a *Agent) conversations(ctx context.Context, events []Event) []Conversation {
	var convs []Conversation
	for _, ad := range a.adapters {
		contexter, ok := ad.(Contexter)
		if !ok {
			continue
		}
		var addresses []string
		for _, e := range events {
			if e.Origin != "" && a.adapter(e.Origin) == ad && !slices.Contains(addresses, e.Origin) {
				addresses = append(addresses, e.Origin)
			}
		}
		if len(addresses) == 0 {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, contextTimeout)
		got, err := contexter.Context(cctx, addresses)
		cancel()
		if err != nil {
			a.log.Warn("conversation context unavailable", "adapter", ad.Name(), "err", err)
			continue
		}
		convs = append(convs, got...)
	}
	return convs
}

// renderBatch is the user turn that opens or resumes a session. Everything that
// did not come from this process is JSON-encoded, so no payload can forge an
// event boundary or a source.
func renderBatch(now time.Time, timers []Timer, tasks []Task, note string, recent []Exchange, convs []Conversation, events []Event, about map[int64]string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	stamp := func(t time.Time) string { return t.In(now.Location()).Format(time.RFC3339) }
	fmt.Fprintf(&b, "Current time: %s (%s)\n", now.Format(time.RFC3339), now.Weekday())
	if len(timers) == 0 {
		b.WriteString("Active timers: none\n")
	} else {
		b.WriteString("Active timers:\n")
		for _, t := range timers {
			enc.Encode(map[string]any{"id": t.ID, "due": stamp(t.DueAt), "repeat_seconds": int64(t.Interval / time.Second), "note": t.Note})
		}
	}
	if len(tasks) > 0 {
		b.WriteString("Open tasks, work you took on and have not finished, with your notes:\n")
		for _, t := range tasks {
			notes := t.Notes
			if len(notes) > 2000 {
				notes = "[earlier notes omitted]\n" + strings.ToValidUTF8(notes[len(notes)-2000:], "")
			}
			enc.Encode(map[string]any{"id": t.ID, "title": t.Title, "opened": stamp(t.CreatedAt), "last_progress": stamp(t.UpdatedAt), "next_wake": stamp(t.WakeAt), "notes": notes})
		}
	}
	if len(recent) > 0 {
		b.WriteString("Your latest exchanges, across every place you are present, for context only:\n")
		for _, x := range recent {
			line := map[string]any{"at": stamp(x.At), "from": x.From, "text": clip(x.Text, 400)}
			if x.Where != "" {
				line["where"] = x.Where
			}
			enc.Encode(line)
		}
	}
	in := map[string]int{} // address -> conversation number
	for i, c := range convs {
		for _, address := range c.Addresses {
			in[address] = i + 1
		}
		enc.Encode(map[string]any{"conversation": i + 1, "where": c.Where, "you_appear_as": c.You})
		b.WriteString("Its recent messages, oldest first, for context only:\n")
		for _, m := range c.Messages {
			enc.Encode(map[string]any{"at": stamp(m.At), "from": m.From, "text": clip(m.Text, 500)})
		}
	}
	if note != "" {
		b.WriteString(note + "\n")
	}
	b.WriteString("New events, oldest first:\n")
	for _, e := range events {
		line := map[string]any{"id": e.ID, "source": e.Source, "at": stamp(e.CreatedAt), "text": e.Payload}
		if via, _, ok := strings.Cut(e.Origin, ":"); ok {
			line["via"] = via
		}
		if e.From != "" {
			line["from"] = e.From
		}
		if n, ok := in[e.Origin]; ok {
			line["conversation"] = n
		}
		if body, ok := about[e.ID]; ok {
			line["about_your_message"] = clip(body, 400)
		}
		enc.Encode(line)
	}
	// Last, where it is hardest to miss: models used to chat answer in plain text.
	b.WriteString("\nPlain text you write is discarded. Anything meant for the user goes through send_message.\n")
	return b.String()
}

// writeTranscript records the session in the user's memory folder, where
// dreaming and humans can read it.
func (r *run) writeTranscript(outcome string, firstEvent int64, msgs []ChatMessage) error {
	var b strings.Builder
	fmt.Fprintf(&b, "# Run %s\n\noutcome: %s\n", r.now.UTC().Format(time.RFC3339), outcome)
	for _, m := range msgs {
		if m.Role == "system" {
			continue
		}
		fmt.Fprintf(&b, "\n## %s\n\n%s\n", m.Role, clip(m.Content, 4000))
		for _, c := range m.ToolCalls {
			fmt.Fprintf(&b, "\ncall %s %s\n", c.Function.Name, clip(c.Function.Arguments, 2000))
		}
	}
	name := fmt.Sprintf("%s/%s-%d.md", transcriptsDir, r.now.UTC().Format("20060102T150405Z"), firstEvent)
	return r.mem.write(name, clip(b.String(), maxWriteBytes-128))
}
