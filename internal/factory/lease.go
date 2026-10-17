package factory

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

type processLeaseKey struct{}

// The open file description is inherited by subprocesses. Closing the daemon's
// descriptor does not release the lease while a child still holds its copy.
// Do not issue LOCK_UN here: that would unlock every inherited descriptor.
func acquireLease(root, id string) (*os.File, error) {
	dir := filepath.Join(root, "leases")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, id+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	// Concurrent fork/exec can briefly inherit even close-on-exec descriptors.
	// Allow those copies to close before declaring a surviving process conflict.
	deadline := time.Now().Add(250 * time.Millisecond)
	for {
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			f.Close()
			return nil, err
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("%w: execution lease is held; inspect and stop surviving processes before retry or cleanup", ErrConflict)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
