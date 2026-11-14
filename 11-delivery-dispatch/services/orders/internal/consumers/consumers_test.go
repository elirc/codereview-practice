package consumers_test

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
	"deliverydispatch/services/orders/internal/consumers"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/service"
	"deliverydispatch/services/orders/internal/store/db"
	"deliverydispatch/services/orders/migrations"
)

var t0 = time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)

type env struct {
	t          *testing.T
	svc        *service.Service
	pool       *pgxpool.Pool
	clock      *clock.Manual
	proc       *inbox.Processor
	restaurant uuid.UUID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvOrders, migrations.FS)
	clk := clock.NewManual(t0)
	cfg := service.Config{
		Currency:        "USD",
		Fees:            domain.FeeRules{BaseFeeMinor: 199, PerKmMinor: 60},
		MaxDistanceM:    15000,
		QuoteTTL:        5 * time.Minute,
		ConfirmTimeout:  5 * time.Minute,
		MaxActiveOrders: 3,
		CancelFeeMinor:  500,
		CancelRetry:     2 * time.Minute,
	}
	svc := service.New(pool, cfg, clk, idgen.Random{}, logging.Discard())
	rid := uuid.New()
	if err := svc.Queries().UpsertRestaurant(context.Background(), db.UpsertRestaurantParams{
		ID: rid, Name: "Bukka Hut", ZoneID: "lagos-yaba", Lon: 3.3792, Lat: 6.5244, PrepMinutes: 15, Active: true, CreatedAt: t0,
	}); err != nil {
		t.Fatal(err)
	}
	p := inbox.NewProcessor(pool, "orders-on-DISPATCH", consumers.DispatchHandlers(svc), clk, idgen.Random{}, logging.Discard())
	return &env{t: t, svc: svc, pool: pool, clock: clk, proc: p, restaurant: rid}
}

func as(role auth.Role, sub uuid.UUID) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: sub, Role: role})
}

func (e *env) restaurantCtx() context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{
		Subject:      uuid.New(),
		Role:         auth.RoleRestaurant,
		RestaurantID: uuid.NullUUID{UUID: e.restaurant, Valid: true},
	})
}

