// Package apperr defines the typed errors services return to the HTTP layer.
package apperr

import "fmt"

// Kind classifies an error for the HTTP status mapping.
type Kind int

// Error kinds.
const (
	KindInternal Kind = iota
	KindInvalid
	KindUnauthenticated
	KindForbidden
	KindNotFound
	KindConflict
	KindUnprocessable
	KindTooLarge
	KindUnsupportedMedia
)

// FieldError describes one invalid input field.
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Error is a failure with a stable code and a human-readable message.
type Error struct {
	Kind    Kind
	Code    string
	Message string
	Details map[string]any
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// New returns an Error of the given kind.
func New(kind Kind, code, message string) *Error {
	return &Error{Kind: kind, Code: code, Message: message}
}

// WithDetails returns a copy of e carrying details.
func (e *Error) WithDetails(details map[string]any) *Error {
	c := *e
	c.Details = details
	return &c
}

// NotFound reports a resource that does not exist or that the caller may not see.
func NotFound() *Error {
	return New(KindNotFound, "not_found", "The requested resource was not found.")
}

// Forbidden reports a caller whose role may not perform the action.
func Forbidden() *Error {
	return New(KindForbidden, "forbidden", "You are not allowed to perform this action.")
}

// Unauthenticated reports a missing or invalid bearer token.
func Unauthenticated() *Error {
	return New(KindUnauthenticated, "unauthenticated", "A valid bearer token is required.")
}

// Conflict reports a state conflict with the given code.
func Conflict(code, message string) *Error {
	return New(KindConflict, code, message)
}

// InvalidState reports an action that the resource's current state does not allow.
func InvalidState(message string) *Error {
	return New(KindConflict, "invalid_state", message)
}

// Unprocessable reports well-formed input that breaks a business rule.
func Unprocessable(code, message string) *Error {
	return New(KindUnprocessable, code, message)
}

// Validation reports schema-invalid input.
func Validation(fields []FieldError) *Error {
	return &Error{
		Kind:    KindInvalid,
		Code:    "validation_failed",
		Message: "The request is invalid.",
		Details: map[string]any{"fields": fields},
	}
}

// Fields collects field errors while a request is validated.
type Fields struct {
	list []FieldError
}

// Add records a failure for path.
func (f *Fields) Add(path, message string) {
	f.list = append(f.list, FieldError{Path: path, Message: message})
}

// Check records a failure for path when ok is false.
func (f *Fields) Check(ok bool, path, message string) {
	if !ok {
		f.Add(path, message)
	}
}

// Err returns a validation error when any failure was recorded, otherwise nil.
func (f *Fields) Err() error {
	if len(f.list) == 0 {
		return nil
	}
	return Validation(f.list)
}
