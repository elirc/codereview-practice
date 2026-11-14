// Package outbox writes events to a service's outbox table and relays them to
// JetStream.
package outbox

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/pkg/idgen"
)

// Event describes one fact to record in the outbox.
type Event struct {
	Type          string
	AggregateType string
	AggregateID   string
	Sequence      int64
	OccurredAt    time.Time
	Data          any
}

// Emitter turns Events into envelopes under one subject prefix.
type Emitter struct {
	prefix string
	ids    idgen.Generator
}

// NewEmitter returns an Emitter publishing under "<prefix>.<type>".
func NewEmitter(prefix string, ids idgen.Generator) *Emitter {
	return &Emitter{prefix: prefix, ids: ids}
}

// Subject returns the subject an event type is published on.
func (e *Emitter) Subject(eventType string) string {
	return e.prefix + "." + eventType
}

// Emit writes ev to the outbox within tx and returns the envelope it stored.
// The request id is taken from ctx.
func (e *Emitter) Emit(ctx context.Context, tx pgx.Tx, ev Event) (envelope.Envelope, error) {
	env, err := envelope.New(e.ids.NewID(), ev.Type, ev.AggregateType, ev.AggregateID, ev.Sequence, ev.OccurredAt, httpx.RequestIDFrom(ctx), ev.Data)
	if err != nil {
		return envelope.Envelope{}, err
	}
	if err := Insert(ctx, tx, e.Subject(ev.Type), env); err != nil {
		return envelope.Envelope{}, err
	}
	return env, nil
}

// Insert stores env as an unpublished outbox row within tx.
func Insert(ctx context.Context, tx pgx.Tx, subject string, env envelope.Envelope) error {
	payload, err := env.Marshal()
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO outbox (event_id, subject, payload, created_at) VALUES ($1, $2, $3, $4)`,
		env.ID, subject, payload, env.OccurredAt)
	if err != nil {
		return fmt.Errorf("insert outbox row: %w", err)
	}
	return nil
}
