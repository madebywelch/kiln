package factory

import (
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
)

func (e *Engine) transcript(w http.ResponseWriter, req *http.Request) {
	r, err := e.GetRun(req.PathValue("id"))
	if err != nil {
		status := 500
		if errors.Is(err, ErrNotFound) {
			status = 404
		}
		writeJSON(w, status, map[string]string{"error": "run unavailable"})
		return
	}
	for _, a := range r.Attempts {
		if a.ID != req.PathValue("attempt") || a.Transcript == "" {
			continue
		}
		root, err := os.OpenRoot(e.exec.Root)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "artifact storage unavailable"})
			return
		}
		defer root.Close()
		f, err := root.Open(a.Transcript)
		if err != nil {
			status := 500
			if os.IsNotExist(err) {
				status = 404
			}
			writeJSON(w, status, map[string]string{"error": "transcript unavailable"})
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "transcript unavailable"})
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Content-Disposition", "attachment; filename="+a.ID+".jsonl")
		http.ServeContent(w, req, a.ID+".jsonl", info.ModTime(), f)
		return
	}
	writeJSON(w, 404, map[string]string{"error": "attempt transcript not found"})
}

func (e *Engine) artifact(w http.ResponseWriter, req *http.Request) {
	r, err := e.GetRun(req.PathValue("id"))
	if err != nil {
		status := 500
		if errors.Is(err, ErrNotFound) {
			status = 404
		}
		writeJSON(w, status, map[string]string{"error": "run unavailable"})
		return
	}
	state, err := os.OpenRoot(e.exec.Root)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "storage unavailable"})
		return
	}
	defer state.Close()
	root, err := state.OpenRoot(filepath.Join("artifacts", r.ID))
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "artifact unavailable"})
		return
	}
	defer root.Close()
	name := req.PathValue("path")
	info, err := root.Stat(name)
	if err != nil || !info.Mode().IsRegular() {
		writeJSON(w, 404, map[string]string{"error": "artifact unavailable"})
		return
	}
	f, err := root.Open(name)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "artifact unavailable"})
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(name)}))
	http.ServeContent(w, req, name, info.ModTime(), f)
}
