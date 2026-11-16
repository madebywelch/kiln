package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLockExcludesASecondProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kiln.lock")
	unlock, err := lock(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lock(path); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("second lock: %v", err)
	}
	unlock()
	again, err := lock(path)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	again()
}

func TestLoadOrigins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "origins.json")

	origins, err := loadOrigins(path)
	if err != nil || origins != nil {
		t.Fatalf("missing file: %v, %v", origins, err)
	}

	write := func(content string, mode os.FileMode) {
		t.Helper()
		os.Remove(path)
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}

	write(`{"HTTPS://API.Example.com/": {"Authorization": "Bearer x"}, "https://status.example.com": {}}`, 0o600)
	origins, err = loadOrigins(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(origins) != 2 || origins["https://api.example.com"]["Authorization"] != "Bearer x" {
		t.Fatalf("origins = %v", origins)
	}

	write(`{"https://api.example.com": {"Authorization": "Bearer x"}}`, 0o644)
	if _, err := loadOrigins(path); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("world-readable credentials accepted: %v", err)
	}

	for _, bad := range []string{`{"api.example.com": {}}`, `{"https://api.example.com/v1": {}}`, `not json`} {
		write(bad, 0o600)
		if _, err := loadOrigins(path); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
