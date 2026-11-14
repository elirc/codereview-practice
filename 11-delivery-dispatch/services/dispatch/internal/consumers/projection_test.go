package consumers_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	dt "deliverydispatch/services/dispatch/internal/dispatchtest"
)

func TestCourierStatusAppliesOnlyNewerVersions(t *testing.T) {
	e := dt.New(t)
	id := uuid.New()

	e.CourierStatus(id, "available", "lagos-yaba", "scooter", 5)
	e.CourierStatus(id, "offline", "", "scooter", 4)
	v := e.CourierView(id)
	if v.Status != "available" || v.StatusVersion != 5 || v.Vehicle != "scooter" || v.ZoneID == nil || *v.ZoneID != "lagos-yaba" {
		t.Fatalf("view after stale event = %+v", v)
	}
	e.CourierStatus(id, "offline", "", "scooter", 6)
	if v := e.CourierView(id); v.Status != "offline" || v.ZoneID != nil {
		t.Fatalf("view after newer event = %+v", v)
	}
}

func TestCourierLocationKeepsNewestAndCreatesOfflineRow(t *testing.T) {
	e := dt.New(t)
	id := uuid.New()

	e.CourierAt(id, dt.Pickup, dt.T0, 2)
	v := e.CourierView(id)
	if v.Status != "offline" || v.PositionAt == nil || !v.PositionAt.Equal(dt.T0) {
		t.Fatalf("view for unknown courier = %+v", v)
	}
	e.CourierAt(id, dt.East(dt.Pickup, 500), dt.T0.Add(-time.Second), 1)
	if v := e.CourierView(id); *v.Lon != dt.Pickup.Lon {
		t.Fatalf("older position applied: %v", *v.Lon)
	}
	e.CourierAt(id, dt.East(dt.Pickup, 500), dt.T0.Add(time.Second), 3)
	if v := e.CourierView(id); *v.Lon == dt.Pickup.Lon || v.Status != "offline" {
		t.Fatalf("newer position not applied or status changed: %+v", v)
	}
}

func TestOrderConfirmedCreatesOneSearchingDelivery(t *testing.T) {
	e := dt.New(t)
	id := uuid.New()
	readyAt := dt.T0.Add(15 * time.Minute)
	e.ConfirmOrderAt(id, "lagos-yaba", dt.Pickup, readyAt)
	e.ConfirmOrderAt(id, "lagos-yaba", dt.Pickup, readyAt)

	d := e.Delivery(id)
	if d.Status != "searching" || !d.NextOfferAt.Equal(dt.T0) || !d.SearchDeadline.Equal(dt.T0.Add(10*time.Minute)) || d.Version != 0 {
		t.Fatalf("delivery = %+v", d)
	}
	if n := e.Count(`SELECT count(*) FROM deliveries`); n != 1 {
		t.Fatalf("deliveries = %d", n)
	}
}

func TestOrderConfirmedAfterCancellationCreatesNothing(t *testing.T) {
	e := dt.New(t)
	id := uuid.New()
	if _, err := e.Pool.Exec(context.Background(), `INSERT INTO cancelled_orders (order_id, requested_at) VALUES ($1, $2)`, id, dt.T0); err != nil {
		t.Fatal(err)
	}
	e.ConfirmOrderAt(id, "lagos-yaba", dt.Pickup, dt.T0)
	if n := e.Count(`SELECT count(*) FROM deliveries`); n != 0 {
		t.Fatalf("deliveries = %d, want 0", n)
	}
}

func TestInvalidOrderConfirmedDataIsRetried(t *testing.T) {
	e := dt.New(t)
	out := e.Send(e.Orders, e.Event("order.confirmed", "order", uuid.NewString(), 2, map[string]any{"order_id": uuid.New()}))
	if out.Ack {
		t.Fatal("event without required fields was acknowledged on first delivery")
	}
}
