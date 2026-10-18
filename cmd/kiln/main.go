package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/madebywelch/kiln/internal/factory"
	"gopkg.in/yaml.v3"
)

var version = "dev"

type config struct {
	MCP              map[string]factory.MCPServer       `yaml:"mcp_servers"`
	Listen           string                             `yaml:"listen"`
	DataDir          string                             `yaml:"data_dir"`
	Workers          int                                `yaml:"workers"`
	TokenEnv         string                             `yaml:"token_env"`
	WebhookSecretEnv string                             `yaml:"webhook_secret_env"`
	AllowLocal       bool                               `yaml:"allow_local_repositories"`
	InheritEnv       []string                           `yaml:"inherit_env"`
	CacheDirs        []string                           `yaml:"cache_dirs"`
	Providers        map[string]factory.Provider        `yaml:"providers"`
	Sandboxes        map[string]factory.SandboxProvider `yaml:"sandboxes"`
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(os.Args[1:]); err != nil {
		slog.Error("kiln stopped", "error", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: kiln serve [-config server.yaml] | validate workflow.yaml | openapi | version")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "validate":
		if len(args) != 2 {
			return errors.New("usage: kiln validate workflow.yaml")
		}
		data, err := os.ReadFile(args[1])
		if err != nil {
			return err
		}
		w, err := factory.ParseWorkflow(data)
		if err != nil {
			return err
		}
		fmt.Printf("%s: valid (%d nodes, max %d steps)\n", w.Name, len(w.Nodes), w.MaxSteps)
		return nil
	case "openapi":
		dir, err := os.MkdirTemp("", "kiln-schema-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		s, err := factory.OpenStore(dir)
		if err != nil {
			return err
		}
		defer s.Close()
		e, err := factory.NewEngine(s, &factory.Executor{Root: dir}, 1)
		if err != nil {
			return err
		}
		handler := factory.NewAPI(e, factory.APIConfig{})
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", "/openapi.json", nil))
		if recorder.Code != 200 {
			return fmt.Errorf("schema generation failed: %d", recorder.Code)
		}
		_, err = os.Stdout.Write(recorder.Body.Bytes())
		return err
	case "serve":
		return serve(args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	path := flags.String("config", "", "server YAML configuration")
	insecure := flags.Bool("insecure-local", false, "allow unauthenticated loopback development access")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	cfg := config{Listen: "127.0.0.1:8741", DataDir: ".kiln", Workers: 4, TokenEnv: "KILN_TOKEN", WebhookSecretEnv: "KILN_GITHUB_WEBHOOK_SECRET"}
	if *path != "" {
		data, err := os.ReadFile(*path)
		if err != nil {
			return err
		}
		d := yaml.NewDecoder(bytes.NewReader(data))
		d.KnownFields(true)
		if err := d.Decode(&cfg); err != nil {
			return err
		}
		var extra any
		if err := d.Decode(&extra); err != io.EOF {
			return errors.New("expected exactly one server YAML document")
		}
	}
	if err := factory.ValidateProviders(cfg.Providers); err != nil {
		return err
	}
	if err := factory.ValidateMCP(cfg.MCP); err != nil {
		return err
	}
	if err := factory.ValidateEnvironment(cfg.InheritEnv, cfg.CacheDirs); err != nil {
		return err
	}
	if err := factory.ValidateSandboxes(cfg.Sandboxes); err != nil {
		return err
	}
	token := os.Getenv(cfg.TokenEnv)
	if *insecure {
		host, _, err := net.SplitHostPort(cfg.Listen)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return errors.New("-insecure-local requires a loopback listener")
		}
		if token == "" {
			slog.Warn("authentication disabled for local development; do not expose this listener")
		}
	} else if len(token) < 32 {
		return fmt.Errorf("%s must contain a bearer token of at least 32 characters", cfg.TokenEnv)
	}
	dir, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return err
	}
	// State, captured output, and SQLite sidecar files may contain private code.
	syscall.Umask(0077)
	for _, cache := range cfg.CacheDirs {
		if err := os.MkdirAll(cache, 0700); err != nil {
			return fmt.Errorf("cache_dirs: %w", err)
		}
	}
	store, err := factory.OpenStore(dir)
	if err != nil {
		return err
	}
	defer store.Close()
	engine, err := factory.NewEngine(store, &factory.Executor{Root: dir, Providers: cfg.Providers, Sandboxes: cfg.Sandboxes, MCP: cfg.MCP, AllowLocal: cfg.AllowLocal, InheritEnv: cfg.InheritEnv, CacheDirs: cfg.CacheDirs}, cfg.Workers)
	if err != nil {
		return err
	}
	handler := factory.NewAPI(engine, factory.APIConfig{Token: token, WebhookSecret: os.Getenv(cfg.WebhookSecretEnv)})
	server := &http.Server{Addr: cfg.Listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	engine.Start()
	errs := make(chan error, 1)
	go func() { errs <- server.Serve(listener) }()
	slog.Info("kiln listening", "address", listener.Addr().String(), "data_dir", dir, "workers", cfg.Workers, "version", version)
	select {
	case <-ctx.Done():
	case err = <-errs:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		if shutdownErr := server.Shutdown(shutdownCtx); shutdownErr != nil {
			_ = server.Close()
			slog.Warn("HTTP shutdown forced", "error", shutdownErr)
		}
	}()
	engine.Close()
	<-shutdownDone
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
