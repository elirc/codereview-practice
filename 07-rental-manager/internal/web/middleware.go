package web

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/justinas/nosurf"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/store"
)

type ctxKey int

const (
	requestIDKey ctxKey = iota
	userKey
	sessionLoadedKey
)

const (
	sessionUserKey = "user_id"
	flashKey       = "flash"
	maxBodyBytes   = 1 << 20
)

func requestIDFrom(r *http.Request) string {
	id, _ := r.Context().Value(requestIDKey).(string)
	return id
}

func currentUser(r *http.Request) *auth.User {
	u, _ := r.Context().Value(userKey).(*auth.User)
	return u
}

// hasSession reports whether the session middleware has run for r; scs
// panics when session data is read outside of it.
func hasSession(r *http.Request) bool {
	return r.Context().Value(sessionLoadedKey) != nil
}

func (s *Server) logger(r *http.Request) *slog.Logger {
	return s.log.With("request_id", requestIDFrom(r))
}

func isHTMX(r *http.Request) bool {
	return r.Header.Get("HX-Request") == "true"
}

func isAPI(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/api/")
}

func validRequestID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.':
		default:
			return false
		}
	}
	return true
}

func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			b := make([]byte, 16)
			if _, err := rand.Read(b); err != nil {
				id = fmt.Sprintf("t%x", s.clock.Now().UnixNano())
			} else {
				id = hex.EncodeToString(b)
			}
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusRecorder) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

func (w *statusRecorder) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		s.logger(r).Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"bytes", rec.bytes,
			"duration_ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			p := recover()
			if p == nil {
				return
			}
			if p == http.ErrAbortHandler {
				panic(p)
			}
			s.logger(r).Error("panic serving request", "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
			s.respondError(w, r, response{status: http.StatusInternalServerError, code: codeInternal, message: messageInternal})
		}()
		next.ServeHTTP(w, r)
	})
}

func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) csrf(next http.Handler) http.Handler {
	h := nosurf.New(next)
	h.SetBaseCookie(http.Cookie{
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.Production(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   12 * 60 * 60,
	})
	h.SetFailureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.logger(r).Warn("csrf check failed", "reason", fmt.Sprint(nosurf.Reason(r)))
		s.fail(w, r, errCSRF)
	}))
	return h
}

func (s *Server) loadUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(context.WithValue(r.Context(), sessionLoadedKey, true))
		raw := s.sessions.GetString(r.Context(), sessionUserKey)
		if raw == "" {
			next.ServeHTTP(w, r)
			return
		}
		if id, err := store.ParseUUID(raw); err == nil {
			u, err := s.users.Get(r.Context(), id)
			if err != nil && !errors.Is(err, auth.ErrUserNotFound) {
				s.fail(w, r, err)
				return
			}
			if err == nil && u.Active {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, &u)))
				return
			}
		}
		// The account was removed or deactivated after this session began.
		s.sessions.Remove(r.Context(), sessionUserKey)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r) == nil {
			s.fail(w, r, errUnauthenticated)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) require(p auth.Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if u := currentUser(r); u == nil || !u.Role.Can(p) {
				s.fail(w, r, errForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) actor(r *http.Request) auth.Actor {
	if u := currentUser(r); u != nil {
		return u.Actor()
	}
	return auth.Actor{}
}

func (s *Server) flash(r *http.Request, message string) {
	s.sessions.Put(r.Context(), flashKey, message)
}
