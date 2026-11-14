package outbox

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Retention is how long published rows are kept.
const Retention = 72 * time.Hour

// DB is the subset of a pool or transaction the maintenance queries need.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Purge deletes rows published before now − Retention and returns how many it removed.
func Purge(ctx context.Context, db DB, now time.Time) (int64, error) {
	tag, err := db.Exec(ctx,
		`DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < $1`,
		now.Add(-Retention))
	if err != nil {
		return 0, fmt.Errorf("purge outbox: %w", err)
	}
	return tag.RowsAffected(), nil
}

// Stats summarises the outbox backlog.
type Stats struct {
	Unpublished         int64      `json:"unpublished"`
	Failing             int64      `json:"failing"`
	Published           int64      `json:"published"`
	OldestUnpublishedAt *time.Time `json:"oldest_unpublished_at"`
	LastError           *string    `json:"last_error"`
}

// ReadStats returns counts of unpublished, failing and retained published rows.
func ReadStats(ctx context.Context, db DB) (Stats, error) {
	var s Stats
	err := db.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE published_at IS NULL),
			count(*) FILTER (WHERE published_at IS NULL AND attempts > 0),
			count(*) FILTER (WHERE published_at IS NOT NULL),
			min(created_at) FILTER (WHERE published_at IS NULL)
		FROM outbox`).Scan(&s.Unpublished, &s.Failing, &s.Published, &s.OldestUnpublishedAt)
	if err != nil {
		return Stats{}, fmt.Errorf("read outbox stats: %w", err)
	}
	err = db.QueryRow(ctx, `
		SELECT last_error FROM outbox
		WHERE published_at IS NULL AND last_error IS NOT NULL
		ORDER BY id LIMIT 1`).Scan(&s.LastError)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Stats{}, fmt.Errorf("read outbox stats: %w", err)
	}
	if s.OldestUnpublishedAt != nil {
		t := s.OldestUnpublishedAt.UTC()
		s.OldestUnpublishedAt = &t
	}
	return s, nil
}
