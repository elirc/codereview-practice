// Package service implements the couriers service's use cases.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/natsx"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/services/couriers/internal/domain"
	"deliverydispatch/services/couriers/internal/store/db"
)

// Event types published by the couriers service.
const (
	EventStatusChanged       = "courier.status_changed"
	EventLocationUpdated     = "courier.location_updated"
	EventReserved            = "courier.reserved"
	EventReservationRejected = "courier.reservation_rejected"
)

const aggregateCourier = "courier"

// Service is the couriers service.
type Service struct {
	pool     *pgxpool.Pool
	q        *db.Queries
	clock    clock.Clock
	ids      idgen.Generator
	emit     *outbox.Emitter
	logger   *slog.Logger
	currency string
}

// New returns a Service backed by pool.
func New(pool *pgxpool.Pool, currency string, clk clock.Clock, ids idgen.Generator, logger *slog.Logger) *Service {
	return &Service{
		pool:     pool,
		q:        db.New(pool),
		clock:    clk,
		ids:      ids,
		emit:     outbox.NewEmitter(natsx.StreamCouriers.Prefix, ids),
		logger:   logger,
		currency: currency,
	}
}

// Status returns the courier's derived status.
func Status(c db.Courier) string {
	return domain.DeriveStatus(c.Suspended, c.ShiftZoneID != nil, c.ActiveDeliveryID.Valid)
}

type statusKey struct {
	status    string
	zone      string
	suspended bool
}

func keyOf(c db.Courier) statusKey {
	k := statusKey{status: Status(c), suspended: c.Suspended}
	if c.ShiftZoneID != nil {
		k.zone = *c.ShiftZoneID
	}
	return k
}

type statusChangedData struct {
	CourierID uuid.UUID `json:"courier_id"`
	Status    string    `json:"status"`
	ZoneID    *string   `json:"zone_id"`
	Vehicle   string    `json:"vehicle"`
	Suspended bool      `json:"suspended"`
}

// commitStatus stores the shift, suspension and active delivery of after.
// When the derived status, zone or suspension differs from before, it
// increments status_version and records courier.status_changed. It returns
// the stored courier.
func (s *Service) commitStatus(ctx context.Context, tx pgx.Tx, q *db.Queries, before, after db.Courier, now time.Time) (db.Courier, error) {
	changed := keyOf(before) != keyOf(after)
	if !changed && before.ActiveDeliveryID == after.ActiveDeliveryID {
		return before, nil
	}
	if changed {
		after.StatusVersion = before.StatusVersion + 1
	}
	after.UpdatedAt = now
	if err := q.UpdateCourierStatus(ctx, db.UpdateCourierStatusParams{
		Suspended:        after.Suspended,
		ShiftZoneID:      after.ShiftZoneID,
		ActiveDeliveryID: after.ActiveDeliveryID,
		StatusVersion:    after.StatusVersion,
		UpdatedAt:        now,
		ID:               after.ID,
	}); err != nil {
		return db.Courier{}, fmt.Errorf("update courier status: %w", err)
	}
	if changed {
		if err := s.emitCourierEvent(ctx, tx, after.ID, EventStatusChanged, after.StatusVersion, now, statusChangedData{
			CourierID: after.ID,
			Status:    Status(after),
			ZoneID:    after.ShiftZoneID,
			Vehicle:   after.Vehicle,
			Suspended: after.Suspended,
		}); err != nil {
			return db.Courier{}, err
		}
	}
	return after, nil
}

func (s *Service) emitCourierEvent(ctx context.Context, tx pgx.Tx, courierID uuid.UUID, eventType string, sequence int64, now time.Time, data any) error {
	_, err := s.emit.Emit(ctx, tx, outbox.Event{
		Type:          eventType,
		AggregateType: aggregateCourier,
		AggregateID:   courierID.String(),
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

// Currency returns the currency earnings are recorded in.
func (s *Service) Currency() string {
	return s.currency
}
