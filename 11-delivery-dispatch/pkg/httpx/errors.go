package httpx

import (
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"

	"deliverydispatch/pkg/apperr"
)

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details"`
	RequestID string         `json:"requestId"`
}

// StatusFor returns the HTTP status for an error kind.
func StatusFor(kind apperr.Kind) int {
	switch kind {
	case apperr.KindInvalid:
		return http.StatusBadRequest
	case apperr.KindUnauthenticated:
		return http.StatusUnauthorized
	case apperr.KindForbidden:
		return http.StatusForbidden
	case apperr.KindNotFound:
		return http.StatusNotFound
	case apperr.KindConflict:
		return http.StatusConflict
	case apperr.KindUnprocessable:
		return http.StatusUnprocessableEntity
	case apperr.KindTooLarge:
		return http.StatusRequestEntityTooLarge
	case apperr.KindUnsupportedMedia:
		return http.StatusUnsupportedMediaType
	default:
		return http.StatusInternalServerError
	}
}

// WriteError writes err as the JSON error envelope. Errors that are not
// *apperr.Error are logged with a stack trace and reported as internal_error.
func WriteError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		logger.ErrorContext(r.Context(), "request failed",
			"error", err.Error(),
			"request_id", RequestIDFrom(r.Context()),
			"method", r.Method,
			"path", r.URL.Path,
			"stack", string(debug.Stack()),
		)
		ae = apperr.New(apperr.KindInternal, "internal_error", "An unexpected error occurred.")
	}
	details := ae.Details
	if details == nil {
		details = map[string]any{}
	}
	WriteJSON(w, StatusFor(ae.Kind), errorEnvelope{Error: errorBody{
		Code:      ae.Code,
		Message:   ae.Message,
		Details:   details,
		RequestID: RequestIDFrom(r.Context()),
	}})
}

// HandlerFunc is an HTTP handler that reports failures by returning an error.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Wrap adapts fn to http.HandlerFunc, sending any returned error through WriteError.
func Wrap(logger *slog.Logger, fn HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			WriteError(w, r, logger, err)
		}
	}
}
