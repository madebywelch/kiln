package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIInvalidArgumentsAndValidation(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"validate"}, {"serve", "unexpected"}, {"serve", "-unknown"}} {
		if err := run(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	path := filepath.Join(t.TempDir(), "workflow.yaml")
	if err := os.WriteFile(path, []byte("version: 2\nname: broken\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"validate", path}); err == nil {
		t.Fatal("accepted invalid workflow")
	}
	if err := run([]string{"validate", "../../examples/retry.yaml"}); err != nil {
		t.Fatal(err)
	}
}
func TestServerRejectsUnsafeOrMalformedConfiguration(t *testing.T) {
	t.Setenv("KILN_TOKEN", "")
	if err := serve(nil); err == nil || !strings.Contains(err.Error(), "32 characters") {
		t.Fatalf("missing authentication allowed: %v", err)
	}
	for _, tc := range []struct {
		yaml string
		args []string
	}{
		{"listen: 0.0.0.0:8741\n", []string{"-insecure-local"}},
		{"unknown: true\n", nil},
		{"listen: localhost:8741\n---\nlisten: localhost:8742\n", nil},
		{"providers:\n  bad:\n    url: file:///tmp/socket\n", nil},
		{"inherit_env: [HOME]\n", nil},
		{"cache_dirs: [cache]\n", nil},
	} {
		path := filepath.Join(t.TempDir(), "server.yaml")
		if err := os.WriteFile(path, []byte(tc.yaml), 0600); err != nil {
			t.Fatal(err)
		}
		if err := serve(append([]string{"-config", path}, tc.args...)); err == nil {
			t.Fatalf("accepted %s", tc.yaml)
		}
	}
}
