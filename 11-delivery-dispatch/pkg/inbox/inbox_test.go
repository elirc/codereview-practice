package inbox

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/pgtest"
)

func TestNakDelaySchedule(t *testing.T) {
	want := map[uint64]time.Duration{
		0: time.Second,
		1: time.Second,
		2: 2 * time.Second,
		3: 4 * time.Second,
		4: 8 * time.Second,
		5: 16 * time.Second,
		6: 30 * time.Second,
		7: 30 * time.Second,
		9: 30 * time.Second,
	}
	for n, d := range want {
		if got := NakDelay(n); got != d {
			t.Errorf("NakDelay(%d) = %v, want %v", n, got, d)
		}
	}
}

var t0 = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

func setup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvOrders, nil)
	pgtest.Exec(t, pool, pgtest.MessagingSchema)
	pgtest.Exec(t, pool, `CREATE TABLE effects (n serial PRIMARY KEY, event_id uuid NOT NULL)`)
	return pool
}

func testEnvelope(t *testing.T, eventType string) []byte {
	t.Helper()
	env, err := envelope.New(uuid.New(), eventType, "thing", uuid.NewString(), 1, t0, "req-1", map[string]string{"k": "v"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := env.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func recordEffect(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
	_, err := tx.Exec(ctx, `INSERT INTO effects (event_id) VALUES ($1)`, env.ID)
	return err
}

func count(t *testing.T, pool *pgxpool.Pool, sql string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func newProcessor(pool *pgxpool.Pool, handlers map[string]Handler) *Processor {
	return NewProcessor(pool, "test-on-THINGS", handlers, clock.NewManual(t0), idgen.Random{}, logging.Discard())
}

func TestProcessAppliesAnEventOnceWhenDeliveredTwice(t *testing.T) {
	pool := setup(t)
	p := newProcessor(pool, map[string]Handler{"thing.happened": recordEffect})
	msg := testEnvelope(t, "thing.happened")
	ctx := context.Background()

	for i := uint64(1); i <= 2; i++ {
		if out := p.Process(ctx, "things.thing.happened", msg, i); !out.Ack {
			t.Fatalf("delivery %d not acked", i)
		}
	}
	if n := count(t, pool, `SELECT count(*) FROM effects`); n != 1 {
		t.Fatalf("effects = %d, want 1", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM inbox`); n != 1 {
		t.Fatalf("inbox rows = %d, want 1", n)
	}
}

func TestProcessConcurrentCopiesOfOneEvent(t *testing.T) {
	pool := setup(t)
	p := newProcessor(pool, map[string]Handler{"thing.happened": recordEffect})
	msg := testEnvelope(t, "thing.happened")

	var wg sync.WaitGroup
	var acked atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if p.Process(context.Background(), "things.thing.happened", msg, 1).Ack {
				acked.Add(1)
			}
		}()
	}
	wg.Wait()
	if acked.Load() != 8 {
		t.Fatalf("acked = %d, want 8", acked.Load())
	}
	if n := count(t, pool, `SELECT count(*) FROM effects`); n != 1 {
		t.Fatalf("effects = %d, want 1", n)
	}
}

func TestHandlerFailureLeavesNoInboxRowOrEffect(t *testing.T) {
	pool := setup(t)
	var fail atomic.Bool
	fail.Store(true)
	p := newProcessor(pool, map[string]Handler{"thing.happened": func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		if err := recordEffect(ctx, tx, env); err != nil {
			return err
		}
		if fail.Load() {
			return errors.New("downstream not ready")
		}
		return nil
	}})
	msg := testEnvelope(t, "thing.happened")
	ctx := context.Background()

	out := p.Process(ctx, "things.thing.happened", msg, 3)
	if out.Ack || out.Delay != 4*time.Second {
		t.Fatalf("outcome = %+v, want nak after 4s", out)
	}
	if n := count(t, pool, `SELECT count(*) FROM effects`) + count(t, pool, `SELECT count(*) FROM inbox`); n != 0 {
		t.Fatalf("rows left behind: %d", n)
	}

	fail.Store(false)
	if out := p.Process(ctx, "things.thing.happened", msg, 4); !out.Ack {
		t.Fatal("redelivery not acked")
	}
	if n := count(t, pool, `SELECT count(*) FROM effects`); n != 1 {
		t.Fatalf("effects = %d, want 1", n)
	}
}

func TestDeadLetterAtDeliveryLimitThenReplay(t *testing.T) {
	pool := setup(t)
	var fail atomic.Bool
	fail.Store(true)
	p := newProcessor(pool, map[string]Handler{
		"thing.happened": func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
			if fail.Load() {
				return errors.New("row missing")
			}
			return recordEffect(ctx, tx, env)
		},
		"thing.other": recordEffect,
	})
	ctx := context.Background()
	bad := testEnvelope(t, "thing.happened")

	if out := p.Process(ctx, "things.thing.happened", bad, MaxDeliveries-1); out.Ack {
		t.Fatal("acked before the delivery limit")
	}
	if out := p.Process(ctx, "things.thing.happened", bad, MaxDeliveries); !out.Ack {
		t.Fatal("not acked at the delivery limit")
	}
	letters, err := ListDeadLetters(ctx, pool, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(letters) != 1 || letters[0].DeliveryCount != MaxDeliveries || letters[0].Payload == nil {
		t.Fatalf("dead letters = %+v", letters)
	}

	if out := p.Process(ctx, "things.thing.other", testEnvelope(t, "thing.other"), 1); !out.Ack {
		t.Fatal("later message not processed")
	}

	if err := p.Replay(ctx, letters[0].ID); err == nil {
		t.Fatal("replay should fail while the cause persists")
	}
	fail.Store(false)
	if err := p.Replay(ctx, letters[0].ID); err != nil {
		t.Fatalf("replay: %v", err)
	}
	var ae *apperr.Error
	if err := p.Replay(ctx, letters[0].ID); !errors.As(err, &ae) || ae.Code != "already_replayed" {
		t.Fatalf("second replay err = %v", err)
	}
	if n := count(t, pool, `SELECT count(*) FROM effects`); n != 2 {
		t.Fatalf("effects = %d, want 2", n)
	}
	if out := p.Process(ctx, "things.thing.happened", bad, MaxDeliveries+1); !out.Ack {
		t.Fatal("late redelivery not acked")
	}
	if n := count(t, pool, `SELECT count(*) FROM effects`); n != 2 {
		t.Fatalf("effects after late redelivery = %d, want 2", n)
	}
}

func TestInvalidEnvelopeIsDeadLetteredAndAcked(t *testing.T) {
	pool := setup(t)
	p := newProcessor(pool, map[string]Handler{"thing.happened": recordEffect})
	if out := p.Process(context.Background(), "things.thing.happened", []byte("not json"), 1); !out.Ack {
		t.Fatal("invalid envelope not acked")
	}
	letters, err := ListDeadLetters(context.Background(), pool, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(letters) != 1 || letters[0].EventID != nil || string(letters[0].RawPayload) != "not json" {
		t.Fatalf("dead letters = %+v", letters)
	}
}

func TestUnhandledTypeIsAckedWithoutEffect(t *testing.T) {
	pool := setup(t)
	p := newProcessor(pool, map[string]Handler{"thing.happened": recordEffect})
	if out := p.Process(context.Background(), "things.thing.ignored", testEnvelope(t, "thing.ignored"), 1); !out.Ack {
		t.Fatal("unhandled type not acked")
	}
	if n := count(t, pool, `SELECT count(*) FROM inbox`) + count(t, pool, `SELECT count(*) FROM effects`); n != 0 {
		t.Fatalf("rows written: %d", n)
	}
}

func TestPurgeRemovesOldInboxRows(t *testing.T) {
	pool := setup(t)
	pgtest.Exec(t, pool, `INSERT INTO inbox (consumer, event_id, processed_at) VALUES ('c', $1, $2), ('c', $3, $4)`,
		uuid.New(), t0.Add(-15*24*time.Hour), uuid.New(), t0.Add(-13*24*time.Hour))
	n, err := Purge(context.Background(), pool, t0)
	if err != nil || n != 1 {
		t.Fatalf("purged %d, err %v", n, err)
	}
}

func TestTruncateKeepsValidUTF8(t *testing.T) {
	long := strings.Repeat("é", 1500)
	got := truncate(long, 2001)
	if len(got) != 2000 || !utf8.ValidString(got) {
		t.Fatalf("truncate kept %d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}
