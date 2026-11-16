package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"
)

const (
	toolReadFile    = "read_file"
	toolWriteFile   = "write_file"
	toolListFiles   = "list_files"
	toolSetTimer    = "set_timer"
	toolCancelTimer = "cancel_timer"
	toolSendMessage = "send_message"
	toolReact       = "react"
	toolHTTPRequest = "http_request"
	toolOpenTask    = "open_task"
	toolUpdateTask  = "update_task"

	// minTimerDelay bounds how fast the agent can wake itself, which bounds
	// what a self-rescheduling loop can cost.
	minTimerDelay   = time.Minute
	maxTimers       = 50
	maxHTTPResponse = 64 << 10
)

type fileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type timerInput struct {
	When          string `json:"when"`
	Note          string `json:"note"`
	RepeatSeconds int64  `json:"repeat_seconds"`
}

type openTaskInput struct {
	Title string `json:"title"`
	Plan  string `json:"plan"`
}

type updateTaskInput struct {
	ID     int64  `json:"id"`
	Note   string `json:"note"`
	Status string `json:"status"`
	WakeIn string `json:"wake_in"`
}

type cancelInput struct {
	ID int64 `json:"id"`
}

type messageInput struct {
	Body        string `json:"body"`
	ReplyTo     int64  `json:"reply_to"`
	StartThread bool   `json:"start_thread"`
}

// coreMessageProperty names the send_message parameters adapters may not redefine.
var coreMessageProperty = map[string]bool{"body": true, "reply_to": true, "start_thread": true}

type reactInput struct {
	EventID int64  `json:"event_id"`
	Emoji   string `json:"emoji"`
}

type httpInput struct {
	Method string `json:"method"`
	URL    string `json:"url"`
	Body   string `json:"body"`
}

type toolSpec struct {
	name        string
	description string
	properties  map[string]any
	required    []string
}

