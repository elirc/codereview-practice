package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/pgtest"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
	"deliverydispatch/services/orders/migrations"
)

var t0 = time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)

var testConfig = Config{
	Currency:        "USD",
	Fees:            domain.FeeRules{BaseFeeMinor: 199, PerKmMinor: 60},
	MaxDistanceM:    15000,
	QuoteTTL:        5 * time.Minute,
	ConfirmTimeout:  5 * time.Minute,
	MaxActiveOrders: 3,
	CancelFeeMinor:  500,
	CancelRetry:     2 * time.Minute,
}

type env struct {
	svc        *Service
	pool       *pgxpool.Pool
	clock      *clock.Manual
	restaurant db.Restaurant
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvOrders, migrations.FS)
	clk := clock.NewManual(t0)
	svc := New(pool, testConfig, clk, idgen.Random{}, logging.Discard())
	r := db.UpsertRestaurantParams{
		ID:          uuid.New(),
		Name:        "Mama Put Yaba",
		ZoneID:      "lagos-yaba",
		Lon:         3.3792,
		Lat:         6.5244,
		PrepMinutes: 15,
		Active:      true,
		CreatedAt:   t0,
	}
	if err := svc.q.UpsertRestaurant(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	rest, err := svc.q.GetRestaurant(context.Background(), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	return &env{svc: svc, pool: pool, clock: clk, restaurant: rest}
}

func as(role auth.Role, sub uuid.UUID) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: sub, Role: role})
}

func asRestaurant(restaurantID uuid.UUID) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{
		Subject:      uuid.New(),
		Role:         auth.RoleRestaurant,
		RestaurantID: uuid.NullUUID{UUID: restaurantID, Valid: true},
	})
}

func asOps() context.Context {
	return as(auth.RoleOps, uuid.New())
}

// nearbyQuote is a quote request 2,345 m east of the test restaurant.
func (e *env) nearbyQuote() QuoteRequest {
	return QuoteRequest{
		RestaurantID: e.restaurant.ID,
		Items:        []domain.Item{{Name: "Jollof rice", Quantity: 2, UnitPriceMinor: 1500}},
		DropoffLon:   e.restaurant.Lon + 0.02123,
		DropoffLat:   e.restaurant.Lat,
	}
}

func (e *env) quote(t *testing.T, customer uuid.UUID) db.Quote {
	t.Helper()
	q, err := e.svc.CreateQuote(as(auth.RoleCustomer, customer), e.nearbyQuote())
	if err != nil {
		t.Fatalf("create quote: %v", err)
	}
	return q
}

func (e *env) outboxTypes(t *testing.T) []string {
	t.Helper()
	rows, err := e.pool.Query(context.Background(), `SELECT payload->>'type' FROM outbox ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}
