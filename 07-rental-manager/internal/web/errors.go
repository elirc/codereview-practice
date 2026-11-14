package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"runtime/debug"

	"rentalmanager/internal/apperr"
)

const (
	codeInternal    = "internal_error"
	messageInternal = "Something went wrong. Please try again."
)

var (
	errUnauthenticated = apperr.Unauthenticated("unauthenticated", "Sign in to continue.")
	errForbidden       = apperr.Forbidden("forbidden", "You do not have permission to do that.")
	errNotFound        = apperr.NotFound("not_found", "The page you asked for does not exist.")
	errCSRF            = apperr.Forbidden("csrf_failed", "This form has expired. Reload the page and try again.")
	errMalformed       = apperr.BadRequest("malformed_request", "The request could not be read.")
)

// errorView is what error pages and fragments render.
type errorView struct {
	Status  int
	Code    string
	Message string
	Fields  []apperr.FieldError
}

type response struct {
	status  int
	code    string
	message string
	fields  []apperr.FieldError
}

// classify maps an error to the response the client receives. It is the
// only place where domain errors become HTTP statuses.
func classify(err error) (response, bool) {
	var ve *apperr.ValidationError
	if errors.As(err, &ve) {
		return response{
			status:  http.StatusBadRequest,
			code:    "validation_failed",
			message: "Some fields are invalid.",
			fields:  ve.Fields,
		}, true
	}

	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return response{status: http.StatusRequestEntityTooLarge, code: "payload_too_large", message: "The request body is too large."}, true
	}

	var ae *apperr.Error
	if errors.As(err, &ae) {
		status := http.StatusInternalServerError
		switch ae.Kind {
		case apperr.KindBadRequest:
			status = http.StatusBadRequest
		case apperr.KindUnauthenticated:
			status = http.StatusUnauthorized
		case apperr.KindForbidden:
			status = http.StatusForbidden
		case apperr.KindNotFound:
			status = http.StatusNotFound
		case apperr.KindConflict:
			status = http.StatusConflict
		case apperr.KindRule:
			status = http.StatusUnprocessableEntity
		}
		return response{status: status, code: ae.Code, message: ae.Message}, true
	}

	return response{status: http.StatusInternalServerError, code: codeInternal, message: messageInternal}, false
}

// fail logs err and writes the matching error response for the kind of
// request: a JSON envelope for the API, a fragment for htmx, a page
// otherwise.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	resp, expected := classify(err)
	if expected {
		s.logger(r).Info("request rejected", "status", resp.status, "code", resp.code)
	} else {
		s.logger(r).Error("request failed", "error", err, "stack", string(debug.Stack()))
	}
	s.respondError(w, r, resp)
}

func (s *Server) respondError(w http.ResponseWriter, r *http.Request, resp response) {
	switch {
	case isAPI(r):
		s.writeErrorJSON(w, r, resp)
	case resp.status == http.StatusUnauthorized && isHTMX(r):
		w.Header().Set("HX-Redirect", "/login")
		w.WriteHeader(http.StatusUnauthorized)
	case resp.status == http.StatusUnauthorized:
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	default:
		if resp.status == http.StatusBadRequest && len(resp.fields) > 0 {
			resp.status = http.StatusUnprocessableEntity
		}
		v := s.newView(r, "Error", errorView{Status: resp.status, Code: resp.code, Message: resp.message, Fields: resp.fields})
		if isHTMX(r) {
			w.Header().Set("HX-Retarget", "#flash")
			w.Header().Set("HX-Reswap", "innerHTML")
			s.renderFragment(w, r, resp.status, "error.html", "error_message", v)
			return
		}
		s.render(w, r, resp.status, "error.html", v)
	}
}

type errorBody struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details,omitempty"`
	RequestID string         `json:"requestId"`
}

func (s *Server) writeErrorJSON(w http.ResponseWriter, r *http.Request, resp response) {
	body := errorBody{Code: resp.code, Message: resp.message, RequestID: requestIDFrom(r)}
	if len(resp.fields) > 0 {
		body.Details = map[string]any{"fields": resp.fields}
	}
	s.writeJSON(w, r, resp.status, map[string]errorBody{"error": body})
}

func (s *Server) writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		s.logger(r).Error("encoding json response", "error", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(append(payload, '\n')); err != nil {
		s.logger(r).Debug("writing json response", "error", err)
	}
}