func str(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func integer(description string) map[string]any {
	return map[string]any{"type": "integer", "description": description}
}

// toolSpecs is the tool list sent to the model. It depends only on
// configuration, so it is byte-stable across runs and provider prompt caches
// hold. props are the send_message parameters adapters declare; reactions
// says whether any adapter can react.
func toolSpecs(origins Origins, props map[string]Property, reactions bool) []json.RawMessage {
	message := map[string]any{
		"body":         str("The message text, in Markdown."),
		"reply_to":     integer("Id of the event this answers. The message goes to the conversation that event came from. Omit to answer the latest event from the user, or, when the run has none, to reach the user at their default place."),
		"start_thread": map[string]any{"type": "boolean", "description": "Open a thread under the event's message instead of replying beside it. A reply to something already in a thread stays in that thread either way."},
	}
	for name, prop := range props {
		message[name] = prop.Schema
	}
	specs := []toolSpec{
		{toolReadFile, "Read a file from your memory folder.",
			map[string]any{"path": str("Path relative to the memory folder, e.g. notes/acme-renewal.md")},
			[]string{"path"}},
		{toolWriteFile, "Create or replace a file in your memory folder. Writing instructions.md needs the user's approval.",
			map[string]any{
				"path":    str("Path relative to the memory folder. Notes go under notes/."),
				"content": str("The complete new content of the file."),
			},
			[]string{"path", "content"}},
		{toolListFiles, "List a directory in your memory folder. Directories end with a slash.",
			map[string]any{"path": str("Directory relative to the memory folder; empty for the top level.")},
			nil},
		{toolSetTimer, "Schedule an event for yourself. When it comes due you are woken with the note as a timer event.",
			map[string]any{
				"when":           str("When it first fires: an RFC 3339 timestamp, or a duration from now such as 90m or 36h. At least one minute ahead."),
				"note":           str("What your future self should do. It will have no other context from this run."),
				"repeat_seconds": integer("Omit for a one-off. Otherwise the timer repeats at this interval, at least 60."),
			},
			[]string{"when", "note"}},
		{toolCancelTimer, "Cancel one of the active timers listed at the start of the run.",
			map[string]any{"id": integer("The timer's id.")},
			[]string{"id"}},
		{toolOpenTask, "Take on a piece of work that will not be finished in a step or two. The task is saved at once and survives anything that cuts the run short: " +
			"while it is open you are woken again, with its notes, to carry on. Open one before starting multi-step work, long-running work, or anything you must not drop.",
			map[string]any{
				"title": str("Short name of the work. Opening a title that is already open returns the existing task."),
				"plan":  str("What done looks like and how you mean to get there. This is the first note."),
			},
			[]string{"title", "plan"}},
		{toolUpdateTask, "Record progress on an open task, or close it. Write notes as you go, each one enough for a fresh session to continue from: what is finished, what is next, where the results are. " +
			"Notes are saved at once.",
			map[string]any{
				"id":      integer("The task's id."),
				"note":    str("What changed since the last note."),
				"status":  map[string]any{"type": "string", "enum": []string{"open", "done", "dropped"}, "description": "open (the default) keeps the work in flight. done and dropped close it; say in note what came of it."},
				"wake_in": str("For an open task: how long until it wakes you if nothing else does, as a duration such as 10m or 24h. Default 5m, which suits work you are in the middle of. Use a long wait when the task depends on someone or something else."),
			},
			[]string{"id", "note"}},
		{toolSendMessage, "Queue a message to the user. It is delivered after the run ends. This is the only way anything reaches them.",
			message,
			[]string{"body"}},
	}
	if reactions {
		specs = append(specs, toolSpec{toolReact,
			"Put an emoji reaction on the message an event came from. Lighter than a message: use it to acknowledge when no reply is needed.",
			map[string]any{
				"event_id": integer("Id of the event whose message gets the reaction."),
				"emoji":    str("Emoji short name without colons, e.g. eyes, white_check_mark, thumbsup."),
			},
			[]string{"event_id", "emoji"}})
	}
	if len(origins) > 0 {
		specs = append(specs, toolSpec{toolHTTPRequest,
			"Make an HTTP request to an allowed origin. Credentials are added for you; never put secrets in the request. " +
				"GET and HEAD run directly; other methods need the user's approval. Redirects are not followed. " +
				"Allowed origins: " + strings.Join(origins.names(), ", "),
			map[string]any{
				"method": map[string]any{"type": "string", "enum": []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"}},
				"url":    str("Absolute URL on an allowed origin."),
				"body":   str("Request body, sent as application/json. Omit for none."),
			},
			[]string{"method", "url"}})
	}
	out := make([]json.RawMessage, len(specs))
	for i, s := range specs {
		required := s.required
		if required == nil {
			required = []string{}
		}
		raw, err := json.Marshal(map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        s.name,
				"description": s.description,
				"parameters": map[string]any{
					"type":                 "object",
					"properties":           s.properties,
					"required":             required,
					"additionalProperties": false,
				},
			},
		})
		if err != nil {
			panic(err) // static data
		}
		out[i] = raw
	}
	return out
}

