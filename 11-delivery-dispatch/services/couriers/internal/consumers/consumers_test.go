package consumers_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/pgtest"
	"deliverydispatch/services/couriers/internal/consumers"
	"deliverydispatch/services/couriers/internal/service"
	"deliverydispatch/services/couriers/internal/store/db"
	"deliverydispatch/services/couriers/migrations"
)

var t0 = time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)

type env struct {
	t     *testing.T
	svc   *service.Service
	pool  *pgxpool.Pool
	clock *clock.Manual
	proc  *inbox.Processor
	seq   int64
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvCouriers, migrations.FS)
	clk := clock.NewManual(t0)
	svc := service.New(pool, "USD", clk, idgen.Random{}, logging.Discard())
	p := inbox.NewProcessor(pool, "couriers-on-DISPATCH", consumers.DispatchHandlers(svc), clk, idgen.Random{}, logging.Discard())
	return &env{t: t, svc: svc, pool: pool, clock: clk, proc: p}
}

func asCourier(id uuid.UUID) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: id, Role: auth.RoleCourier})
}

func asOps() context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: uuid.New(), Role: auth.RoleOps})
}

func (e *env) onShiftCourier() db.Courier {
	e.t.Helper()
	c, err := e.svc.CreateCourier(asOps(), "Bola Scooter", "scooter")
	if err != nil {
		e.t.Fatal(err)
	}
	c, err = e.svc.StartShift(asCourier(c.ID), "lagos-yaba")
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// send delivers a dispatch event for delivery id and returns its envelope.
func (e *env) send(eventType string, deliveryID uuid.UUID, data map[string]any) envelope.Envelope {
	e.t.Helper()
	e.seq++
	data["delivery_id"] = deliveryID
	ev, err := envelope.New(uuid.New(), eventType, "delivery", deliveryID.String(), e.seq, e.clock.Now(), "test", data)
	if err != nil {
		e.t.Fatal(err)
	}
	e.resend(ev)
	return ev
}

func (e *env) resend(ev envelope.Envelope) {
	e.t.Helper()
	raw, err := ev.Marshal()
	if err != nil {
		e.t.Fatal(err)
	}
	if out := e.proc.Process(context.Background(), "dispatch."+ev.Type, raw, 1); !out.Ack {
		e.t.Fatalf("%s not acknowledged", ev.Type)
	}
}

func (e *env) courier(id uuid.UUID) db.Courier {
	e.t.Helper()
	c, err := e.svc.GetCourier(asOps(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

func (e *env) outbox(eventType string) []envelope.Envelope {
	e.t.Helper()
	rows, err := e.pool.Query(context.Background(), `SELECT payload FROM outbox ORDER BY id`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []envelope.Envelope
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			e.t.Fatal(err)
		}
		ev, err := envelope.Decode(raw)
		if err != nil {
			e.t.Fatal(err)
		}
		if ev.Type == eventType {
			out = append(out, ev)
		}
	}
	return out
}

func reasonOf(t *testing.T, ev envelope.Envelope) string {
	t.Helper()
	var d struct {
		Reason string `json:"reason"`
	}
	if err := ev.DecodeData(&d); err != nil {
		t.Fatal(err)
	}
	return d.Reason
}

func TestReservationOfAvailableCourier(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()

	req := e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID, "reserve_deadline": t0.Add(20 * time.Second)})
	got := e.courier(c.ID)
	if service.Status(got) != "busy" || got.ActiveDeliveryID.UUID != d || got.StatusVersion != c.StatusVersion+1 {
		t.Fatalf("courier = %+v", got)
	}
	reserved := e.outbox(service.EventReserved)
	if len(reserved) != 1 || reserved[0].Sequence != got.StatusVersion {
		t.Fatalf("reserved = %+v", reserved)
	}

	e.resend(req)
	if n := len(e.outbox(service.EventReserved)); n != 1 {
		t.Fatalf("redelivered request produced %d reserved events", n)
	}
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
	if n := len(e.outbox(service.EventReserved)); n != 2 {
		t.Fatalf("a new request for the same delivery should confirm again, got %d events", n)
	}
}

func TestReservationRejections(t *testing.T) {
	e := newEnv(t)

	off, err := e.svc.CreateCourier(asOps(), "Off Shift", "bike")
	if err != nil {
		t.Fatal(err)
	}
	e.send("delivery.courier_requested", uuid.New(), map[string]any{"courier_id": off.ID})

	busy := e.onShiftCourier()
	e.send("delivery.courier_requested", uuid.New(), map[string]any{"courier_id": busy.ID})
	e.send("delivery.courier_requested", uuid.New(), map[string]any{"courier_id": busy.ID})

	susp := e.onShiftCourier()
	if _, err := e.svc.Suspend(asOps(), susp.ID); err != nil {
		t.Fatal(err)
	}
	e.send("delivery.courier_requested", uuid.New(), map[string]any{"courier_id": susp.ID})

	rejected := e.outbox(service.EventReservationRejected)
	if len(rejected) != 3 {
		t.Fatalf("rejections = %d, want 3", len(rejected))
	}
	want := []string{"offline", "busy", "suspended"}
	for i, ev := range rejected {
		if r := reasonOf(t, ev); r != want[i] {
			t.Errorf("rejection %d reason = %s, want %s", i, r, want[i])
		}
	}
}

func TestRejectedRequestLeavesCourierUnchanged(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	if _, err := e.svc.Suspend(asOps(), c.ID); err != nil {
		t.Fatal(err)
	}
	before := e.courier(c.ID)
	e.send("delivery.courier_requested", uuid.New(), map[string]any{"courier_id": c.ID})

	after := e.courier(c.ID)
	if after.StatusVersion != before.StatusVersion || !after.UpdatedAt.Equal(before.UpdatedAt) || after.ActiveDeliveryID.Valid {
		t.Fatalf("courier changed by a rejected request: %+v", after)
	}
	rejected := e.outbox(service.EventReservationRejected)
	if len(rejected) != 1 || rejected[0].Sequence != before.StatusVersion || reasonOf(t, rejected[0]) != "suspended" {
		t.Fatalf("rejections = %+v", rejected)
	}
}

func TestReleaseBeforeRequestLeavesCourierUnattached(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()

	e.send("delivery.courier_released", d, map[string]any{"courier_id": c.ID, "reason": "reserve_timeout"})
	if got := e.courier(c.ID); got.ActiveDeliveryID.Valid {
		t.Fatalf("release for an unattached courier changed them: %+v", got)
	}
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
	if got := e.courier(c.ID); got.ActiveDeliveryID.UUID != d {
		t.Fatal("late request did not reserve the courier")
	}
	e.send("delivery.courier_released", d, map[string]any{"courier_id": c.ID, "reason": "not_reserving"})
	if got := e.courier(c.ID); got.ActiveDeliveryID.Valid || service.Status(got) != "available" {
		t.Fatalf("courier after second release = %+v", got)
	}
}

func TestReleaseForAnotherDeliveryChangesNothing(t *testing.T) {
	e := newEnv(t)
	c := e.onShiftCourier()
	d := uuid.New()
	e.send("delivery.courier_requested", d, map[string]any{"courier_id": c.ID})
	before := e.courier(c.ID)
	e.send("delivery.courier_released", uuid.New(), map[string]any{"courier_id": c.ID, "reason": "reserve_timeout"})
	if after := e.courier(c.ID); after.ActiveDeliveryID != before.ActiveDeliveryID || after.StatusVersion != before.StatusVersion {
		t.Fatalf("courier changed: %+v", after)
	}
}