// confirmedOrder places and confirms an order for customer.
func (e *env) confirmedOrder(customer uuid.UUID) db.Order {
	e.t.Helper()
	ctx := as(auth.RoleCustomer, customer)
	q, err := e.svc.CreateQuote(ctx, service.QuoteRequest{
		RestaurantID: e.restaurant,
		Items:        []domain.Item{{Name: "Suya", Quantity: 1, UnitPriceMinor: 3000}},
		DropoffLon:   3.3973,
		DropoffLat:   6.5244,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	o, _, err := e.svc.PlaceOrder(ctx, q.ID, "order-"+q.ID.String()[:8])
	if err != nil {
		e.t.Fatal(err)
	}
	c, err := e.svc.Confirm(e.restaurantCtx(), o.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

func (e *env) event(eventType string, orderID uuid.UUID, seq int64, data map[string]any) envelope.Envelope {
	e.t.Helper()
	data["delivery_id"] = orderID
	ev, err := envelope.New(uuid.New(), eventType, "delivery", orderID.String(), seq, e.clock.Now(), "test", data)
	if err != nil {
		e.t.Fatal(err)
	}
	return ev
}

func (e *env) send(ev envelope.Envelope) inbox.Outcome {
	e.t.Helper()
	raw, err := ev.Marshal()
	if err != nil {
		e.t.Fatal(err)
	}
	return e.proc.Process(context.Background(), "dispatch."+ev.Type, raw, 1)
}

func (e *env) mustSend(ev envelope.Envelope) {
	e.t.Helper()
	if out := e.send(ev); !out.Ack {
		e.t.Fatalf("%s not acknowledged", ev.Type)
	}
}

func (e *env) order(id uuid.UUID) db.Order {
	e.t.Helper()
	o, err := e.svc.Queries().GetOrder(context.Background(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	return o
}

func (e *env) outboxTypes() []string {
	e.t.Helper()
	rows, err := e.pool.Query(context.Background(), `SELECT payload->>'type' FROM outbox ORDER BY id`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func TestDeliveryEventsInOrder(t *testing.T) {
	e := newEnv(t)
	o := e.confirmedOrder(uuid.New())
	courier := uuid.New()

	e.mustSend(e.event("delivery.assigned", o.ID, 2, map[string]any{"courier_id": courier, "eta_minutes": 22}))
	if got := e.order(o.ID); got.Status != "courier_assigned" || got.CourierID.UUID != courier || *got.EtaMinutes != 22 {
		t.Fatalf("after assigned: %+v", got)
	}
	e.mustSend(e.event("delivery.picked_up", o.ID, 3, map[string]any{"courier_id": courier, "picked_up_at": t0}))
	e.mustSend(e.event("delivery.delivered", o.ID, 4, map[string]any{"courier_id": courier, "delivered_at": t0, "courier_payout_minor": 572, "currency": "USD"}))
	got := e.order(o.ID)
	if got.Status != "delivered" || got.DeliverySequence != 4 {
		t.Fatalf("after delivered: %+v", got)
	}
	e.mustSend(e.event("delivery.failed", o.ID, 9, map[string]any{"reason": "no_courier", "offers_made": 5}))
	if after := e.order(o.ID); after.Status != "delivered" || after.Version != got.Version {
		t.Fatalf("event changed a delivered order: %+v", after)
	}
}

func TestPickedUpBeforeAssignedAndStaleUnassigned(t *testing.T) {
	e := newEnv(t)
	o := e.confirmedOrder(uuid.New())
	courier := uuid.New()

	e.mustSend(e.event("delivery.picked_up", o.ID, 5, map[string]any{"courier_id": courier, "picked_up_at": t0}))
	e.mustSend(e.event("delivery.assigned", o.ID, 4, map[string]any{"courier_id": uuid.New(), "eta_minutes": 10}))
	got := e.order(o.ID)
	if got.Status != "picked_up" || got.CourierID.UUID != courier || got.EtaMinutes != nil {
		t.Fatalf("late assigned changed the order: %+v", got)
	}

	other := e.confirmedOrder(uuid.New())
	e.mustSend(e.event("delivery.assigned", other.ID, 8, map[string]any{"courier_id": courier, "eta_minutes": 12}))
	e.mustSend(e.event("delivery.unassigned", other.ID, 6, map[string]any{"courier_id": courier, "reason": "abandoned"}))
	if got := e.order(other.ID); got.Status != "courier_assigned" {
		t.Fatalf("stale unassigned applied: %+v", got)
	}
}

func TestDuplicateDeliveryEventAppliesOnce(t *testing.T) {
	e := newEnv(t)
	o := e.confirmedOrder(uuid.New())
	ev := e.event("delivery.assigned", o.ID, 2, map[string]any{"courier_id": uuid.New(), "eta_minutes": 22})
	e.mustSend(ev)
	v := e.order(o.ID).Version
	e.mustSend(ev)
	if got := e.order(o.ID); got.Version != v {
		t.Fatalf("duplicate changed the version %d -> %d", v, got.Version)
	}
}

func TestFailedDeliveryCancelsWithFullRefund(t *testing.T) {
	e := newEnv(t)
	o := e.confirmedOrder(uuid.New())
	e.mustSend(e.event("delivery.failed", o.ID, 3, map[string]any{"reason": "no_courier", "offers_made": 5}))
	got := e.order(o.ID)
	if got.Status != "cancelled" || *got.CancelReason != "no_courier" || got.RefundMinor != got.TotalMinor || got.CancellationFeeMinor != 0 {
		t.Fatalf("order = %+v", got)
	}
	types := e.outboxTypes()
	if types[len(types)-1] != service.EventOrderCancelled {
		t.Fatalf("outbox = %v", types)
	}
}

func TestDeliveryEventForUnknownOrderIsRetried(t *testing.T) {
	e := newEnv(t)
	out := e.send(e.event("delivery.assigned", uuid.New(), 2, map[string]any{"courier_id": uuid.New(), "eta_minutes": 5}))
	if out.Ack {
		t.Fatal("event for an unknown order was acknowledged")
	}
}
