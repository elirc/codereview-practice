// Package apperr defines the errors that domain code returns for expected
// failures. The web layer maps them to responses in one place.
package apperr

import "strings"

// Kind classifies an Error for the transport layer.
type Kind int

// Error kinds.
const (
	KindNotFound Kind = iota + 1
	KindConflict
	KindForbidden
	KindRule
	KindUnauthenticated
	KindBadRequest
)

// Error is an expected failure with a stable code and a message that is
// safe to show to users.
type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

// NotFound returns an error for a missing (or hidden) resource.
func NotFound(code, message string) *Error {
	return &Error{Kind: KindNotFound, Code: code, Message: message}
}

// Conflict returns an error for a state or concurrency conflict.
func Conflict(code, message string) *Error {
	return &Error{Kind: KindConflict, Code: code, Message: message}
}

// Forbidden returns an error for an authenticated user lacking permission.
func Forbidden(code, message string) *Error {
	return &Error{Kind: KindForbidden, Code: code, Message: message}
}

// Rule returns an error for well-formed input that breaks a business rule.
func Rule(code, message string) *Error {
	return &Error{Kind: KindRule, Code: code, Message: message}
}

// Unauthenticated returns an error for a request without a valid session.
func Unauthenticated(code, message string) *Error {
	return &Error{Kind: KindUnauthenticated, Code: code, Message: message}
}

// BadRequest returns an error for input that cannot be parsed at all.
func BadRequest(code, message string) *Error {
	return &Error{Kind: KindBadRequest, Code: code, Message: message}
}

// FieldError is a validation problem with one input field.
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ValidationError collects field problems found while parsing input.
type ValidationError struct {
	Fields []FieldError
}

func (e *ValidationError) Error() string {
	parts := make([]string, len(e.Fields))
	for i, f := range e.Fields {
		parts[i] = f.Path + " " + f.Message
	}
	return "validation failed: " + strings.Join(parts, "; ")
}

// Add records a problem with path. Only the first problem per path is kept.
func (e *ValidationError) Add(path, message string) {
	if e.Has(path) {
		return
	}
	e.Fields = append(e.Fields, FieldError{Path: path, Message: message})
}

// Has reports whether path already has a problem.
func (e *ValidationError) Has(path string) bool {
	for _, f := range e.Fields {
		if f.Path == path {
			return true
		}
	}
	return false
}

// Map returns the problems keyed by path, for rendering next to fields.
func (e *ValidationError) Map() map[string]string {
	m := make(map[string]string, len(e.Fields))
	for _, f := range e.Fields {
		m[f.Path] = f.Message
	}
	return m
}

// Err returns e when it holds any problem and nil otherwise.
func (e *ValidationError) Err() error {
	if len(e.Fields) == 0 {
		return nil
	}
	return e
}
