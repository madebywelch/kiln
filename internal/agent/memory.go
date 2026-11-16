package agent

import (
	"crypto/rand"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	instructionsFile = "instructions.md"
	indexFile        = "index.md"
	notesDir         = "notes"
	transcriptsDir   = "transcripts"

	maxReadBytes  = 256 << 10
	maxWriteBytes = 256 << 10
)

//go:embed default_instructions.md
var defaultInstructions string

const defaultIndex = "# Index\n\nOne line per note: `notes/<file>.md`, then one sentence saying what it holds.\n"

// userIDPattern keeps a user id safe to use as a directory name.
var userIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// memory is one user's folder. All access goes through an os.Root, so no path
// the model supplies can reach outside it, by "..", absolute path, or symlink.
type memory struct{ root *os.Root }

// openMemory opens the user's folder, creating it on first use.
func openMemory(dataDir, user string) (*memory, error) {
	if !userIDPattern.MatchString(user) {
		return nil, fmt.Errorf("invalid user id %q", user)
	}
	dir := filepath.Join(dataDir, "users", user)
	for _, sub := range []string{notesDir, transcriptsDir} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			return nil, err
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &memory{root: root}, nil
}

func (m *memory) close() { m.root.Close() }

// seeded reports whether the folder has its starting files. instructions.md is
// written last by seed, so its presence marks first-use setup as complete.
func (m *memory) seeded() (bool, error) {
	_, err := m.root.Stat(instructionsFile)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (m *memory) seed() error {
	if err := m.write(indexFile, defaultIndex); err != nil {
		return err
	}
	return m.write(instructionsFile, defaultInstructions)
}

// read returns a file's text, clipped to maxReadBytes with a visible marker.
func (m *memory) read(name string) (string, error) {
	f, err := m.root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory; use list_files", name)
	}
	data, err := io.ReadAll(io.LimitReader(f, maxReadBytes))
	if err != nil {
		return "", err
	}
	if info.Size() > maxReadBytes {
		return fmt.Sprintf("%s\n[truncated: first %d of %d bytes shown]", strings.ToValidUTF8(string(data), ""), maxReadBytes, info.Size()), nil
	}
	return string(data), nil
}

// write replaces a file atomically, creating parent directories as needed.
func (m *memory) write(name, content string) error {
	if len(content) > maxWriteBytes {
		return fmt.Errorf("content is %d bytes; the limit is %d", len(content), maxWriteBytes)
	}
	name = path.Clean(filepath.ToSlash(name))
	if dir := path.Dir(name); dir != "." {
		if err := m.root.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	tmp := name + ".tmp-" + rand.Text()
	if err := m.root.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	if err := m.root.Rename(tmp, name); err != nil {
		m.root.Remove(tmp)
		return err
	}
	return nil
}

// list returns the entries of a directory, directories marked with a trailing slash.
func (m *memory) list(dir string) ([]string, error) {
	if dir == "" {
		dir = "."
	}
	f, err := m.root.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries, err := f.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			name += "/"
		}
		names = append(names, name)
	}
	return names, nil
}
