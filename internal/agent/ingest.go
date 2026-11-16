package agent

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxPayloadBytes = 1 << 20

var sourcePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// Handler is the ingestion surface. POST /inbox/{user} authenticates, does one
// INSERT, and acknowledges; every check that needs thought happens later,
// inside the run, so a slow agent never makes a webhook provider retry.
//
// The body is the event text. ?source= labels where it came from and defaults
// to "user"; only user events carry instructions or answer approvals.
func (a *Agent) Handler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := a.store.db.PingContext(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("POST /inbox/{user}", func(w http.ResponseWriter, r *http.Request) {
		presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(presented), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		user := r.PathValue("user")
		if !userIDPattern.MatchString(user) {
			http.Error(w, "invalid user id", http.StatusBadRequest)
			return
		}
		source := r.URL.Query().Get("source")
		if source == "" {
			source = SourceUser
		}
		if !sourcePattern.MatchString(source) || source == SourceTimer || source == SourceTask {
			http.Error(w, "invalid source", http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPayloadBytes))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "unreadable body", http.StatusBadRequest)
			return
		}
		if !utf8.Valid(body) || strings.TrimSpace(string(body)) == "" {
			http.Error(w, "body must be non-empty UTF-8 text", http.StatusBadRequest)
			return
		}
		id, _, err := a.store.AddEvent(r.Context(), Inbound{User: user, Source: source, Text: string(body)}, a.now())
		if err != nil {
			a.log.Error("event not recorded", "user", user, "source", source, "err", err)
			http.Error(w, "event not recorded", http.StatusInternalServerError)
			return
		}
		a.log.Info("event accepted", "event", id, "user", user, "source", source, "bytes", len(body))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]int64{"id": id})
	})
	return mux
}
