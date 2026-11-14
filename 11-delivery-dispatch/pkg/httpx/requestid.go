// Package httpx holds the HTTP plumbing shared by the services: request ids,
// JSON decoding and encoding, the error envelope and common middleware.
package httpx

import (
	"context"
	"net/http"

	"deliverydispatch/pkg/idgen"
)

// HeaderRequestID is the header that carries the request id in and out.
const HeaderRequestID = "X-Request-Id"

type ctxKey int

const requestIDKey ctxKey = iota

// WithRequestID returns a context carrying id as the request id.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestIDFrom returns the request id stored in ctx, or "".
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// RequestID accepts an inbound X-Request-Id when it is well formed, otherwise
// generates one, and exposes it on the context and the response.
func RequestID(ids idgen.Generator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get(HeaderRequestID)
			if !validRequestID(id) {
				id = ids.NewID().String()
			}
			w.Header().Set(HeaderRequestID, id)
			next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), id)))
		})
	}
}

func validRequestID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-', c == '_', c == '.', c == ':':
		default:
			return false
		}
	}
	return true
}
