package httpx

import (
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// AccessLog logs one line per request with its status and duration.
func AccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			logger.InfoContext(r.Context(), "request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"duration_ms", time.Since(start).Milliseconds(),
				"request_id", RequestIDFrom(r.Context()),
			)
		})
	}
}

// Recover turns a panic in a handler into a logged internal_error response.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				logger.ErrorContext(r.Context(), "handler panicked",
					"panic", fmt.Sprint(rec),
					"request_id", RequestIDFrom(r.Context()),
					"stack", string(debug.Stack()),
				)
				WriteError(w, r, logger, apperr.New(apperr.KindInternal, "internal_error", "An unexpected error occurred."))
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// NotFoundHandler answers unknown routes with the not_found envelope.
func NotFoundHandler(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, logger, apperr.NotFound())
	}
}

// MethodNotAllowedHandler answers known routes called with the wrong method.
func MethodNotAllowedHandler(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, logger, apperr.New(apperr.KindInvalid, "method_not_allowed", "The method is not allowed for this resource."))
	}
}

// ParseUUID parses a path or query value named name as a UUID.
func ParseUUID(name, value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil {
		return uuid.Nil, apperr.Validation([]apperr.FieldError{{Path: name, Message: "must be a UUID"}})
	}
	return id, nil
}

// Health answers liveness probes.
func Health(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
