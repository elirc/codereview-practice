// Package service implements the dispatch service: the courier projection,
// deliveries, offers, reservations and the cancellation decision.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/natsx"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// Config holds the dispatch business settings.
type Config struct {
	Currency                string
	SearchTimeout           time.Duration
	MaxOffers               int32
	OfferTTL                time.Duration
	OfferRetry              time.Duration
	OfferRadiusM            float64
	PositionMaxAge          time.Duration
	ReserveTimeout          time.Duration
	CourierBaseMinor        int64
	CourierShareBps         int64
	CancelCompensationMinor int64
}

// Service is the dispatch service.
type Service struct {
	pool   *pgxpool.Pool
	q      *db.Queries
	cfg    Config
	clock  clock.Clock
	ids    idgen.Generator
	emit   *outbox.Emitter
	logger *slog.Logger
}

// New returns a Service backed by pool.
func New(pool *pgxpool.Pool, cfg Config, clk clock.Clock, ids idgen.Generator, logger *slog.Logger) *Service {
	return &Service{
		pool:   pool,
		q:      db.New(pool),
		cfg:    cfg,
		clock:  clk,
		ids:    ids,
		emit:   outbox.NewEmitter(natsx.StreamDispatch.Prefix, ids),
		logger: logger,
	}
}

// Queries returns the pool-backed queries, for tests and seeds.
func (s *Service) Queries() *db.Queries {
	return s.q
}

// saveDelivery writes every mutable field of d.
func saveDelivery(ctx context.Context, q *db.Queries, d db.Delivery, now time.Time) error {
	err := q.UpdateDelivery(ctx, db.UpdateDeliveryParams{
		Status:             d.Status,
		CourierID:          d.CourierID,
		OffersMade:         d.OffersMade,
		NextOfferAt:        d.NextOfferAt,
		ReserveDeadline:    d.ReserveDeadline,
		EtaMinutes:         d.EtaMinutes,
		CourierWasAssigned: d.CourierWasAssigned,
		CompensationMinor:  d.CompensationMinor,
		CourierPayoutMinor: d.CourierPayoutMinor,
		PickedUpAt:         d.PickedUpAt,
		DeliveredAt:        d.DeliveredAt,
		Version:            d.Version,
		UpdatedAt:          now,
		ID:                 d.ID,
	})
	if err != nil {
		return fmt.Errorf("update delivery: %w", err)
	}
	return nil
}

// commitWithEvent increments d's version, saves it and records eventType
// with data for it. It returns the saved delivery.
func (s *Service) commitWithEvent(ctx context.Context, tx pgx.Tx, q *db.Queries, d db.Delivery, now time.Time, eventType string, data any) (db.Delivery, error) {
	d.Version++
	if err := saveDelivery(ctx, q, d, now); err != nil {
		return db.Delivery{}, err
	}
	if err := s.emitDeliveryEvent(ctx, tx, d.ID.String(), d.Version, eventType, now, data); err != nil {
		return db.Delivery{}, err
	}
	return d, nil
}

func (s *Service) emitDeliveryEvent(ctx context.Context, tx pgx.Tx, deliveryID string, sequence int64, eventType string, now time.Time, data any) error {
	_, err := s.emit.Emit(ctx, tx, outbox.Event{
		Type:          eventType,
		AggregateType: aggregateDelivery,
		AggregateID:   deliveryID,
		Sequence:      sequence,
		OccurredAt:    now,
		Data:          data,
	})
	return err
}

func notFoundIfNoRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound()
	}
	return err
}
