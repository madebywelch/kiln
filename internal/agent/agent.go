// Package agent is an always-on agent built from five durable primitives: an
// event inbox, timers, a memory folder, a permission gate, and an outbox.
// Every primitive is the same move: write intent to durable storage, then let
// a loop act on it. Adapters connect the inbox and outbox to the channels
// people use.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

const (
	runTimeout  = 20 * time.Minute
	sendTimeout = 30 * time.Second
)

type Agent struct {
	store    *Store
	model    *Model
	dataDir  string
	origins  Origins
	adapters []Adapter           // in route priority order
	props    map[string]Property // send_message parameters declared by adapters
	tools    []json.RawMessage
	http     *http.Client // for the http_request tool
	log      *slog.Logger
	now      func() time.Time
	// pace is the minimum gap between two deliveries to the same user.
	pace time.Duration
}

// New assembles an agent. Adapters are listed in route priority order: a
// message that answers nothing in particular goes to the first adapter that
// knows the user, so the adapter of last resort belongs at the end.
func New(store *Store, model *Model, dataDir string, origins Origins, adapters []Adapter, log *slog.Logger) (*Agent, error) {
	a := &Agent{
		store:    store,
		model:    model,
		dataDir:  dataDir,
		origins:  origins,
		adapters: adapters,
		props:    map[string]Property{},
		log:      log,
		now:      time.Now,
		pace:     2 * time.Second,
		http: &http.Client{
			Timeout: 30 * time.Second,
			// A redirect could carry an allowed origin's request somewhere else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	reactions := false
	seen := map[string]bool{}
	for _, ad := range adapters {
		name := ad.Name()
		if !sourcePattern.MatchString(name) || seen[name] {
			return nil, fmt.Errorf("adapter name %q is invalid or used twice", name)
		}
		seen[name] = true
		features := ad.Features()
		reactions = reactions || features.Reactions
		for prop, spec := range features.MessageProperties {
			if _, taken := a.props[prop]; taken || coreMessageProperty[prop] {
				return nil, fmt.Errorf("adapter %s: send_message property %q is already defined", name, prop)
			}
			a.props[prop] = spec
		}
	}
	a.tools = toolSpecs(origins, a.props, reactions)
	return a, nil
}

func (a *Agent) adapter(address string) Adapter {
	name, _, _ := strings.Cut(address, ":")
	for _, ad := range a.adapters {
		if ad.Name() == name {
			return ad
		}
	}
	return nil
}

// Run drives the three polling loops and every adapter until ctx is cancelled.
func (a *Agent) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Go(func() { a.loop(ctx, "inbox", time.Second, a.tickInbox) })
	wg.Go(func() { a.loop(ctx, "timers", 5*time.Second, a.tickTimers) })
	wg.Go(func() { a.loop(ctx, "outbox", time.Second, a.tickOutbox) })
	for _, ad := range a.adapters {
		wg.Go(func() { a.listen(ctx, ad) })
	}
	wg.Wait()
}

func (a *Agent) loop(ctx context.Context, name string, every time.Duration, tick func(context.Context) error) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := tick(ctx); err != nil && ctx.Err() == nil {
			a.log.Error("tick failed", "loop", name, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// listen keeps one adapter's Run going. An adapter reconnects by returning;
// the pause before the next Run doubles while runs keep ending quickly.
func (a *Agent) listen(ctx context.Context, ad Adapter) {
	wait := time.Second
	for {
		started := time.Now()
		err := a.safeListen(ctx, ad)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			wait = time.Second
		}
		if err != nil {
			a.log.Error("adapter stopped, restarting", "adapter", ad.Name(), "in", wait.String(), "err", err)
		} else {
			a.log.Info("adapter reconnecting", "adapter", ad.Name(), "in", wait.String())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, time.Minute)
	}
}

func (a *Agent) safeListen(ctx context.Context, ad Adapter) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic in adapter: %v\n%s", p, debug.Stack())
		}
	}()
	return ad.Run(ctx, a.Ingest)
}

// Ingest is the IngestFunc handed to adapters: validate, one INSERT, done.
func (a *Agent) Ingest(ctx context.Context, in Inbound) error {
	switch {
	case !userIDPattern.MatchString(in.User):
		return fmt.Errorf("invalid user id %q", in.User)
	case !sourcePattern.MatchString(in.Source) || in.Source == SourceTimer || in.Source == SourceTask:
		return fmt.Errorf("invalid source %q", in.Source)
	case strings.TrimSpace(in.Text) == "":
		return errors.New("event has no text")
	case in.Origin != "" && a.adapter(in.Origin) == nil:
		return fmt.Errorf("origin %q names no adapter", in.Origin)
	}
	id, duplicate, err := a.store.AddEvent(ctx, in, a.now())
	if err != nil {
		return err
	}
	if duplicate {
		a.log.Info("duplicate event dropped", "user", in.User, "dedupe", in.Dedupe)
		return nil
	}
	a.log.Info("event accepted", "event", id, "user", in.User, "source", in.Source, "origin", in.Origin, "bytes", len(in.Text))
	return nil
}

