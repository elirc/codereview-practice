package consumers_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"deliverydispatch/pkg/envelope"
)

func (e *env) surge(zone string, bps int32, seq int64) {
	e.t.Helper()
	ev, err := envelope.New(uuid.New(), "surge.updated", "zone", zone, seq, e.clock.Now(), "test", map[string]any{
		"zone_id": zone, "multiplier_bps": bps,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	e.mustSend(ev)
}

func TestOlderSurgeIsIgnored(t *testing.T) {
	e := newEnv(t)
	e.surge("lagos-yaba", 15000, 3)
	e.surge("lagos-yaba", 12500, 2)
	z, err := e.svc.Queries().GetZoneSurge(context.Background(), "lagos-yaba")
	if err != nil || z.MultiplierBps != 15000 || z.Version != 3 {
		t.Fatalf("surge = %+v, %v", z, err)
	}
	e.surge("lagos-yaba", 10000, 4)
	if z, _ := e.svc.Queries().GetZoneSurge(context.Background(), "lagos-yaba"); z.MultiplierBps != 10000 {
		t.Fatalf("newer surge not applied: %+v", z)
	}
}
