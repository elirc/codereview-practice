// Package auth verifies and mints the HS256 bearer tokens the services accept.
package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/httpx"
)

// Role is the caller's role claim.
type Role string

// Roles.
const (
	RoleCustomer   Role = "customer"
	RoleRestaurant Role = "restaurant"
	RoleCourier    Role = "courier"
	RoleOps        Role = "ops"
)

// Valid reports whether r is one of the known roles.
func (r Role) Valid() bool {
	switch r {
	case RoleCustomer, RoleRestaurant, RoleCourier, RoleOps:
		return true
	}
	return false
}

// Principal is the authenticated caller.
type Principal struct {
	Subject      uuid.UUID
	Role         Role
	RestaurantID uuid.NullUUID
}

type tokenClaims struct {
	Role         string `json:"role"`
	RestaurantID string `json:"restaurant_id,omitempty"`
	jwt.RegisteredClaims
}

// ErrInvalidToken is returned for any token that fails verification.
var ErrInvalidToken = errors.New("invalid token")

// Verifier checks token signatures and claims.
type Verifier struct {
	secret []byte
	clock  clock.Clock
}

// NewVerifier returns a Verifier for tokens signed with secret.
func NewVerifier(secret []byte, clk clock.Clock) *Verifier {
	return &Verifier{secret: secret, clock: clk}
}

// Verify parses raw and returns the principal it names.
func (v *Verifier) Verify(raw string) (Principal, error) {
	var c tokenClaims
	tok, err := jwt.ParseWithClaims(raw, &c, func(*jwt.Token) (interface{}, error) {
		return v.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithTimeFunc(v.clock.Now))
	if err != nil || !tok.Valid {
		return Principal{}, ErrInvalidToken
	}
	if c.ExpiresAt == nil {
		return Principal{}, ErrInvalidToken
	}
	sub, err := uuid.Parse(c.Subject)
	if err != nil {
		return Principal{}, ErrInvalidToken
	}
	p := Principal{Subject: sub, Role: Role(c.Role)}
	if !p.Role.Valid() {
		return Principal{}, ErrInvalidToken
	}
	if c.RestaurantID != "" {
		rid, err := uuid.Parse(c.RestaurantID)
		if err != nil {
			return Principal{}, ErrInvalidToken
		}
		p.RestaurantID = uuid.NullUUID{UUID: rid, Valid: true}
	}
	if p.Role == RoleRestaurant && !p.RestaurantID.Valid {
		return Principal{}, ErrInvalidToken
	}
	return p, nil
}

// Mint signs a token for p that expires at expiresAt.
func Mint(secret []byte, p Principal, expiresAt time.Time) (string, error) {
	if !p.Role.Valid() {
		return "", fmt.Errorf("mint token: unknown role %q", p.Role)
	}
	c := tokenClaims{
		Role: string(p.Role),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   p.Subject.String(),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
		},
	}
	if p.RestaurantID.Valid {
		c.RestaurantID = p.RestaurantID.UUID.String()
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(secret)
}

type ctxKey int

const principalKey ctxKey = iota

// WithPrincipal returns a context carrying p.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
}

// FromContext returns the principal stored in ctx.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey).(Principal)
	return p, ok
}

// Require returns the caller when their role is one of roles. It returns an
// unauthenticated error when no caller is present and forbidden otherwise.
func Require(ctx context.Context, roles ...Role) (Principal, error) {
	p, ok := FromContext(ctx)
	if !ok {
		return Principal{}, apperr.Unauthenticated()
	}
	if !slices.Contains(roles, p.Role) {
		return Principal{}, apperr.Forbidden()
	}
	return p, nil
}

// Middleware authenticates every request with a bearer token.
func Middleware(v *Verifier, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			raw, found := strings.CutPrefix(h, "Bearer ")
			if !found || raw == "" {
				httpx.WriteError(w, r, logger, apperr.Unauthenticated())
				return
			}
			p, err := v.Verify(strings.TrimSpace(raw))
			if err != nil {
				httpx.WriteError(w, r, logger, apperr.Unauthenticated())
				return
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
		})
	}
}