// tickInbox is the worker: one run per user with pending events, users in
// turn. A single process handling users one at a time is the whole lock.
func (a *Agent) tickInbox(ctx context.Context) error {
	users, err := a.store.RunnableUsers(ctx, a.now())
	if err != nil {
		return err
	}
	for _, user := range users {
		if ctx.Err() != nil {
			return nil
		}
		a.process(ctx, user)
	}
	return nil
}

func (a *Agent) process(ctx context.Context, user string) {
	events, dead, err := a.store.ClaimBatch(ctx, user, a.now())
	if err != nil {
		a.log.Error("claim failed", "user", user, "err", err)
		return
	}
	if dead > 0 {
		a.log.Error("events dead-lettered", "user", user, "count", dead)
	}
	if len(events) == 0 {
		return
	}
	last := events[len(events)-1]
	attempt := 0
	for _, e := range events {
		attempt = max(attempt, e.Attempts)
	}
	a.log.Info("run started", "user", user, "events", len(events), "through", last.ID, "attempt", attempt)
	started := time.Now()

	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	eff, err := a.safeRun(runCtx, user, events)
	if err == nil {
		// A finished run is committed even if shutdown began meanwhile.
		err = a.store.Commit(context.WithoutCancel(ctx), user, last.ID, eff, a.now())
	}
	if err != nil {
		if ctx.Err() != nil {
			a.log.Info("run interrupted by shutdown, will retry", "user", user)
			return
		}
		until := a.now().Add(backoff(attempt))
		a.log.Error("run failed", "user", user, "through", last.ID, "attempt", attempt, "retry_at", until.Format(time.RFC3339), "err", err)
		if err := a.store.Backoff(ctx, user, last.ID, until); err != nil {
			a.log.Error("backoff not recorded", "user", user, "err", err)
		}
		return
	}
	a.log.Info("run committed", "user", user, "through", last.ID, "outbound", len(eff.out),
		"timers_set", len(eff.timers), "timers_cancelled", len(eff.cancels), "parked", eff.approval != nil,
		"duration", time.Since(started).Round(time.Millisecond).String())
}

// safeRun turns a panic in a run into an ordinary failure, so one poison
// event is retried and dead-lettered instead of taking the process down.
func (a *Agent) safeRun(ctx context.Context, user string, events []Event) (eff effects, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic in run: %v\n%s", p, debug.Stack())
		}
	}()
	return a.run(ctx, user, events)
}

// tickTimers is the scheduler. Timers never run the agent; they only write to the inbox.
func (a *Agent) tickTimers(ctx context.Context) error {
	fired, err := a.store.FireTimers(ctx, a.now())
	if fired > 0 {
		a.log.Info("timers fired", "count", fired)
	}
	if err != nil {
		return err
	}
	woken, err := a.store.FireTasks(ctx, a.now())
	if woken > 0 {
		a.log.Info("open tasks woke the agent", "count", woken)
	}
	return err
}

// route picks the adapter for an outbox entry. An entry without an address
// goes to the user's default route: the first adapter that knows them.
func (a *Agent) route(m Outbound) (Adapter, string, error) {
	address := m.Address
	if address == "" {
		for _, ad := range a.adapters {
			if route, ok := ad.Route(m.UserID); ok {
				address = route
				break
			}
		}
		if address == "" {
			return nil, "", fmt.Errorf("no adapter has a route to user %q", m.UserID)
		}
	}
	ad := a.adapter(address)
	if ad == nil {
		return nil, "", fmt.Errorf("address %q names no configured adapter", address)
	}
	return ad, address, nil
}

// tickOutbox is the dispatcher: the only code that hands anything to a channel.
func (a *Agent) tickOutbox(ctx context.Context) error {
	due, err := a.store.DueOutbox(ctx, a.now(), a.pace)
	if err != nil {
		return err
	}
	for _, m := range due {
		ad, address, err := a.route(m)
		var remote string
		if err == nil {
			m.Address = address
			sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
			remote, err = ad.Send(sendCtx, m)
			cancel()
		} else {
			err = fmt.Errorf("%w: %v", ErrPermanent, err)
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, ErrPermanent) {
				a.log.Error("delivery impossible, abandoned", "outbox", m.ID, "user", m.UserID, "kind", m.Kind, "address", m.Address, "err", err)
				if err := a.store.MarkFailed(ctx, m); err != nil {
					return err
				}
				continue
			}
			abandoned, merr := a.store.MarkUnsent(ctx, m, a.now())
			a.log.Error("delivery failed", "outbox", m.ID, "user", m.UserID, "kind", m.Kind, "address", m.Address, "attempt", m.Attempts+1, "abandoned", abandoned, "err", err)
			if merr != nil {
				return merr
			}
			continue
		}
		// Delivered: record it even if shutdown began, or it is sent twice.
		if err := a.store.MarkSent(context.WithoutCancel(ctx), m.ID, remote, a.now()); err != nil {
			return err
		}
		a.log.Info("delivered", "outbox", m.ID, "user", m.UserID, "kind", m.Kind, "address", m.Address, "remote", remote)
	}
	return nil
}
