package service_test

import (
	"sync"
	"testing"

	"github.com/google/uuid"

	"deliverydispatch/pkg/envelope"
	dt "deliverydispatch/services/dispatch/internal/dispatchtest"
)

func cancelRequest(e *dt.Env, orderID uuid.UUID, attempt int) envelope.Envelope {
	return e.Event("order.cancel_requested", "order", orderID.String(), int64(2+attempt), map[string]any{
		"order_id": orderID, "requested_by": "customer", "attempt": attempt,
	})
}

type cancelledFacts struct {
	CourierID          *uuid.UUID `json:"courier_id"`
	CourierWasAssigned bool       `json:"courier_was_assigned"`
	CompensationMinor  int64      `json:"compensation_minor"`
	Reason             string     `json:"reason"`
}

func lastAnswer(t *testing.T, e *dt.Env, orderID uuid.UUID) (envelope.Envelope, cancelledFacts) {
	t.Helper()
	var last envelope.Envelope
	for _, ev := range e.Outbox("") {
		if ev.AggregateID == orderID.String() && (ev.Type == "delivery.cancelled" || ev.Type == "delivery.cancel_rejected" || ev.Type == "delivery.failed") {
			last = ev
		}
	}
	if last.Type == "" {
		t.Fatal("no answer recorded")
	}
	var f cancelledFacts
	if err := last.DecodeData(&f); err != nil {
		t.Fatal(err)
	}
	return last, f
}

func TestCancelBeforeDeliveryExists(t *testing.T) {
	e := dt.New(t)
	id := uuid.New()
	e.MustSend(e.Orders, cancelRequest(e, id, 1))
	ev, f := lastAnswer(t, e, id)
	if ev.Type != "delivery.cancelled" || ev.Sequence != 1 || f.CourierWasAssigned || f.CourierID != nil {
		t.Fatalf("answer = %+v %+v", ev, f)
	}
	e.ConfirmOrderAt(id, "lagos-yaba", dt.Pickup, dt.T0)
	if n := e.Count(`SELECT count(*) FROM deliveries`); n != 0 {
		t.Fatalf("delivery created for a cancelled order")
	}
	e.MustSend(e.Orders, cancelRequest(e, id, 2))
	if n := len(e.Outbox("delivery.cancelled")); n != 2 {
		t.Fatalf("repeated request answered %d times, want 2", n)
	}
}

func TestCancelWhileSearchingOrOffered(t *testing.T) {
	e := dt.New(t)
	searching := e.ConfirmOrder("lagos-yaba")
	e.MustSend(e.Orders, cancelRequest(e, searching, 1))
	if got := e.Delivery(searching); got.Status != "cancelled" {
		t.Fatalf("searching delivery = %+v", got)
	}

	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 300))
	offered := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	o := pendingOffer(t, e, offered)
	e.MustSend(e.Orders, cancelRequest(e, offered, 1))
	ev, f := lastAnswer(t, e, offered)
	if ev.Type != "delivery.cancelled" || f.CourierWasAssigned || f.CourierID != nil {
		t.Fatalf("answer = %+v %+v", ev, f)
	}
	_, err := e.Svc.AcceptOffer(dt.AsCourier(c), o.ID)
	wantCode(t, err, "offer_not_pending")
}

func TestCancelWhileReservingNamesCourierWithoutCompensation(t *testing.T) {
	e := dt.New(t)
	d, c := reserving(t, e)
	e.MustSend(e.Orders, cancelRequest(e, d, 1))
	ev, f := lastAnswer(t, e, d)
	if ev.Type != "delivery.cancelled" || f.CourierID == nil || *f.CourierID != c || f.CourierWasAssigned || f.CompensationMinor != 0 {
		t.Fatalf("answer = %+v %+v", ev, f)
	}
	courierEvents{e}.reserved(c, d)
	if n := len(e.Outbox("delivery.courier_released")); n != 1 {
		t.Fatalf("late reserved after cancellation should release the courier, released = %d", n)
	}
}

func TestCancelWhileAssignedCompensatesCourier(t *testing.T) {
	e := dt.New(t)
	d, c := assigned(t, e)
	e.MustSend(e.Orders, cancelRequest(e, d, 1))
	ev, f := lastAnswer(t, e, d)
	if ev.Type != "delivery.cancelled" || *f.CourierID != c || !f.CourierWasAssigned || f.CompensationMinor != dt.Config.CancelCompensationMinor {
		t.Fatalf("answer = %+v %+v", ev, f)
	}
	e.MustSend(e.Orders, cancelRequest(e, d, 2))
	again, f2 := lastAnswer(t, e, d)
	if again.Type != "delivery.cancelled" || again.Sequence != ev.Sequence+1 || *f2.CourierID != *f.CourierID || f2.CompensationMinor != f.CompensationMinor || !f2.CourierWasAssigned {
		t.Fatalf("repeated answer = %+v %+v", again, f2)
	}
}

func TestCancelAfterPickupIsRejectedAndFailedIsRepeated(t *testing.T) {
	e := dt.New(t)
	d, c := assigned(t, e)
	if _, err := e.Svc.Pickup(dt.AsCourier(c), d); err != nil {
		t.Fatal(err)
	}
	e.MustSend(e.Orders, cancelRequest(e, d, 1))
	ev, f := lastAnswer(t, e, d)
	if ev.Type != "delivery.cancel_rejected" || f.Reason != "picked_up" {
		t.Fatalf("answer = %+v %+v", ev, f)
	}
	if got := e.Delivery(d); got.Status != "picked_up" {
		t.Fatalf("delivery = %+v", got)
	}

	failed := e.ConfirmOrder("lagos-yaba")
	e.Clock.Advance(dt.Config.SearchTimeout)
	runOffers(t, e)
	e.MustSend(e.Orders, cancelRequest(e, failed, 1))
	if ev, _ := lastAnswer(t, e, failed); ev.Type != "delivery.failed" {
		t.Fatalf("answer for failed delivery = %s", ev.Type)
	}
}

func TestPickupAndCancelRaceHaveOneOutcome(t *testing.T) {
	e := dt.New(t)
	d, c := assigned(t, e)

	var wg sync.WaitGroup
	var pickupErr error
	var acked bool
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, pickupErr = e.Svc.Pickup(dt.AsCourier(c), d)
	}()
	go func() {
		defer wg.Done()
		acked = e.Send(e.Orders, cancelRequest(e, d, 1)).Ack
	}()
	wg.Wait()
	if !acked {
		t.Fatal("cancel request not acknowledged")
	}

	ev, _ := lastAnswer(t, e, d)
	switch got := e.Delivery(d); got.Status {
	case "picked_up":
		if pickupErr != nil || ev.Type != "delivery.cancel_rejected" {
			t.Fatalf("picked up but pickup err=%v answer=%s", pickupErr, ev.Type)
		}
	case "cancelled":
		if pickupErr == nil || ev.Type != "delivery.cancelled" {
			t.Fatalf("cancelled but pickup err=%v answer=%s", pickupErr, ev.Type)
		}
		wantCode(t, pickupErr, "invalid_state")
	default:
		t.Fatalf("status = %s", got.Status)
	}
}
