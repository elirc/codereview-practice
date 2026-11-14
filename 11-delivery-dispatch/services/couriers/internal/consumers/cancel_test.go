package consumers_test

import (
	"testing"

	"github.com/google/uuid"
)

func TestCancelWhileAssignedCompensatesAndReleases(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
	cancelled := e.send("delivery.cancelled", d, map[string]any{
		"courier_id": c.ID, "courier_was_assigned": true, "compensation_minor": 400, "currency": "USD",
	})
	e.resend(cancelled)

	if got := e.courier(c.ID); got.ActiveDeliveryID.Valid {
		t.Fatalf("courier still attached: %+v", got)
	}
	earnings, err := e.svc.MyEarnings(asCourier(c.ID))
	if err != nil || len(earnings.Items) != 1 || earnings.Items[0].Kind != "cancellation_compensation" || earnings.TotalMinor != 400 {
		t.Fatalf("earnings = %+v, %v", earnings, err)
	}
}

func TestCancelWhileReservingInEitherOrderLeavesCourierUnattached(t *testing.T) {
	for _, cancelFirst := range []bool{false, true} {
		e := newEnv(t)
		c := e.onShiftCourier()
		d := uuid.New()
		cancel := func() {
			e.send("delivery.cancelled", d, map[string]any{
				"courier_id": c.ID, "courier_was_assigned": false, "compensation_minor": 0, "currency": "USD",
			})
		}
		if cancelFirst {
			cancel()
			e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
			e.send("delivery.courier_released", d, map[string]any{"courier_id": c.ID, "reason": "not_reserving"})
		} else {
			e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
			cancel()
		}
		if got := e.courier(c.ID); got.ActiveDeliveryID.Valid {
			t.Fatalf("cancelFirst=%v: courier still attached", cancelFirst)
		}
		if earnings, _ := e.svc.MyEarnings(asCourier(c.ID)); len(earnings.Items) != 0 {
			t.Fatalf("cancelFirst=%v: compensation recorded for a reserving cancel", cancelFirst)
		}
	}
}

func TestCancelWithoutCourierChangesNothing(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	e.send("delivery.cancelled", uuid.New(), map[string]any{"courier_id": nil, "courier_was_assigned": false, "compensation_minor": 0, "currency": "USD"})
	if got := e.courier(c.ID); got.StatusVersion != c.StatusVersion {
		t.Fatalf("courier changed: %+v", got)
	}
}
