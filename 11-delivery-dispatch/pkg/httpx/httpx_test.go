package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/logging"
)

type envelopeBody struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		Details   map[string]any `json:"details"`
		RequestID string         `json:"requestId"`
	} `json:"error"`
}

func TestWriteErrorMapsKindsToStatuses(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{apperr.NotFound(), http.StatusNotFound, "not_found"},
		{apperr.Forbidden(), http.StatusForbidden, "forbidden"},
		{apperr.Unauthenticated(), http.StatusUnauthorized, "unauthenticated"},
		{apperr.Conflict("offer_expired", "x"), http.StatusConflict, "offer_expired"},
		{apperr.Unprocessable("quote_expired", "x"), http.StatusUnprocessableEntity, "quote_expired"},
		{apperr.Validation(nil), http.StatusBadRequest, "validation_failed"},
		{errors.New("connection reset"), http.StatusInternalServerError, "internal_error"},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req = req.WithContext(WithRequestID(req.Context(), "req-1"))
			rec := httptest.NewRecorder()
			WriteError(rec, req, logging.Discard(), tt.err)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d", rec.Code, tt.status)
			}
			var body envelopeBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Error.Code != tt.code || body.Error.RequestID != "req-1" || body.Error.Details == nil {
				t.Fatalf("body = %+v", body)
			}
			if tt.status == http.StatusInternalServerError && strings.Contains(rec.Body.String(), "connection reset") {
				t.Fatal("internal error text leaked to the client")
			}
		})
	}
}

func TestRequestIDKeepsValidInboundValues(t *testing.T) {
	fixed := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	mw := RequestID(idgen.NewSequence(fixed, fixed))
	var seen string
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = RequestIDFrom(r.Context())
	}))

	tests := []struct {
		inbound string
		want    string
	}{
		{"abc-123", "abc-123"},
		{"has spaces", fixed.String()},
		{"", fixed.String()},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if tt.inbound != "" {
			req.Header.Set(HeaderRequestID, tt.inbound)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if seen != tt.want || rec.Header().Get(HeaderRequestID) != tt.want {
			t.Fatalf("inbound %q: got %q / %q, want %q", tt.inbound, seen, rec.Header().Get(HeaderRequestID), tt.want)
		}
	}
}

func TestDecodeJSON(t *testing.T) {
	type payload struct {
		Name string `json:"name"`
		N    int    `json:"n"`
	}
	tests := []struct {
		name string
		body string
		ct   string
		code string
	}{
		{"valid", `{"name":"a","n":1}`, "application/json", ""},
		{"unknown field", `{"name":"a","extra":1}`, "application/json", "validation_failed"},
		{"wrong type", `{"n":"one"}`, "application/json", "validation_failed"},
		{"malformed", `{"name":`, "application/json", "validation_failed"},
		{"trailing data", `{"name":"a"} {}`, "application/json", "validation_failed"},
		{"empty", ``, "application/json", "validation_failed"},
		{"wrong content type", `{"name":"a"}`, "text/plain", "unsupported_media_type"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", tt.ct)
			var p payload
			err := DecodeJSON(httptest.NewRecorder(), req, &p)
			if tt.code == "" {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
				return
			}
			var ae *apperr.Error
			if !errors.As(err, &ae) || ae.Code != tt.code {
				t.Fatalf("err = %v, want code %s", err, tt.code)
			}
		})
	}
}

func TestDecodeOptionalJSONAllowsEmptyBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	var dst struct{}
	present, err := DecodeOptionalJSON(httptest.NewRecorder(), req, &dst)
	if err != nil || present {
		t.Fatalf("present=%v err=%v", present, err)
	}
}
