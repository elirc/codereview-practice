package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/dispatch/internal/domain"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// Batch sizes of the offer loop and the offer expiry sweeper.
const (
	OfferBatch  = 20
	ExpiryBatch = 100
)

const activeCourierIndex = "deliveries_active_courier_idx"

// RunOffers makes the next offer for each due searching delivery, or fails
// deliveries whose search is over. Each delivery is handled in its own
// transaction; it returns how many deliveries were handled without error.
func (s *Service) RunOffers(ctx context.Context, now time.Time) (int, error) {
	ids, err := s.q.ListDueDeliveries(ctx, db.ListDueDeliveriesParams{Now: now, BatchSize: OfferBatch})
	if err != nil {
		return 0, fmt.Errorf("list due deliveries: %w", err)
	}
	done := 0
	for _, id := range ids {
		if err := s.offerNext(ctx, id, now); err != nil {
			s.logger.ErrorContext(ctx, "offer pass for delivery failed", "delivery_id", id, "error", err.Error())
			continue
		}
		done++
	}
	return done, nil
}

func (s *Service) offerNext(ctx context.Context, id uuid.UUID, now time.Time) error {
	return pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		d, err := q.GetDeliveryForUpdateSkipLocked(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("lock delivery: %w", err)
		}
		searchOver := !now.Before(d.SearchDeadline)
		if d.Status != domain.DeliverySearching || (now.Before(d.NextOfferAt) && !searchOver) {
			return nil
		}
		if searchOver || d.OffersMade >= s.cfg.MaxOffers {
			d.Status = domain.DeliveryFailed
			_, err := s.commitWithEvent(ctx, tx, q, d, now, EventFailed, failedData{
				DeliveryID: d.ID,
				Reason:     "no_courier",
				OffersMade: d.OffersMade,
			})
			return err
		}

		c, err := q.FindCandidate(ctx, db.FindCandidateParams{
			PickupLon:  d.PickupLon,
			PickupLat:  d.PickupLat,
			FreshAfter: now.Add(-s.cfg.PositionMaxAge),
			RadiusM:    s.cfg.OfferRadiusM,
			DeliveryID: d.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			d.NextOfferAt = now.Add(s.cfg.OfferRetry)
			return saveDelivery(ctx, q, d, now)
		}
		if err != nil {
			return fmt.Errorf("find candidate: %w", err)
		}

		inserted, err := insertOfferSavepoint(ctx, tx, db.InsertOfferParams{
			ID:         s.ids.NewID(),
			DeliveryID: d.ID,
			CourierID:  c.CourierID,
			DistanceM:  c.DistanceM,
			ExpiresAt:  now.Add(s.cfg.OfferTTL),
			CreatedAt:  now,
		})
		if err != nil {
			return err
		}
		if !inserted {
			d.NextOfferAt = now
			return saveDelivery(ctx, q, d, now)
		}
		d.Status = domain.DeliveryOffered
		d.OffersMade++
		return saveDelivery(ctx, q, d, now)
	})
}

// insertOfferSavepoint inserts an offer and reports false when a unique index
// refused it.
func insertOfferSavepoint(ctx context.Context, tx pgx.Tx, arg db.InsertOfferParams) (bool, error) {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin savepoint: %w", err)
	}
	if err := db.New(sp).InsertOffer(ctx, arg); err != nil {
		_ = sp.Rollback(ctx)
		if pgxtx.IsUniqueViolation(err, "") {
			return false, nil
		}
		return false, fmt.Errorf("insert offer: %w", err)
	}
	if err := sp.Commit(ctx); err != nil {
		return false, fmt.Errorf("release savepoint: %w", err)
	}
	return true, nil
}

// OfferDetail is an offer with the delivery it is for.
type OfferDetail struct {
	Offer    db.Offer
	Delivery db.Delivery
}

// CurrentOffer returns the calling courier's pending offer while it is open.
func (s *Service) CurrentOffer(ctx context.Context) (OfferDetail, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return OfferDetail{}, err
	}
	o, err := s.q.GetPendingOfferForCourier(ctx, p.Subject)
	if err != nil {
		return OfferDetail{}, notFoundIfNoRows(err)
	}
	if !s.clock.Now().Before(o.ExpiresAt) {
		return OfferDetail{}, apperr.NotFound()
	}
	d, err := s.q.GetDelivery(ctx, o.DeliveryID)
	if err != nil {
		return OfferDetail{}, fmt.Errorf("load delivery: %w", err)
	}
	return OfferDetail{Offer: o, Delivery: d}, nil
}

// ownOffer returns offer id when it was made to the caller.
func (s *Service) ownOffer(ctx context.Context, id uuid.UUID) (auth.Principal, db.Offer, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return auth.Principal{}, db.Offer{}, err
	}
	o, err := s.q.GetOffer(ctx, id)
	if err != nil {
		return auth.Principal{}, db.Offer{}, notFoundIfNoRows(err)
	}
	if o.CourierID != p.Subject {
		return auth.Principal{}, db.Offer{}, apperr.NotFound()
	}
	return p, o, nil
}