// exec runs one tool call that the gate has already allowed or the user has
// approved. Database effects are buffered on the run, not written here.
func (r *run) exec(ctx context.Context, call ToolCall) (string, error) {
	args := []byte(call.Function.Arguments)
	switch call.Function.Name {
	case toolReadFile:
		var in fileInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return r.mem.read(in.Path)

	case toolWriteFile:
		var in fileInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		if err := r.mem.write(in.Path, in.Content); err != nil {
			return "", err
		}
		return fmt.Sprintf("wrote %s (%d bytes)", in.Path, len(in.Content)), nil

	case toolListFiles:
		var in fileInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		names, err := r.mem.list(in.Path)
		if err != nil {
			return "", err
		}
		if len(names) == 0 {
			return "(empty)", nil
		}
		sort.Strings(names)
		return strings.Join(names, "\n"), nil

	case toolSetTimer:
		var in timerInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return r.setTimer(in)

	case toolOpenTask:
		var in openTaskInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		title := strings.TrimSpace(in.Title)
		if title == "" || len(title) > 200 {
			return "", fmt.Errorf("title must be between 1 and 200 characters")
		}
		// Tasks are written now, not with the run's other effects: their
		// whole purpose is to outlive a run that does not finish.
		id, existed, err := r.a.store.OpenTask(ctx, r.user, title, in.Plan, r.replyTo, r.a.now())
		if err != nil {
			return "", err
		}
		r.touched = append(r.touched, id)
		if existed {
			return fmt.Sprintf("task %d is already open under that title; continue it", id), nil
		}
		return fmt.Sprintf("task %d opened", id), nil

	case toolUpdateTask:
		var in updateTaskInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		if strings.TrimSpace(in.Note) == "" {
			return "", fmt.Errorf("note is empty")
		}
		state := in.Status
		if state == "" {
			state = "open"
		}
		if state != "open" && state != "done" && state != "dropped" {
			return "", fmt.Errorf("status must be open, done or dropped")
		}
		now := r.a.now()
		wait := taskWake
		if in.WakeIn != "" {
			d, err := time.ParseDuration(in.WakeIn)
			if err != nil || d < minTimerDelay || d > 30*24*time.Hour {
				return "", fmt.Errorf("wake_in must be a duration between 1m and 720h, such as 10m or 24h")
			}
			wait = d
		}
		if err := r.a.store.UpdateTask(ctx, r.user, in.ID, in.Note, state, now.Add(wait), now); err != nil {
			return "", err
		}
		if state != "open" {
			r.touched = slices.DeleteFunc(r.touched, func(id int64) bool { return id == in.ID })
			return fmt.Sprintf("task %d closed as %s", in.ID, state), nil
		}
		if !slices.Contains(r.touched, in.ID) {
			r.touched = append(r.touched, in.ID)
		}
		return fmt.Sprintf("task %d updated; it wakes you at %s unless you get to it first", in.ID, now.Add(wait).Format(time.RFC3339)), nil

	case toolCancelTimer:
		var in cancelInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		for _, t := range r.timers {
			if t.ID == in.ID {
				r.eff.cancels = append(r.eff.cancels, in.ID)
				return fmt.Sprintf("timer %d cancelled", in.ID), nil
			}
		}
		return "", fmt.Errorf("no active timer with id %d", in.ID)

	case toolSendMessage:
		var in messageInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		if strings.TrimSpace(in.Body) == "" {
			return "", fmt.Errorf("body is empty")
		}
		address := r.replyTo
		if in.ReplyTo != 0 {
			origin, err := r.origin(ctx, in.ReplyTo)
			if err != nil {
				return "", err
			}
			address = origin
		}
		opts := Options{StartThread: in.StartThread}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(args, &raw); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		for name, prop := range r.a.props {
			value, ok := raw[name]
			if !ok || string(value) == "null" {
				continue
			}
			if prop.Check != nil {
				if err := prop.Check(value); err != nil {
					return "", fmt.Errorf("%s: %v", name, err)
				}
			}
			if opts.Props == nil {
				opts.Props = map[string]json.RawMessage{}
			}
			opts.Props[name] = value
		}
		r.eff.out = append(r.eff.out, Outbound{Kind: KindMessage, Address: address, Body: in.Body, Options: opts})
		return "queued", nil

	case toolReact:
		var in reactInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		emoji := strings.Trim(strings.TrimSpace(in.Emoji), ":")
		if emoji == "" {
			return "", fmt.Errorf("emoji is empty")
		}
		origin, err := r.origin(ctx, in.EventID)
		if err != nil {
			return "", err
		}
		if ad := r.a.adapter(origin); origin == "" || ad == nil || !ad.Features().Reactions {
			return "", fmt.Errorf("event %d did not come from a place that takes reactions; use send_message", in.EventID)
		}
		r.eff.out = append(r.eff.out, Outbound{Kind: KindReaction, Address: origin, Body: emoji})
		return "queued", nil

	case toolHTTPRequest:
		var in httpInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return r.a.httpRequest(ctx, in)
	}
	return "", fmt.Errorf("unknown tool %q", call.Function.Name)
}

