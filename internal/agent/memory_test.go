package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newMemory(t *testing.T) (*memory, string) {
	t.Helper()
	dir := t.TempDir()
	m, err := openMemory(dir, "ann")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.close)
	return m, dir
}

func TestOpenMemoryRejectsUnsafeUserIDs(t *testing.T) {
	dir := t.TempDir()
	for _, user := range []string{"", "..", "../ann", "a/b", "Ann", ".hidden", "a b", strings.Repeat("a", 65)} {
		if m, err := openMemory(dir, user); err == nil {
			m.close()
			t.Errorf("user id %q accepted", user)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("rejected ids left files behind: %v", entries)
	}
}

func TestMemoryCannotEscapeItsFolder(t *testing.T) {
	m, dir := newMemory(t)
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("credentials"), 0o600); err != nil {
		t.Fatal(err)
	}
	userDir := filepath.Join(dir, "users", "ann")
	if err := os.Symlink(secret, filepath.Join(userDir, "notes", "link.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir, filepath.Join(userDir, "notes", "up")); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"../../secret.txt", "notes/../../../secret.txt", secret, "notes/link.md", "notes/up/secret.txt"} {
		if got, err := m.read(path); err == nil {
			t.Errorf("read(%q) escaped: %q", path, got)
		}
	}
	for _, path := range []string{"../../secret.txt", "notes/../../../secret.txt", secret, "notes/up/secret.txt"} {
		if err := m.write(path, "overwritten"); err == nil {
			t.Errorf("write(%q) escaped", path)
		}
	}
	// Writing over a symlink replaces the link itself; the target stays untouched.
	if err := m.write("notes/link.md", "now a plain note"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(filepath.Join(userDir, "notes", "link.md")); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("link.md after write: %v, %v", info, err)
	}
	if _, err := m.list("notes/up"); err == nil {
		t.Error("list followed a symlink out of the folder")
	}
	if _, err := m.list(".."); err == nil {
		t.Error("list reached the parent directory")
	}
	if got, _ := os.ReadFile(secret); string(got) != "credentials" {
		t.Fatalf("file outside the folder was modified: %q", got)
	}
}

func TestMemoryWriteReadList(t *testing.T) {
	m, dir := newMemory(t)
	if ok, err := m.seeded(); err != nil || ok {
		t.Fatalf("fresh folder seeded=%v err=%v", ok, err)
	}
	if err := m.seed(); err != nil {
		t.Fatal(err)
	}
	if ok, _ := m.seeded(); !ok {
		t.Fatal("seed did not mark the folder seeded")
	}
	if err := m.write("notes/projects/acme.md", "issue: LIN-123\n"); err != nil {
		t.Fatal(err)
	}
	if err := m.write("notes/projects/acme.md", "issue: LIN-124\n"); err != nil {
		t.Fatal(err)
	}
	got, err := m.read("notes/projects/acme.md")
	if err != nil || got != "issue: LIN-124\n" {
		t.Fatalf("read = %q, %v", got, err)
	}
	names, err := m.list("notes/projects")
	if err != nil || len(names) != 1 || names[0] != "acme.md" {
		t.Fatalf("list = %v, %v (temp files must not linger)", names, err)
	}
	top, _ := m.list("")
	if strings.Join(top, " ") == "" || !contains(top, "notes/") || !contains(top, "instructions.md") {
		t.Fatalf("top-level list = %v", top)
	}
	info, err := os.Stat(filepath.Join(dir, "users", "ann", "notes", "projects", "acme.md"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("note mode = %v, %v", info.Mode(), err)
	}
	if _, err := m.read("notes"); err == nil {
		t.Error("reading a directory should fail and point at list_files")
	}
}

func TestMemoryBoundsReadsAndWrites(t *testing.T) {
	m, dir := newMemory(t)
	if err := m.write("notes/big.md", strings.Repeat("x", maxWriteBytes+1)); err == nil {
		t.Fatal("oversized write accepted")
	}
	big := filepath.Join(dir, "users", "ann", "notes", "big.md")
	if err := os.WriteFile(big, []byte(strings.Repeat("x", maxReadBytes+10)), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := m.read("notes/big.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "[truncated: first") || len(got) > maxReadBytes+200 {
		t.Fatalf("oversized read not clipped visibly: %d bytes, tail %q", len(got), got[len(got)-80:])
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
