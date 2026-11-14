// Package dispatchtest builds a dispatch service on an isolated test schema
// and feeds it events the way the consumers would.
package dispatchtest

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/pgtest"
	"deliverydispatch/services/dispatch/internal/consumers"
	"deliverydispatch/services/dispatch/internal/service"
	"deliverydispatch/services/dispatch/internal/store/db"
	"deliverydispatch/services/dispatch/migrations"
)

// T0 is the starting instant of every test clock.
var T0 = time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)

// Pickup is the pickup point used by default (Yaba, Lagos).
var Pickup = envelope.Point{Lon: 3.3792, Lat: 6.5244}

// Dropoff is 2 km east of Pickup.
var Dropoff = envelope.Point{Lon: 3.3973, Lat: 6.5244}

// Config is the dispatch configuration used in tests.
var Config = service.Config{
	Currency:                "USD",
	SearchTimeout:           10 * time.Minute,
	MaxOffers:               5,
	OfferTTL:                30 * time.Second,
	OfferRetry:              5 * time.Second,
	OfferRadiusM:            5000,
	PositionMaxAge:          120 * time.Second,
	ReserveTimeout:          20 * time.Second,
	CourierBaseMinor:        300,
	CourierShareBps:         8000,
	CancelCompensationMinor: 400,
}

// Env is a dispatch service under test.
type Env struct {
	t        *testing.T
	Svc      *service.Service
	Pool     *pgxpool.Pool
	Clock    *clock.Manual
	Orders   *inbox.Processor
	Couriers *inbox.Processor
}

// New returns an Env on a fresh schema; the test is skipped without a database.
func New(t *testing.T) *Env {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvDispatch, migrations.FS)
	clk := clock.NewManual(T0)
	logger := logging.Discard()
	svc := service.New(pool, Config, clk, idgen.Random{}, logger)
	return &Env{
		t:        t,
		Svc:      svc,
		Pool:     pool,
		Clock:    clk,
		Orders:   inbox.NewProcessor(pool, "dispatch-on-ORDERS", consumers.OrdersHandlers(svc), clk, idgen.Random{}, logger),
		Couriers: inbox.NewProcessor(pool, "dispatch-on-COURIERS", consumers.CouriersHandlers(svc), clk, idgen.Random{}, logger),
	}
}

// Event builds an envelope stamped with the test clock.
func (e *Env) Event(eventType, aggregateType, aggregateID string, sequence int64, data any) envelope.Envelope {
	e.t.Helper()
	env, err := envelope.New(uuid.New(), eventType, aggregateType, aggregateID, sequence, e.Clock.Now(), "test", data)
	if err != nil {
		e.t.Fatal(err)
	}
	return env
}

// Send delivers env to p once and returns the outcome.
func (e *Env) Send(p *inbox.Processor, env envelope.Envelope) inbox.Outcome {
	e.t.Helper()
	raw, err := env.Marshal()
	if err != nil {
		e.t.Fatal(err)
	}
	return p.Process(context.Background(), "test."+env.Type, raw, 1)
}

// MustSend delivers env to p and fails the test unless it is acknowledged.
func (e *Env) MustSend(p *inbox.Processor, env envelope.Envelope) {
	e.t.Helper()
	if out := e.Send(p, env); !out.Ack {
		e.t.Fatalf("%s was not acknowledged", env.Type)
	}
}

// ConfirmOrder delivers order.confirmed for a new order at Pickup and returns its id.
func (e *Env) ConfirmOrder(zone string) uuid.UUID {
	e.t.Helper()
	id := uuid.New()
	e.ConfirmOrderAt(id, zone, Pickup, e.Clock.Now().Add(15*time.Minute))
	return id
}

// ConfirmOrderAt delivers order.confirmed for order id.
func (e *Env) ConfirmOrderAt(id uuid.UUID, zone string, pickup envelope.Point, readyAt time.Time) {
	e.t.Helper()
	e.MustSend(e.Orders, e.Event("order.confirmed", "order", id.String(), 2, map[string]any{
		"order_id":           id,
		"restaurant_id":      uuid.New(),
		"zone_id":            zone,
		"pickup":             pickup,
		"dropoff":            Dropoff,
		"ready_at":           readyAt.UTC(),
		"delivery_fee_minor": 340,
		"surge_bps":          10000,
		"currency":           "USD",
	}))
}

// CourierStatus delivers courier.status_changed.
func (e *Env) CourierStatus(courierID uuid.UUID, status, zone, vehicle string, sequence int64) {
	e.t.Helper()
	var z any
	if zone != "" {
		z = zone
	}
	e.MustSend(e.Couriers, e.Event("courier.status_changed", "courier", courierID.String(), sequence, map[string]any{
		"courier_id": courierID,
		"status":     status,
		"zone_id":    z,
		"vehicle":    vehicle,
		"suspended":  false,
	}))
}

// CourierAt delivers courier.location_updated.
func (e *Env) CourierAt(courierID uuid.UUID, p envelope.Point, recordedAt time.Time, sequence int64) {
	e.t.Helper()
	e.MustSend(e.Couriers, e.Event("courier.location_updated", "courier", courierID.String(), sequence, map[string]any{
		"courier_id":  courierID,
		"lon":         p.Lon,
		"lat":         p.Lat,
		"recorded_at": recordedAt.UTC(),
	}))
}

// AvailableCourier projects a new available bike courier positioned at p now.
func (e *Env) AvailableCourier(zone string, p envelope.Point) uuid.UUID {
	e.t.Helper()
	id := uuid.New()
	e.CourierStatus(id, "available", zone, "bike", 2)
	e.CourierAt(id, p, e.Clock.Now(), 1)
	return id
}

// East returns a point metres east of p (approximately, at Lagos latitude).
func East(p envelope.Point, metres float64) envelope.Point {
	return envelope.Point{Lon: p.Lon + metres/110475.0, Lat: p.Lat}
}

// Delivery loads a delivery.
func (e *Env) Delivery(id uuid.UUID) db.Delivery {
	e.t.Helper()
	d, err := e.Svc.Queries().GetDelivery(context.Background(), id)
	if err != nil {
		e.t.Fatalf("load delivery %s: %v", id, err)
	}
	return d
}

// CourierView loads a projected courier.
func (e *Env) CourierView(id uuid.UUID) db.CourierView {
	e.t.Helper()
	c, err := e.Svc.Queries().GetCourierView(context.Background(), id)
	if err != nil {
		e.t.Fatalf("load courier view %s: %v", id, err)
	}
	return c
}

// Count runs a count query.
func (e *Env) Count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// Outbox returns the outbox envelopes in id order, optionally filtered by type.
func (e *Env) Outbox(eventType string) []envelope.Envelope {
	e.t.Helper()
	rows, err := e.Pool.Query(context.Background(), `SELECT payload FROM outbox ORDER BY id`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []envelope.Envelope
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			e.t.Fatal(err)
		}
		env, err := envelope.Decode(raw)
		if err != nil {
			e.t.Fatal(err)
		}
		if eventType == "" || env.Type == eventType {
			out = append(out, env)
		}
	}
	return out
}

// AsCourier returns a context authenticated as courier id.
func AsCourier(id uuid.UUID) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: id, Role: auth.RoleCourier})
}

// AsOps returns a context authenticated as an ops user.
func AsOps() context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: uuid.New(), Role: auth.RoleOps})
}