// origin returns the address of one of the user's events: from this batch, or
// from any earlier run, so a follow-up can return to the thread it began in.
func (r *run) origin(ctx context.Context, eventID int64) (string, error) {
	for _, e := range r.events {
		if e.ID == eventID {
			return e.Origin, nil
		}
	}
	origin, found, err := r.a.store.EventOrigin(ctx, r.user, eventID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("no event with id %d", eventID)
	}
	return origin, nil
}

func (r *run) setTimer(in timerInput) (string, error) {
	if strings.TrimSpace(in.Note) == "" {
		return "", fmt.Errorf("note is empty")
	}
	if len(r.timers)+len(r.eff.timers) >= maxTimers {
		return "", fmt.Errorf("limit of %d active timers reached; cancel some first", maxTimers)
	}
	var due time.Time
	if d, err := time.ParseDuration(in.When); err == nil {
		due = r.now.Add(d)
	} else if t, err := time.Parse(time.RFC3339, in.When); err == nil {
		due = t
	} else {
		return "", fmt.Errorf("when %q is neither an RFC 3339 timestamp nor a duration like 90m", in.When)
	}
	if due.Before(r.now.Add(minTimerDelay)) {
		return "", fmt.Errorf("when must be at least %s from now (now is %s)", minTimerDelay, r.now.Format(time.RFC3339))
	}
	interval := time.Duration(in.RepeatSeconds) * time.Second
	if in.RepeatSeconds != 0 && interval < minTimerDelay {
		return "", fmt.Errorf("repeat_seconds must be at least %d", int(minTimerDelay/time.Second))
	}
	// The timer remembers the conversation it was set in, so its result lands there.
	r.eff.timers = append(r.eff.timers, Timer{DueAt: due, Note: in.Note, Interval: interval, Origin: r.replyTo})
	if interval > 0 {
		return fmt.Sprintf("timer set for %s, repeating every %s", due.Format(time.RFC3339), interval), nil
	}
	return fmt.Sprintf("timer set for %s", due.Format(time.RFC3339)), nil
}

// httpRequest is the credential proxy in its most primitive form: the model
// names a URL, and this function adds the origin's credentials on the way out.
func (a *Agent) httpRequest(ctx context.Context, in httpInput) (string, error) {
	origin, err := originOf(in.URL)
	if err != nil {
		return "", err
	}
	// Checked here as well as in the gate: an approved call runs without the gate.
	headers, ok := a.origins[origin]
	if !ok {
		return "", fmt.Errorf("%s is not an allowed origin", origin)
	}
	var body io.Reader
	if in.Body != "" {
		body = strings.NewReader(in.Body)
	}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(in.Method), in.URL, body)
	if err != nil {
		return "", err
	}
	if in.Body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponse+1))
	if err != nil {
		return "", err
	}
	text := strings.ToValidUTF8(string(raw), "")
	// A service that echoes request headers must not leak them into the transcript.
	for _, value := range headers {
		for _, part := range strings.Fields(value) {
			if len(part) >= 8 {
				text = strings.ReplaceAll(text, part, "[redacted]")
			}
		}
	}
	if len(raw) > maxHTTPResponse {
		text = fmt.Sprintf("%s\n[truncated: first %d bytes shown]", text[:min(len(text), maxHTTPResponse)], maxHTTPResponse)
	}
	status := fmt.Sprintf("HTTP %d", resp.StatusCode)
	if loc := resp.Header.Get("Location"); loc != "" {
		status += "\nLocation: " + loc
	}
	return status + "\n\n" + text, nil
}
