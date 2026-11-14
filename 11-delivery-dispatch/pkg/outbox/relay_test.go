package outbox

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/pgtest"
	"deliverydispatch/pkg/pgxtx"
)

func TestBackoff(t *testing.T) {
	tests := map[int]time.Duration{
		0:  200 * time.Millisecond,
		1:  400 * time.Millisecond,
		2:  800 * time.Millisecond,
		5:  6400 * time.Millisecond,
		7:  25600 * time.Millisecond,
		8:  30 * time.Second,
		50: 30 * time.Second,
	}
	for failures, want := range tests {
		if got := Backoff(failures); got != want {
			t.Errorf("Backoff(%d) = %v, want %v", failures, got, want)
		}
	}
}

var t0 = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

type sent struct {
	subject, msgID string
}

type fakePublisher struct {
	mu     sync.Mutex
	sent   []sent
	failOn map[string]bool
}

func (f *fakePublisher) Publish(_ context.Context, subject, msgID string, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn[msgID] {
		return errors.New("nats: no responders available for request")
	}
	f.sent = append(f.sent, sent{subject: subject, msgID: msgID})
	return nil
}

func (f *fakePublisher) ids() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.sent))
	for i, s := range f.sent {
		out[i] = s.msgID
	}
	return out
}

func setup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvOrders, nil)
	pgtest.Exec(t, pool, pgtest.MessagingSchema)
	return pool
}

func emitN(t *testing.T, pool *pgxpool.Pool, n int) []string {
	t.Helper()
	em := NewEmitter("orders", idgen.Random{})
	var ids []string
	for i := 0; i < n; i++ {
		err := pgxtx.WithTx(context.Background(), pool, func(tx pgx.Tx) error {
			env, err := em.Emit(context.Background(), tx, Event{
				Type:          "order.confirmed",
				AggregateType: "order",
				AggregateID:   uuid.NewString(),
				Sequence:      int64(i + 1),
				OccurredAt:    t0,
				Data:          map[string]int{"i": i},
			})
			ids = append(ids, env.ID.String())
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return ids
}

func unpublished(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox WHERE published_at IS NULL`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRelayPublishesInIDOrderAndMarksRows(t *testing.T) {
	pool := setup(t)
	ids := emitN(t, pool, 3)
	pub := &fakePublisher{}
	r := NewRelay(pool, pub, logging.Discard())

	n, err := r.RunOnce(context.Background(), t0)
	if err != nil || n != 3 {
		t.Fatalf("RunOnce = %d, %v", n, err)
	}
	if !equal(pub.ids(), ids) {
		t.Fatalf("published %v, want %v", pub.ids(), ids)
	}
	if pub.sent[0].subject != "orders.order.confirmed" {
		t.Fatalf("subject = %s", pub.sent[0].subject)
	}
	if u := unpublished(t, pool); u != 0 {
		t.Fatalf("unpublished = %d", u)
	}
	if n, _ := r.RunOnce(context.Background(), t0); n != 0 {
		t.Fatalf("second pass published %d", n)
	}
}

func TestRelayStopsAtFirstFailureAndResumesInOrder(t *testing.T) {
	pool := setup(t)
	ids := emitN(t, pool, 3)
	pub := &fakePublisher{failOn: map[string]bool{ids[1]: true}}
	r := NewRelay(pool, pub, logging.Discard())

	n, err := r.RunOnce(context.Background(), t0)
	if err == nil || n != 1 {
		t.Fatalf("RunOnce = %d, %v; want 1 and an error", n, err)
	}
	var attempts int
	var lastErr *string
	if err := pool.QueryRow(context.Background(),
		`SELECT attempts, last_error FROM outbox WHERE event_id = $1`, uuid.MustParse(ids[1])).Scan(&attempts, &lastErr); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || lastErr == nil {
		t.Fatalf("attempts = %d, last_error = %v", attempts, lastErr)
	}
	if u := unpublished(t, pool); u != 2 {
		t.Fatalf("unpublished = %d, want 2", u)
	}

	pub.mu.Lock()
	pub.failOn = nil
	pub.mu.Unlock()
	if n, err := r.RunOnce(context.Background(), t0); err != nil || n != 2 {
		t.Fatalf("resume = %d, %v", n, err)
	}
	if !equal(pub.ids(), ids) {
		t.Fatalf("published %v, want %v", pub.ids(), ids)
	}
}

func TestRelaySkipsPassWhileAnotherRelayHoldsTheLock(t *testing.T) {
	pool := setup(t)
	emitN(t, pool, 2)
	ctx := context.Background()

	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, RelayLockKey); err != nil {
		t.Fatal(err)
	}
	pub := &fakePublisher{}
	r := NewRelay(pool, pub, logging.Discard())
	if n, err := r.RunOnce(ctx, t0); err != nil || n != 0 {
		t.Fatalf("RunOnce under lock = %d, %v", n, err)
	}
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if n, err := r.RunOnce(ctx, t0); err != nil || n != 2 {
		t.Fatalf("RunOnce after release = %d, %v", n, err)
	}
}

func TestTwoRelaysPublishEachRowOnce(t *testing.T) {
	pool := setup(t)
	ids := emitN(t, pool, 20)
	pub := &fakePublisher{}
	a := NewRelay(pool, pub, logging.Discard())
	b := NewRelay(pool, pub, logging.Discard())

	var wg sync.WaitGroup
	for _, r := range []*Relay{a, b} {
		wg.Add(1)
		go func(r *Relay) {
			defer wg.Done()
			for i := 0; i < 5; i++ {
				if _, err := r.RunOnce(context.Background(), t0); err != nil {
					t.Error(err)
				}
			}
		}(r)
	}
	wg.Wait()
	for unpublished(t, pool) > 0 {
		if _, err := a.RunOnce(context.Background(), t0); err != nil {
			t.Fatal(err)
		}
	}
	if !equal(pub.ids(), ids) {
		t.Fatalf("published %d messages %v, want each of %d once in order", len(pub.ids()), pub.ids(), len(ids))
	}
}

func TestPurgeKeepsRecentAndUnpublishedRows(t *testing.T) {
	pool := setup(t)
	emitN(t, pool, 3)
	ctx := context.Background()
	pgtest.Exec(t, pool, `UPDATE outbox SET published_at = $1 WHERE id = (SELECT min(id) FROM outbox)`, t0.Add(-73*time.Hour))
	pgtest.Exec(t, pool, `UPDATE outbox SET published_at = $1 WHERE id = (SELECT max(id) FROM outbox)`, t0.Add(-71*time.Hour))
	n, err := Purge(ctx, pool, t0)
	if err != nil || n != 1 {
		t.Fatalf("purged %d, %v", n, err)
	}
	s, err := ReadStats(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if s.Unpublished != 1 || s.Published != 1 {
		t.Fatalf("stats = %+v", s)
	}
}

func TestTruncateKeepsValidUTF8(t *testing.T) {
	tests := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"abcdef", 3, "abc"},
		{"naïve", 3, "na"},
		{"naïve", 4, "naï"},
		{"₦500", 2, ""},
	}
	for _, tt := range tests {
		got := truncate(tt.in, tt.n)
		if got != tt.want || !utf8.ValidString(got) {
			t.Errorf("truncate(%q, %d) = %q, want %q", tt.in, tt.n, got, tt.want)
		}
	}
}
