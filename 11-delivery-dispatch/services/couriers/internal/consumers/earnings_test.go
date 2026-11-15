package consumers_test

import (
	"testing"

	"github.com/google/uuid"

	"deliverydispatch/services/couriers/internal/service"
)

func TestDeliveredRecordsOneEarningAndFreesCourier(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})

	delivered := e.send("delivery.delivered", d, map[string]any{"courier_id": c.ID, "courier_payout_minor": 572, "currency": "USD"})
	e.resend(delivered)
	e.send("delivery.delivered", d, map[string]any{"courier_id": c.ID, "courier_payout_minor": 572, "currency": "USD"})

	got := e.courier(c.ID)
	if got.ActiveDeliveryID.Valid || service.Status(got) != "available" {
		t.Fatalf("courier after delivery = %+v", got)
	}
	earnings, err := e.svc.MyEarnings(asCourier(c.ID))
	if err != nil {
		t.Fatal(err)
	}
	if len(earnings.Items) != 1 || earnings.TotalMinor != 572 {
		t.Fatalf("earnings = %+v", earnings)
	}

	other := uuid.New()
	e.send("delivery.delivered", other, map[string]any{"courier_id": c.ID, "courier_payout_minor": 640, "currency": "USD"})
	if earnings, _ := e.svc.CourierEarnings(asOps(), c.ID); len(earnings.Items) != 2 || earnings.TotalMinor != 1212 {
		t.Fatalf("earnings for two deliveries = %+v", earnings)
	}
	_, err = e.svc.CourierEarnings(asCourier(c.ID), c.ID)
	if err == nil {
		t.Fatal("couriers may not use the ops earnings endpoint")
	}
}

func TestSuspendedCourierFinishesDeliveryAndEndsOffline(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})

	if _, err := e.svc.EndShift(asCourier(c.ID)); err == nil {
		t.Fatal("ending a shift with an active delivery should fail")
	}
	s, err := e.svc.Suspend(asOps(), c.ID)
	if err != nil || service.Status(s) != "busy" {
		t.Fatalf("suspended mid-delivery = %+v, %v", s, err)
	}
	e.send("delivery.delivered", d, map[string]any{"courier_id": c.ID, "courier_payout_minor": 572, "currency": "USD"})
	got := e.courier(c.ID)
	if service.Status(got) != "offline" {
		t.Fatalf("courier after delivery = %+v", got)
	}
	if earnings, _ := e.svc.MyEarnings(asCourier(c.ID)); earnings.TotalMinor != 572 {
		t.Fatalf("suspended courier not paid: %+v", earnings)
	}
}

func TestUnassignedReleasesCourier(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
	e.send("delivery.unassigned", d, map[string]any{"courier_id": c.ID, "reason": "abandoned"})
	if got := e.courier(c.ID); got.ActiveDeliveryID.Valid {
		t.Fatalf("courier still attached: %+v", got)
	}
}

func TestEarningsByKindAndForOneDelivery(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	delivered, cancelled := uuid.New(), uuid.New()
	e.send("delivery.courier_requested", delivered, map[string]any{"courier_id": c.ID})
	e.send("delivery.delivered", delivered, map[string]any{"courier_id": c.ID, "courier_payout_minor": 572, "currency": "USD"})
	e.send("delivery.courier_requested", cancelled, map[string]any{"courier_id": c.ID})
	e.send("delivery.cancelled", cancelled, map[string]any{"courier_id": c.ID, "courier_was_assigned": true, "compensation_minor": 400, "currency": "USD"})

	all, err := e.svc.MyEarnings(asCourier(c.ID))
	if err != nil {
		t.Fatal(err)
	}
	if all.TotalMinor != 972 || all.ByKind["delivery"] != 572 || all.ByKind["cancellation_compensation"] != 400 {
		t.Fatalf("earnings = %+v", all)
	}

	one, err := e.svc.MyDeliveryEarnings(asCourier(c.ID), cancelled)
	if err != nil || one.TotalMinor != 400 || len(one.Items) != 1 || one.Items[0].Kind != "cancellation_compensation" {
		t.Fatalf("delivery earnings = %+v, %v", one, err)
	}
	if _, err := e.svc.MyDeliveryEarnings(asCourier(c.ID), uuid.New()); err == nil {
		t.Fatal("a delivery without earnings should not be found")
	}
	if _, err := e.svc.MyDeliveryEarnings(asOps(), delivered); err == nil {
		t.Fatal("ops should use the per-courier endpoint")
	}
}
