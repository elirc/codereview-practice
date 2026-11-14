package service

import (
	"context"
	"testing"
	"time"
)

func TestLocationStorageAndPublishThrottling(t *testing.T) {
	e := newEnv(t)
	c := e.onShift(t, "lagos-yaba")
	ctx := asCourier(c.ID)
	lon, lat := 3.3792, 6.5244

	ping := func(dLon float64, recorded time.Time) error {
		return e.svc.ReportLocation(ctx, Ping{Lon: lon + dLon, Lat: lat, RecordedAt: recorded})
	}
	if err := ping(0, t0); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(4 * time.Second)
	if err := ping(0, t0.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	if n := len(e.eventsOfType(t, EventLocationUpdated)); n != 1 {
		t.Fatalf("pings 4s apart without movement published %d events, want 1", n)
	}

	e.clock.Advance(time.Second)
	if err := ping(0.00055, t0.Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	evs := e.eventsOfType(t, EventLocationUpdated)
	if len(evs) != 2 || evs[1].Sequence != 2 {
		t.Fatalf("a ping 60 m away should publish at once: %+v", evs)
	}

	err := e.svc.ReportLocation(ctx, Ping{Lon: lon, Lat: lat, RecordedAt: e.clock.Now().Add(31 * time.Second)})
	wantCode(t, err, "timestamp_in_future")

	if err := ping(0.01, e.clock.Now().Add(-6*time.Minute)); err != nil {
		t.Fatalf("old ping should be accepted: %v", err)
	}
	if err := ping(0.01, t0.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	stored, err := e.svc.Me(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !stored.PositionAt.Equal(t0.Add(5*time.Second)) || *stored.Lon != lon+0.00055 {
		t.Fatalf("older pings changed the stored position: %v %v", stored.PositionAt, *stored.Lon)
	}
	if n := len(e.eventsOfType(t, EventLocationUpdated)); n != 2 {
		t.Fatalf("events = %d, want 2", n)
	}
}

func TestLocationOffShiftIsStoredButNotPublished(t *testing.T) {
	e := newEnv(t)
	c := e.courier(t)
	if err := e.svc.ReportLocation(asCourier(c.ID), Ping{Lon: 3.38, Lat: 6.52, RecordedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if n := len(e.eventsOfType(t, EventLocationUpdated)); n != 0 {
		t.Fatalf("off-shift ping published %d events", n)
	}
	var lon *float64
	if err := e.pool.QueryRow(context.Background(), `SELECT lon FROM couriers WHERE id = $1`, c.ID).Scan(&lon); err != nil || lon == nil {
		t.Fatalf("position not stored: %v %v", lon, err)
	}
}
