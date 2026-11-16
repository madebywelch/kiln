// Command kiln runs the always-on agent: one process, one SQLite file, one
// folder of memory.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/madebywelch/kiln/internal/agent"
	"github.com/madebywelch/kiln/internal/slack"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("kiln stopped", "err", err)
		os.Exit(1)
	}
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func run(log *slog.Logger) error {
	dataDir := env("KILN_DATA", "data")
	addr := env("KILN_ADDR", "127.0.0.1:8080")
	token := os.Getenv("KILN_TOKEN")
	model := &agent.Model{
		BaseURL:   env("KILN_MODEL_URL", "https://openrouter.ai/api/v1"),
		APIKey:    os.Getenv("KILN_MODEL_KEY"),
		Name:      os.Getenv("KILN_MODEL"),
		HTTP:      &http.Client{Timeout: 10 * time.Minute},
		RetryWait: 2 * time.Second,
	}
	if len(token) < 32 {
		return errors.New("KILN_TOKEN must be set to a random string of at least 32 characters")
	}
	if raw := os.Getenv("KILN_MODEL_PARAMS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &model.Params); err != nil {
			return fmt.Errorf("KILN_MODEL_PARAMS must be a JSON object: %w", err)
		}
		for _, reserved := range []string{"model", "messages", "tools"} {
			if _, ok := model.Params[reserved]; ok {
				return fmt.Errorf("KILN_MODEL_PARAMS must not set %q", reserved)
			}
		}
	}
	if model.Name == "" {
		return errors.New("KILN_MODEL must name a model served at KILN_MODEL_URL (" + model.BaseURL + ")")
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	unlock, err := lock(filepath.Join(dataDir, "kiln.lock"))
	if err != nil {
		return err
	}
	defer unlock()

	origins, err := loadOrigins(filepath.Join(dataDir, "origins.json"))
	if err != nil {
		return err
	}
	store, err := agent.OpenStore(filepath.Join(dataDir, "kiln.db"))
	if err != nil {
		return err
	}
	defer store.Close()

	// Adapters in route priority order. To add a channel, append it here. The
	// last entry reaches any user, so no message is ever without a route.
	var adapters []agent.Adapter
	if ad, err := slack.FromEnv(os.Getenv, log); err != nil {
		return err
	} else if ad != nil {
		adapters = append(adapters, ad)
	}
	if url := os.Getenv("KILN_OUTBOX_URL"); url != "" {
		adapters = append(adapters, agent.NewWebhook(url))
	} else {
		adapters = append(adapters, agent.NewWriter(os.Stdout))
	}
	names := make([]string, len(adapters))
	for i, ad := range adapters {
		names[i] = ad.Name()
	}
	a, err := agent.New(store, model, dataDir, origins, adapters, log)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	server := &http.Server{Addr: addr, Handler: a.Handler(token), ReadHeaderTimeout: 10 * time.Second}
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.ListenAndServe() }()

	loopsDone := make(chan struct{})
	go func() { a.Run(ctx); close(loopsDone) }()

	log.Info("kiln started", "addr", addr, "data", dataDir, "model", model.Name, "model_url", model.BaseURL,
		"adapters", strings.Join(names, ","), "origins", len(origins))

	select {
	case err := <-serverErr:
		stop()
		<-loopsDone
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
	<-loopsDone
	return nil
}

// lock takes an exclusive advisory lock so that two processes can never work
// the same inbox. The worker's one-run-per-user guarantee depends on it.
func lock(path string) (unlock func(), err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another kiln is already running on %s", filepath.Dir(path))
	}
	return func() { f.Close() }, nil
}

// loadOrigins reads the http_request allowlist: a JSON object mapping an
// origin to the headers added to its requests. A missing file means the agent
// has no HTTP access.
func loadOrigins(path string) (agent.Origins, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var file map[string]map[string]string
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	origins := agent.Origins{}
	for origin, headers := range file {
		normalized, err := agent.NormalizeOrigin(origin)
		if err != nil {
			return nil, fmt.Errorf("%s: %q: %w", path, origin, err)
		}
		origins[normalized] = headers
	}
	if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o077 != 0 && len(origins) > 0 {
		return nil, fmt.Errorf("%s holds credentials and must not be readable by group or others (chmod 600)", path)
	}
	return origins, nil
}
