package service_test

import (
	"testing"

	"github.com/google/uuid"

	dt "deliverydispatch/services/dispatch/internal/dispatchtest"
)

// assigned sets up a delivery assigned to a nearby courier and returns both ids.
func assigned(t *testing.T, e *dt.Env) (uuid.UUID, uuid.UUID) {
	t.Helper()
	d, c := reserving(t, e)
	courierEvents{e}.reserved(c, d)
	if got := e.Delivery(d); got.Status != "assigned" {
		t.Fatalf("setup: %+v", got)
	}
	return d, c
}

func TestPickupAndDeliver(t *testing.T) {
	e := dt.New(t)
	d, c := assigned(t, e)
	ctx := dt.AsCourier(c)

	_, err := e.Svc.Deliver(ctx, d)
	wantCode(t, err, "invalid_state")
	_, err = e.Svc.Pickup(dt.AsCourier(uuid.New()), d)
	wantCode(t, err, "not_found")

	if got, err := e.Svc.Pickup(ctx, d); err != nil || got.Status != "picked_up" {
		t.Fatalf("pickup = %+v, %v", got, err)
	}
	if _, err := e.Svc.Pickup(ctx, d); err != nil {
		t.Fatalf("repeat pickup: %v", err)
	}
	_, err = e.Svc.Abandon(ctx, d)
	wantCode(t, err, "invalid_state")

	got, err := e.Svc.Deliver(ctx, d)
	if err != nil || got.Status != "delivered" || got.CourierPayoutMinor == nil || *got.CourierPayoutMinor != 300+272 {
		t.Fatalf("deliver = %+v, %v", got, err)
	}
	if _, err := e.Svc.Deliver(ctx, d); err != nil {
		t.Fatalf("repeat deliver: %v", err)
	}
	if n := len(e.Outbox("delivery.delivered")); n != 1 {
		t.Fatalf("delivered events = %d, want 1", n)
	}
	if n := len(e.Outbox("delivery.picked_up")); n != 1 {
		t.Fatalf("picked_up events = %d, want 1", n)
	}
}

func TestPickupWhileReservingIsRefused(t *testing.T) {
	e := dt.New(t)
	d, c := reserving(t, e)
	_, err := e.Svc.Pickup(dt.AsCourier(c), d)
	wantCode(t, err, "invalid_state")
}

func TestAbandonFindsAnotherCourier(t *testing.T) {
	e := dt.New(t)
	d, c := assigned(t, e)
	got, err := e.Svc.Abandon(dt.AsCourier(c), d)
	if err != nil || got.Status != "searching" || got.CourierID.Valid {
		t.Fatalf("abandon = %+v, %v", got, err)
	}
	unassigned := e.Outbox("delivery.unassigned")
	if len(unassigned) != 1 || unassigned[0].Sequence != got.Version {
		t.Fatalf("unassigned events = %+v", unassigned)
	}

	e.CourierStatus(c, "available", "lagos-yaba", "bike", 5)
	other := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 2500))
	runOffers(t, e)
	if o := pendingOffer(t, e, d); o.CourierID != other {
		t.Fatalf("offered to %s, want the other courier", o.CourierID)
	}
	_, err = e.Svc.Pickup(dt.AsCourier(c), d)
	wantCode(t, err, "not_found")
}
