// Package inbox runs event handlers inside a transaction that also records the
// event in the consumer's inbox, and moves messages that keep failing to the
// dead_letters table.
package inbox

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/pgxtx"
)

// MaxDeliveries is the delivery count at which a failing message is dead-lettered.
const MaxDeliveries = 8

// Retention is how long inbox rows are kept.
const Retention = 14 * 24 * time.Hour

// Handler applies one event within tx.
type Handler func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error

// Outcome tells the caller how to settle a message.
type Outcome struct {
	Ack   bool
	Delay time.Duration
}

// Processor handles messages for one named consumer.
type Processor struct {
	db       pgxtx.Beginner
	consumer string
	handlers map[string]Handler
	clock    clock.Clock
	ids      idgen.Generator
	logger   *slog.Logger
}

// NewProcessor returns a Processor for consumer dispatching on event type.
func NewProcessor(db pgxtx.Beginner, consumer string, handlers map[string]Handler, clk clock.Clock, ids idgen.Generator, logger *slog.Logger) *Processor {
	return &Processor{
		db:       db,
		consumer: consumer,
		handlers: handlers,
		clock:    clk,
		ids:      ids,
		logger:   logger.With("consumer", consumer),
	}
}

// Consumer returns the consumer name.
func (p *Processor) Consumer() string {
	return p.consumer
}

// Types returns the handled event types in sorted order.
func (p *Processor) Types() []string {
	types := make([]string, 0, len(p.handlers))
	for t := range p.handlers {
		types = append(types, t)
	}
	sort.Strings(types)
	return types
}

// NakDelay returns the redelivery delay after a failed delivery:
// min(30s, 1s × 2^(numDelivered−1)).
func NakDelay(numDelivered uint64) time.Duration {
	if numDelivered <= 1 {
		return time.Second
	}
	d := time.Second
	for i := uint64(1); i < numDelivered; i++ {
		d *= 2
		if d >= 30*time.Second {
			return 30 * time.Second
		}
	}
	return d
}

// Process handles one delivery of a message and returns how to settle it.
func (p *Processor) Process(ctx context.Context, subject string, payload []byte, numDelivered uint64) Outcome {
	env, err := envelope.Decode(payload)
	if err != nil {
		p.logger.Warn("invalid envelope", "subject", subject, "delivery_count", numDelivered, "error", err.Error())
		if dlErr := p.deadLetter(ctx, uuid.NullUUID{}, subject, payload, err, numDelivered); dlErr != nil {
			p.logger.Error("dead letter write failed", "subject", subject, "error", dlErr.Error())
			return Outcome{Delay: NakDelay(numDelivered)}
		}
		return Outcome{Ack: true}
	}

	log := p.logger.With("event_id", env.ID, "type", env.Type, "delivery_count", numDelivered)
	h, ok := p.handlers[env.Type]
	if !ok {
		log.Info("event type not handled")
		return Outcome{Ack: true}
	}

	ctx = httpx.WithRequestID(ctx, env.RequestID)
	seen, err := p.apply(ctx, env, h)
	if err == nil {
		if seen {
			log.Debug("event already processed")
		} else {
			log.Info("event processed")
		}
		return Outcome{Ack: true}
	}

	if numDelivered >= MaxDeliveries {
		if dlErr := p.deadLetter(ctx, uuid.NullUUID{UUID: env.ID, Valid: true}, subject, payload, err, numDelivered); dlErr != nil {
			log.Error("dead letter write failed", "error", dlErr.Error(), "handler_error", err.Error())
			return Outcome{Delay: NakDelay(numDelivered)}
		}
		log.Error("event moved to dead letters", "error", err.Error())
		return Outcome{Ack: true}
	}
	log.Warn("event handler failed", "error", err.Error())
	return Outcome{Delay: NakDelay(numDelivered)}
}

// apply records env in the inbox and runs h in the same transaction. It
// reports true when the inbox already held the event.
func (p *Processor) apply(ctx context.Context, env envelope.Envelope, h Handler) (bool, error) {
	var seen bool
	err := pgxtx.WithTx(ctx, p.db, func(tx pgx.Tx) error {
		inserted, err := p.record(ctx, tx, env.ID)
		if err != nil {
			return err
		}
		if !inserted {
			seen = true
			return nil
		}
		return h(ctx, tx, env)
	})
	return seen, err
}

func (p *Processor) record(ctx context.Context, tx pgx.Tx, eventID uuid.UUID) (bool, error) {
	tag, err := tx.Exec(ctx,
		`INSERT INTO inbox (consumer, event_id, processed_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		p.consumer, eventID, p.clock.Now())
	if err != nil {
		return false, fmt.Errorf("insert inbox row: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func (p *Processor) deadLetter(ctx context.Context, eventID uuid.NullUUID, subject string, payload []byte, cause error, numDelivered uint64) error {
	return pgxtx.WithTx(ctx, p.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO dead_letters (id, consumer, event_id, subject, payload, error, delivery_count, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			p.ids.NewID(), p.consumer, eventID, subject, payload, truncate(cause.Error(), 2000), int32(numDelivered), p.clock.Now())
		if err != nil {
			return fmt.Errorf("insert dead letter: %w", err)
		}
		return nil
	})
}

// truncate returns at most the first n bytes of s, dropping a character
// that the cut would split.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
