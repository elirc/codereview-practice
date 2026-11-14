package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	dt "deliverydispatch/services/dispatch/internal/dispatchtest"
)

func TestSurgeLoopUpdatesOnChangeOnly(t *testing.T) {
	e := dt.New(t)
	ctx := context.Background()
	e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 3000))
	e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 3100))
	e.ConfirmOrder("lagos-yaba")

	n, err := e.Svc.RunSurge(ctx, e.Clock.Now())
	if err != nil || n != 1 {
		t.Fatalf("changed %d zones, %v", n, err)
	}
	z, err := e.Svc.ZoneSurge(dt.AsOps(), "lagos-yaba")
	if err != nil || z.MultiplierBps != 12500 || z.Version != 1 {
		t.Fatalf("surge = %+v, %v", z, err)
	}
	if n, _ := e.Svc.RunSurge(ctx, e.Clock.Now()); n != 0 {
		t.Fatalf("unchanged surge emitted again (%d)", n)
	}

	e.ConfirmOrder("lagos-yaba")
	e.Clock.Advance(dt.Config.PositionMaxAge + time.Second)
	if n, _ := e.Svc.RunSurge(ctx, e.Clock.Now()); n != 1 {
		t.Fatal("stale positions should drop supply and raise surge")
	}
	z, _ = e.Svc.ZoneSurge(dt.AsOps(), "lagos-yaba")
	if z.MultiplierBps != 20000 || z.Version != 2 {
		t.Fatalf("surge = %+v", z)
	}
	events := e.Outbox("surge.updated")
	if len(events) != 2 || events[1].Sequence != 2 || events[1].AggregateID != "lagos-yaba" {
		t.Fatalf("surge events = %+v", events)
	}
	_, err = e.Svc.ZoneSurge(dt.AsCourier(uuid.New()), "lagos-yaba")
	wantCode(t, err, "forbidden")
}
