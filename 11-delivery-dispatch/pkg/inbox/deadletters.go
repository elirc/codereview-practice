package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/pkg/pgxtx"
)

// DB is the subset of a pool or transaction the dead-letter queries need.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// DeadLetter is a message that exhausted its deliveries.
type DeadLetter struct {
	ID            uuid.UUID       `json:"id"`
	Consumer      string          `json:"consumer"`
	EventID       *uuid.UUID      `json:"event_id"`
	Subject       string          `json:"subject"`
	Payload       json.RawMessage `json:"payload,omitempty"`
	RawPayload    []byte          `json:"raw_payload,omitempty"`
	Error         string          `json:"error"`
	DeliveryCount int32           `json:"delivery_count"`
	CreatedAt     time.Time       `json:"created_at"`
	ReplayedAt    *time.Time      `json:"replayed_at"`
}

// ListDeadLetters returns up to limit dead letters, newest first.
func ListDeadLetters(ctx context.Context, db DB, limit int) ([]DeadLetter, error) {
	rows, err := db.Query(ctx, `
		SELECT id, consumer, event_id, subject, payload, error, delivery_count, created_at, replayed_at
		FROM dead_letters
		ORDER BY created_at DESC, id
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list dead letters: %w", err)
	}
	defer rows.Close()
	out := []DeadLetter{}
	for rows.Next() {
		var d DeadLetter
		var eventID uuid.NullUUID
		var payload []byte
		if err := rows.Scan(&d.ID, &d.Consumer, &eventID, &d.Subject, &payload, &d.Error, &d.DeliveryCount, &d.CreatedAt, &d.ReplayedAt); err != nil {
			return nil, fmt.Errorf("scan dead letter: %w", err)
		}
		if eventID.Valid {
			id := eventID.UUID
			d.EventID = &id
		}
		if json.Valid(payload) {
			d.Payload = payload
		} else {
			d.RawPayload = payload
		}
		d.CreatedAt = d.CreatedAt.UTC()
		if d.ReplayedAt != nil {
			t := d.ReplayedAt.UTC()
			d.ReplayedAt = &t
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ConsumerOf returns the consumer that wrote dead letter id.
func ConsumerOf(ctx context.Context, db DB, id uuid.UUID) (string, error) {
	var consumer string
	err := db.QueryRow(ctx, `SELECT consumer FROM dead_letters WHERE id = $1`, id).Scan(&consumer)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apperr.NotFound()
	}
	if err != nil {
		return "", fmt.Errorf("load dead letter: %w", err)
	}
	return consumer, nil
}

// Replay runs dead letter id through the inbox and its handler again and marks
// it replayed when the handler succeeds.
func (p *Processor) Replay(ctx context.Context, id uuid.UUID) error {
	err := pgxtx.WithTx(ctx, p.db, func(tx pgx.Tx) error {
		var consumer string
		var payload []byte
		var replayedAt *time.Time
		err := tx.QueryRow(ctx,
			`SELECT consumer, payload, replayed_at FROM dead_letters WHERE id = $1 FOR UPDATE`, id).
			Scan(&consumer, &payload, &replayedAt)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && consumer != p.consumer) {
			return apperr.NotFound()
		}
		if err != nil {
			return fmt.Errorf("load dead letter: %w", err)
		}
		if replayedAt != nil {
			return apperr.Conflict("already_replayed", "The dead letter has already been replayed.")
		}
		env, err := envelope.Decode(payload)
		if err != nil {
			return apperr.Unprocessable("replay_failed", "The dead letter does not hold a valid event.")
		}
		h, ok := p.handlers[env.Type]
		if !ok {
			return apperr.Unprocessable("replay_failed", "No handler exists for the dead letter's event type.")
		}
		hctx := httpx.WithRequestID(ctx, env.RequestID)
		inserted, err := p.record(hctx, tx, env.ID)
		if err != nil {
			return err
		}
		if inserted {
			if err := h(hctx, tx, env); err != nil {
				p.logger.Warn("dead letter replay failed", "dead_letter_id", id, "event_id", env.ID, "type", env.Type, "error", err.Error())
				return apperr.Unprocessable("replay_failed", "The handler failed again; the dead letter is unchanged.")
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE dead_letters SET replayed_at = $2 WHERE id = $1`, id, p.clock.Now()); err != nil {
			return fmt.Errorf("mark dead letter replayed: %w", err)
		}
		p.logger.Info("dead letter replayed", "dead_letter_id", id, "event_id", env.ID, "type", env.Type)
		return nil
	})
	return err
}

// Purge deletes inbox rows processed before now − Retention and returns how many it removed.
func Purge(ctx context.Context, db DB, now time.Time) (int64, error) {
	tag, err := db.Exec(ctx, `DELETE FROM inbox WHERE processed_at < $1`, now.Add(-Retention))
	if err != nil {
		return 0, fmt.Errorf("purge inbox: %w", err)
	}
	return tag.RowsAffected(), nil
}
