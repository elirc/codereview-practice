package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"deliverydispatch/pkg/apperr"
)

// MaxBodyBytes is the largest request body DecodeJSON accepts.
const MaxBodyBytes = 1 << 20

// WriteJSON writes v as a JSON response with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// DecodeJSON decodes a required JSON object body into dst, rejecting unknown
// fields, trailing data and bodies over MaxBodyBytes.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	empty, err := decode(w, r, dst)
	if err != nil {
		return err
	}
	if empty {
		return apperr.Validation([]apperr.FieldError{{Path: "", Message: "request body is required"}})
	}
	return nil
}

// DecodeOptionalJSON is DecodeJSON for endpoints whose body may be omitted.
// It reports whether a body was present.
func DecodeOptionalJSON(w http.ResponseWriter, r *http.Request, dst any) (bool, error) {
	empty, err := decode(w, r, dst)
	if err != nil {
		return false, err
	}
	return !empty, nil
}

func decode(w http.ResponseWriter, r *http.Request, dst any) (bool, error) {
	if r.Body == nil || r.Body == http.NoBody {
		return true, nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return true, nil
		}
		return false, decodeError(err)
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		mt, _, err := mime.ParseMediaType(ct)
		if err != nil || mt != "application/json" {
			return false, apperr.New(apperr.KindUnsupportedMedia, "unsupported_media_type", "The request body must be application/json.")
		}
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return false, apperr.Validation([]apperr.FieldError{{Path: "", Message: "request body must contain a single JSON object"}})
	}
	return false, nil
}

func decodeError(err error) error {
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	var maxErr *http.MaxBytesError
	switch {
	case errors.As(err, &maxErr):
		return apperr.New(apperr.KindTooLarge, "payload_too_large", fmt.Sprintf("The request body must be at most %d bytes.", MaxBodyBytes))
	case errors.As(err, &syntaxErr), errors.Is(err, io.ErrUnexpectedEOF):
		return apperr.Validation([]apperr.FieldError{{Path: "", Message: "malformed JSON"}})
	case errors.As(err, &typeErr):
		return apperr.Validation([]apperr.FieldError{{Path: typeErr.Field, Message: "must be of type " + typeErr.Type.String()}})
	case strings.HasPrefix(err.Error(), "json: unknown field "):
		field := strings.Trim(strings.TrimPrefix(err.Error(), "json: unknown field "), `"`)
		return apperr.Validation([]apperr.FieldError{{Path: field, Message: "unknown field"}})
	default:
		return apperr.Validation([]apperr.FieldError{{Path: "", Message: "invalid JSON body"}})
	}
}
