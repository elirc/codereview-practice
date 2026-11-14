package outbox

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/pgxtx"
)

// RelayLockKey is the advisory-lock key relays take in their database.
const RelayLockKey int64 = 0x64645f6f7574626f

// Relay defaults.
const (
	DefaultInterval  = 200 * time.Millisecond
	DefaultBatchSize = 100
	PublishTimeout   = 5 * time.Second
	maxBackoff       = 30 * time.Second
)

// Publisher sends one payload to the broker and returns once it is acknowledged.
type Publisher interface {
	Publish(ctx context.Context, subject, msgID string, payload []byte) error
}

// Relay publishes unpublished outbox rows in id order.
type Relay struct {
	db        pgxtx.Beginner
	publisher Publisher
	logger    *slog.Logger
	batchSize int
}

// NewRelay returns a Relay reading from db and publishing through publisher.
func NewRelay(db pgxtx.Beginner, publisher Publisher, logger *slog.Logger) *Relay {
	return &Relay{db: db, publisher: publisher, logger: logger, batchSize: DefaultBatchSize}
}

type pendingRow struct {
	id      int64
	eventID uuid.UUID
	subject string
	payload []byte
}

// RunOnce publishes up to one batch and returns how many rows it marked
// published, and an error when a publish failed.
func (r *Relay) RunOnce(ctx context.Context, now time.Time) (int, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin relay pass: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, RelayLockKey).Scan(&locked); err != nil {
		return 0, fmt.Errorf("take relay lock: %w", err)
	}
	if !locked {
		return 0, nil
	}

	rows, err := tx.Query(ctx,
		`SELECT id, event_id, subject, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`,
		r.batchSize)
	if err != nil {
		return 0, fmt.Errorf("read outbox: %w", err)
	}
	var batch []pendingRow
	for rows.Next() {
		var p pendingRow
		if err := rows.Scan(&p.id, &p.eventID, &p.subject, &p.payload); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan outbox row: %w", err)
		}
		batch = append(batch, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("read outbox: %w", err)
	}

	var published []int64
	var publishErr error
	for _, p := range batch {
		pctx, cancel := context.WithTimeout(ctx, PublishTimeout)
		perr := r.publisher.Publish(pctx, p.subject, p.eventID.String(), p.payload)
		cancel()
		if perr != nil {
			publishErr = fmt.Errorf("publish outbox row %d: %w", p.id, perr)
			if _, err := tx.Exec(ctx,
				`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
				p.id, truncate(perr.Error(), 500)); err != nil {
				return 0, fmt.Errorf("record publish failure: %w", err)
			}
			break
		}
		published = append(published, p.id)
	}

	if len(published) > 0 {
		if _, err := tx.Exec(ctx,
			`UPDATE outbox SET published_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = ANY($1)`,
			published, now); err != nil {
			return 0, fmt.Errorf("mark outbox rows published: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit relay pass: %w", err)
	}
	return len(published), publishErr
}

// Run calls RunOnce every interval until ctx is done, backing off after
// failed passes. A pass in progress when ctx is cancelled runs to completion.
func (r *Relay) Run(ctx context.Context, clk clock.Clock, interval time.Duration) {
	failures := 0
	wait := interval
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		n, err := r.RunOnce(context.WithoutCancel(ctx), clk.Now())
		if err != nil {
			failures++
			wait = Backoff(failures)
			r.logger.Warn("outbox relay pass failed", "error", err.Error(), "published", n, "failures", failures, "retry_in_ms", wait.Milliseconds())
			continue
		}
		if n > 0 {
			r.logger.Debug("outbox relay pass", "published", n)
		}
		failures = 0
		wait = interval
	}
}

// Backoff returns the wait after the given number of consecutive failed
// passes: min(30s, 200ms × 2^failures).
func Backoff(failures int) time.Duration {
	if failures <= 0 {
		return DefaultInterval
	}
	d := DefaultInterval
	for i := 0; i < failures; i++ {
		d *= 2
		if d >= maxBackoff {
			return maxBackoff
		}
	}
	return d
}

// truncate returns at most the first n bytes of s, dropping a character
// that the cut would split.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