func offerNotPending() error {
	return apperr.Conflict("offer_not_pending", "The offer is no longer open.")
}

// AcceptOffer accepts the caller's offer, moves its delivery to reserving and
// asks couriers to reserve the caller. It returns the delivery.
func (s *Service) AcceptOffer(ctx context.Context, id uuid.UUID) (db.Delivery, error) {
	p, offer, err := s.ownOffer(ctx, id)
	if err != nil {
		return db.Delivery{}, err
	}
	var out db.Delivery
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		d, err := q.GetDeliveryForUpdate(ctx, offer.DeliveryID)
		if err != nil {
			return fmt.Errorf("lock delivery: %w", err)
		}
		o, err := q.GetOfferForUpdate(ctx, id)
		if err != nil {
			return fmt.Errorf("lock offer: %w", err)
		}
		if o.Status == domain.OfferAccepted {
			out = d
			return nil
		}
		if o.Status != domain.OfferPending || d.Status != domain.DeliveryOffered {
			return offerNotPending()
		}
		now := s.clock.Now()
		if !now.Before(o.ExpiresAt) {
			return apperr.Conflict("offer_expired", "The offer has expired.")
		}
		if err := q.CloseOffer(ctx, db.CloseOfferParams{Status: domain.OfferAccepted, ClosedAt: now, ID: o.ID}); err != nil {
			return fmt.Errorf("accept offer: %w", err)
		}
		deadline := now.Add(s.cfg.ReserveTimeout)
		d.Status = domain.DeliveryReserving
		d.CourierID = uuid.NullUUID{UUID: p.Subject, Valid: true}
		d.ReserveDeadline = &deadline
		saved, err := s.commitWithEvent(ctx, tx, q, d, now, EventCourierRequested, courierRequestedData{
			DeliveryID:      d.ID,
			CourierID:       p.Subject,
			ReserveDeadline: deadline.UTC(),
		})
		if pgxtx.IsUniqueViolation(err, activeCourierIndex) {
			return apperr.Conflict("courier_busy", "You already have an active delivery.")
		}
		if err != nil {
			return err
		}
		out = saved
		return nil
	})
	return out, err
}

// DeclineOffer declines the caller's pending offer and lets the delivery
// search again at once.
func (s *Service) DeclineOffer(ctx context.Context, id uuid.UUID) (db.Offer, error) {
	_, offer, err := s.ownOffer(ctx, id)
	if err != nil {
		return db.Offer{}, err
	}
	var out db.Offer
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		d, err := q.GetDeliveryForUpdate(ctx, offer.DeliveryID)
		if err != nil {
			return fmt.Errorf("lock delivery: %w", err)
		}
		o, err := q.GetOfferForUpdate(ctx, id)
		if err != nil {
			return fmt.Errorf("lock offer: %w", err)
		}
		if o.Status != domain.OfferPending {
			return offerNotPending()
		}
		now := s.clock.Now()
		if err := reopenSearch(ctx, q, d, o, domain.OfferDeclined, now); err != nil {
			return err
		}
		o.Status = domain.OfferDeclined
		o.ClosedAt = &now
		out = o
		return nil
	})
	return out, err
}

// ExpireOffers closes pending offers whose expiry is at or before now and lets
// their deliveries search again. It returns how many offers expired.
func (s *Service) ExpireOffers(ctx context.Context, now time.Time) (int, error) {
	due, err := s.q.ListExpiredOffers(ctx, db.ListExpiredOffersParams{Now: now, BatchSize: ExpiryBatch})
	if err != nil {
		return 0, fmt.Errorf("list expired offers: %w", err)
	}
	expired := 0
	for _, row := range due {
		ok, err := s.expireOffer(ctx, row.DeliveryID, row.ID, now)
		if err != nil {
			s.logger.ErrorContext(ctx, "offer expiry failed", "offer_id", row.ID, "error", err.Error())
			continue
		}
		if ok {
			expired++
		}
	}
	return expired, nil
}

func (s *Service) expireOffer(ctx context.Context, deliveryID, offerID uuid.UUID, now time.Time) (bool, error) {
	var expired bool
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		d, err := q.GetDeliveryForUpdate(ctx, deliveryID)
		if err != nil {
			return fmt.Errorf("lock delivery: %w", err)
		}
		o, err := q.GetOfferForUpdate(ctx, offerID)
		if err != nil {
			return fmt.Errorf("lock offer: %w", err)
		}
		if o.Status != domain.OfferPending || now.Before(o.ExpiresAt) {
			return nil
		}
		expired = true
		return reopenSearch(ctx, q, d, o, domain.OfferExpired, now)
	})
	return expired, err
}
