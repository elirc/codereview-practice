package service

import (
	"testing"

	"github.com/google/uuid"

	"deliverydispatch/services/couriers/internal/domain"
)

func TestCreateCourierRecordsOfflineStatus(t *testing.T) {
	e := newEnv(t)
	c := e.courier(t)
	if Status(c) != domain.StatusOffline || c.StatusVersion != 1 {
		t.Fatalf("courier = %+v", c)
	}
	evs := e.eventsOfType(t, EventStatusChanged)
	if len(evs) != 1 || evs[0].Sequence != 1 || evs[0].AggregateID != c.ID.String() {
		t.Fatalf("events = %+v", evs)
	}
	_, err := e.svc.CreateCourier(asCourier(uuid.New()), "Self Made", "car")
	wantCode(t, err, "forbidden")
}

func TestShiftRules(t *testing.T) {
	e := newEnv(t)
	c := e.courier(t)
	ctx := asCourier(c.ID)

	started, err := e.svc.StartShift(ctx, "lagos-yaba")
	if err != nil || Status(started) != domain.StatusAvailable || started.StatusVersion != 2 {
		t.Fatalf("start = %+v, %v", started, err)
	}
	again, err := e.svc.StartShift(ctx, "lagos-yaba")
	if err != nil || again.StatusVersion != 2 {
		t.Fatalf("repeat start = %+v, %v", again, err)
	}
	_, err = e.svc.StartShift(ctx, "lagos-ikeja")
	wantCode(t, err, "shift_active")

	ended, err := e.svc.EndShift(ctx)
	if err != nil || Status(ended) != domain.StatusOffline || ended.StatusVersion != 3 {
		t.Fatalf("end = %+v, %v", ended, err)
	}
	if _, err := e.svc.StartShift(ctx, "lagos-ikeja"); err != nil {
		t.Fatalf("start in new zone after ending: %v", err)
	}

	evs := e.eventsOfType(t, EventStatusChanged)
	if len(evs) != 4 {
		t.Fatalf("status events = %d, want 4", len(evs))
	}
	for i, ev := range evs {
		if ev.Sequence != int64(i+1) {
			t.Fatalf("event %d has sequence %d", i, ev.Sequence)
		}
	}
}

func TestSuspensionAndReinstatement(t *testing.T) {
	e := newEnv(t)
	c := e.onShift(t, "lagos-yaba")

	s, err := e.svc.Suspend(asOps(), c.ID)
	if err != nil || Status(s) != domain.StatusOffline || !s.Suspended || s.ShiftZoneID != nil {
		t.Fatalf("suspended = %+v, %v", s, err)
	}
	_, err = e.svc.StartShift(asCourier(c.ID), "lagos-yaba")
	wantCode(t, err, "courier_suspended")

	r, err := e.svc.Reinstate(asOps(), c.ID)
	if err != nil || r.Suspended || Status(r) != domain.StatusOffline {
		t.Fatalf("reinstated = %+v, %v", r, err)
	}
	_, err = e.svc.Suspend(asCourier(c.ID), c.ID)
	wantCode(t, err, "forbidden")
	_, err = e.svc.Suspend(asOps(), uuid.New())
	wantCode(t, err, "not_found")
}

func TestCourierReadPermissions(t *testing.T) {
	e := newEnv(t)
	c := e.courier(t)
	if me, err := e.svc.Me(asCourier(c.ID)); err != nil || me.ID != c.ID {
		t.Fatalf("me = %+v, %v", me, err)
	}
	if _, err := e.svc.GetCourier(asOps(), c.ID); err != nil {
		t.Fatal(err)
	}
	_, err := e.svc.GetCourier(asCourier(c.ID), c.ID)
	wantCode(t, err, "forbidden")
	_, err = e.svc.Me(asOps())
	wantCode(t, err, "forbidden")
}
