package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/dispatch/internal/domain"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// courierAction locks the caller's delivery id and runs act on it. act
// returns the delivery to report.
func (s *Service) courierAction(ctx context.Context, id uuid.UUID, act func(tx pgx.Tx, q *db.Queries, d db.Delivery, courierID uuid.UUID, now time.Time) (db.Delivery, error)) (db.Delivery, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return db.Delivery{}, err
	}
	var out db.Delivery
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		d, err := q.GetDeliveryForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.NotFound()
		}
		if err != nil {
			return err
		}
		if !isCourierOf(d, p.Subject) {
			return apperr.NotFound()
		}
		out, err = act(tx, q, d, p.Subject, s.clock.Now())
		return err
	})
	return out, err
}

// Pickup marks the caller's assigned delivery as picked up.
func (s *Service) Pickup(ctx context.Context, id uuid.UUID) (db.Delivery, error) {
	return s.courierAction(ctx, id, func(tx pgx.Tx, q *db.Queries, d db.Delivery, courierID uuid.UUID, now time.Time) (db.Delivery, error) {
		switch d.Status {
		case domain.DeliveryPickedUp:
			return d, nil
		case domain.DeliveryAssigned:
		default:
			return db.Delivery{}, apperr.InvalidState("Only an assigned delivery can be picked up.")
		}
		d.Status = domain.DeliveryPickedUp
		d.PickedUpAt = &now
		return s.commitWithEvent(ctx, tx, q, d, now, EventPickedUp, pickedUpData{
			DeliveryID: d.ID,
			CourierID:  courierID,
			PickedUpAt: now.UTC(),
		})
	})
}

// Deliver marks the caller's picked-up delivery as delivered and fixes the
// courier's payout.
func (s *Service) Deliver(ctx context.Context, id uuid.UUID) (db.Delivery, error) {
	return s.courierAction(ctx, id, func(tx pgx.Tx, q *db.Queries, d db.Delivery, courierID uuid.UUID, now time.Time) (db.Delivery, error) {
		switch d.Status {
		case domain.DeliveryDelivered:
			return d, nil
		case domain.DeliveryPickedUp:
		default:
			return db.Delivery{}, apperr.InvalidState("Only a picked-up delivery can be delivered.")
		}
		payout := domain.CourierPayout(s.cfg.CourierBaseMinor, d.DeliveryFeeMinor, s.cfg.CourierShareBps)
		d.Status = domain.DeliveryDelivered
		d.DeliveredAt = &now
		d.CourierPayoutMinor = &payout
		return s.commitWithEvent(ctx, tx, q, d, now, EventDelivered, deliveredData{
			DeliveryID:         d.ID,
			CourierID:          courierID,
			DeliveredAt:        now.UTC(),
			CourierPayoutMinor: payout,
			Currency:           s.cfg.Currency,
		})
	})
}

// Abandon gives up the caller's assigned delivery, which searches for
// another courier at once.
func (s *Service) Abandon(ctx context.Context, id uuid.UUID) (db.Delivery, error) {
	return s.courierAction(ctx, id, func(tx pgx.Tx, q *db.Queries, d db.Delivery, courierID uuid.UUID, now time.Time) (db.Delivery, error) {
		if d.Status != domain.DeliveryAssigned {
			return db.Delivery{}, apperr.InvalidState("Only an assigned delivery can be abandoned.")
		}
		d.Status = domain.DeliverySearching
		d.CourierID = uuid.NullUUID{}
		d.EtaMinutes = nil
		d.NextOfferAt = now
		return s.commitWithEvent(ctx, tx, q, d, now, EventUnassigned, unassignedData{
			DeliveryID: d.ID,
			CourierID:  courierID,
			Reason:     "abandoned",
		})
	})
}
