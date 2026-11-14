package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	dt "deliverydispatch/services/dispatch/internal/dispatchtest"
)

// reserving sets up a delivery in reserving with a nearby courier and returns both ids.
func reserving(t *testing.T, e *dt.Env) (uuid.UUID, uuid.UUID) {
	t.Helper()
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 1000))
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	if _, err := e.Svc.AcceptOffer(dt.AsCourier(c), pendingOffer(t, e, d).ID); err != nil {
		t.Fatal(err)
	}
	return d, c
}

func (h courierEvents) reserved(courierID, deliveryID uuid.UUID) {
	h.e.MustSend(h.e.Couriers, h.e.Event("courier.reserved", "courier", courierID.String(), 9, map[string]any{
		"courier_id": courierID, "delivery_id": deliveryID,
	}))
}

func (h courierEvents) rejected(courierID, deliveryID uuid.UUID, reason string) {
	h.e.MustSend(h.e.Couriers, h.e.Event("courier.reservation_rejected", "courier", courierID.String(), 9, map[string]any{
		"courier_id": courierID, "delivery_id": deliveryID, "reason": reason,
	}))
}

type courierEvents struct{ e *dt.Env }

func TestReservedAssignsWithETA(t *testing.T) {
	e := dt.New(t)
	d, c := reserving(t, e)
	courierEvents{e}.reserved(c, d)

	got := e.Delivery(d)
	if got.Status != "assigned" || got.EtaMinutes == nil || got.ReserveDeadline != nil {
		t.Fatalf("delivery = %+v", got)
	}
	if *got.EtaMinutes != 15+11 {
		t.Fatalf("eta = %d, want food-ready wait 15 + bike 2 km 11", *got.EtaMinutes)
	}
	assigned := e.Outbox("delivery.assigned")
	if len(assigned) != 1 || assigned[0].Sequence != 2 {
		t.Fatalf("assigned events = %+v", assigned)
	}
}

func TestReservationRejectedReturnsDeliveryToSearching(t *testing.T) {
	e := dt.New(t)
	d, c := reserving(t, e)
	courierEvents{e}.rejected(c, d, "offline")

	got := e.Delivery(d)
	if got.Status != "searching" || got.CourierID.Valid || !got.NextOfferAt.Equal(e.Clock.Now()) {
		t.Fatalf("delivery = %+v", got)
	}
	if n := len(e.Outbox("delivery.assigned")); n != 0 {
		t.Fatalf("assigned events = %d", n)
	}
	courierEvents{e}.rejected(c, d, "offline")
	if got2 := e.Delivery(d); got2.Version != got.Version || got2.Status != "searching" {
		t.Fatalf("stale rejection changed the delivery: %+v", got2)
	}
}

func TestReservationTimeoutReleasesCourier(t *testing.T) {
	e := dt.New(t)
	d, c := reserving(t, e)
	deadline := *e.Delivery(d).ReserveDeadline

	e.Clock.Set(deadline.Add(-time.Millisecond))
	if n, _ := e.Svc.ExpireReservations(context.Background(), e.Clock.Now()); n != 0 {
		t.Fatalf("released %d before the deadline", n)
	}
	e.Clock.Set(deadline)
	if n, err := e.Svc.ExpireReservations(context.Background(), e.Clock.Now()); err != nil || n != 1 {
		t.Fatalf("released %d, %v", n, err)
	}
	got := e.Delivery(d)
	if got.Status != "searching" || got.CourierID.Valid {
		t.Fatalf("delivery = %+v", got)
	}
	released := e.Outbox("delivery.courier_released")
	if len(released) != 1 || released[0].Sequence != got.Version {
		t.Fatalf("released events = %+v", released)
	}

	courierEvents{e}.reserved(c, d)
	if got := e.Delivery(d); got.Status != "searching" {
		t.Fatalf("late reserved changed the delivery: %+v", got)
	}
	if n := len(e.Outbox("delivery.courier_released")); n != 2 {
		t.Fatalf("late reserved should release the courier again, released events = %d", n)
	}
}

func TestReservedAtDeadlineBeforeSweeperReleases(t *testing.T) {
	e := dt.New(t)
	d, c := reserving(t, e)
	e.Clock.Set(*e.Delivery(d).ReserveDeadline)

	courierEvents{e}.reserved(c, d)
	if got := e.Delivery(d); got.Status != "searching" {
		t.Fatalf("reserved at the deadline assigned the delivery: %+v", got)
	}
	if n := len(e.Outbox("delivery.assigned")); n != 0 {
		t.Fatalf("assigned events = %d", n)
	}
}
