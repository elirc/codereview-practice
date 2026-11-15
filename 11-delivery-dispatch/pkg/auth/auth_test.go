package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/logging"
)

var testSecret = []byte("test-secret-test-secret-test-secret")

func TestVerifyAcceptsMintedTokens(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	v := NewVerifier(testSecret, clock.NewManual(now))
	rid := uuid.New()
	tests := []struct {
		name string
		p    Principal
	}{
		{"customer", Principal{Subject: uuid.New(), Role: RoleCustomer}},
		{"restaurant", Principal{Subject: uuid.New(), Role: RoleRestaurant, RestaurantID: uuid.NullUUID{UUID: rid, Valid: true}}},
		{"courier", Principal{Subject: uuid.New(), Role: RoleCourier}},
		{"ops", Principal{Subject: uuid.New(), Role: RoleOps}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := Mint(testSecret, tt.p, now.Add(time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			got, err := v.Verify(raw)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			if got != tt.p {
				t.Fatalf("got %+v, want %+v", got, tt.p)
			}
		})
	}
}

func TestVerifyRejectsBadTokens(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	v := NewVerifier(testSecret, clock.NewManual(now))
	valid := Principal{Subject: uuid.New(), Role: RoleCustomer}

	expired, _ := Mint(testSecret, valid, now.Add(-time.Second))
	atExpiry, _ := Mint(testSecret, valid, now)
	wrongKey, _ := Mint([]byte("another-secret-another-secret-xx"), valid, now.Add(time.Hour))
	noRestaurant := signRaw(t, tokenClaims{Role: "restaurant", RegisteredClaims: jwt.RegisteredClaims{Subject: uuid.NewString(), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour))}})
	badRole := signRaw(t, tokenClaims{Role: "admin", RegisteredClaims: jwt.RegisteredClaims{Subject: uuid.NewString(), ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour))}})
	badSubject := signRaw(t, tokenClaims{Role: "ops", RegisteredClaims: jwt.RegisteredClaims{Subject: "ops-1", ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour))}})

	tests := map[string]string{
		"expired":                     expired,
		"expiring now":                atExpiry,
		"wrong key":                   wrongKey,
		"restaurant without id":       noRestaurant,
		"unknown role":                badRole,
		"non-uuid subject":            badSubject,
		"garbage":                     "not-a-token",
		"none algorithm is not valid": "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.",
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := v.Verify(raw); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestVerifyAcceptsPreviousSecretDuringRotation(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	previous := []byte("previous-secret-previous-secret-xx")
	v := NewVerifier(testSecret, clock.NewManual(now), previous, nil)
	p := Principal{Subject: uuid.New(), Role: RoleCourier}

	tests := []struct {
		name   string
		secret []byte
		ok     bool
	}{
		{"current secret", testSecret, true},
		{"previous secret", previous, true},
		{"unknown secret", []byte("unknown-secret-unknown-secret-xxx"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := Mint(tt.secret, p, now.Add(time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			got, err := v.Verify(raw)
			if tt.ok && (err != nil || got != p) {
				t.Fatalf("Verify = %+v, %v", got, err)
			}
			if !tt.ok && err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func signRaw(t *testing.T, c tokenClaims) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestMiddlewareAndRequire(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	v := NewVerifier(testSecret, clock.NewManual(now))
	courier := Principal{Subject: uuid.New(), Role: RoleCourier}
	token, _ := Mint(testSecret, courier, now.Add(time.Hour))

	h := Middleware(v, logging.Discard())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := Require(r.Context(), RoleOps); err == nil {
			t.Error("courier passed an ops-only check")
		}
		p, err := Require(r.Context(), RoleCourier, RoleOps)
		if err != nil || p.Subject != courier.Subject {
			t.Errorf("Require = %+v, %v", p, err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	tests := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong scheme", "Basic " + token, http.StatusUnauthorized},
		{"bad token", "Bearer nope", http.StatusUnauthorized},
		{"valid", "Bearer " + token, http.StatusNoContent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
		})
	}
}
