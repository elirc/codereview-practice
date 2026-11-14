package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/dispatch/internal/domain"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// HandleCancelRequested decides an order.cancel_requested and records exactly
// one answer: delivery.cancelled, delivery.cancel_rejected or, for a delivery
// that already failed, delivery.failed.
func (s *Service) HandleCancelRequested(ctx context.Context, tx pgx.Tx, orderID uuid.UUID) error {
	q := s.q.WithTx(tx)
	if err := q.LockOrderKey(ctx, pgxtx.AdvisoryKey(orderID)); err != nil {
		return fmt.Errorf("lock order key: %w", err)
	}
	now := s.clock.Now()
	d, err := q.GetDeliveryForUpdate(ctx, orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.cancelBeforeDelivery(ctx, tx, q, orderID, now)
	}
	if err != nil {
		return fmt.Errorf("lock delivery: %w", err)
	}

	decision := domain.DecideCancel(d.Status)
	switch decision.Action {
	case domain.CancelDelivery:
		if d.Status == domain.DeliveryOffered {
			if err := cancelPendingOfferFor(ctx, q, d.ID, now); err != nil {
				return err
			}
		}
		d.Status = domain.DeliveryCancelled
		d.ReserveDeadline = nil
		d.CourierWasAssigned = decision.CourierWasAssigned
		if decision.CourierWasAssigned {
			d.CompensationMinor = s.cfg.CancelCompensationMinor
		}
		if !decision.KeepCourier {
			d.CourierID = uuid.NullUUID{}
		}
		_, err := s.commitWithEvent(ctx, tx, q, d, now, EventCancelled, s.cancelledFacts(d))
		return err
	case domain.RejectCancel:
		_, err := s.commitWithEvent(ctx, tx, q, d, now, EventCancelRejected, cancelRejectedData{
			DeliveryID: d.ID,
			Reason:     decision.Reason,
		})
		return err
	case domain.RepeatCancelled:
		_, err := s.commitWithEvent(ctx, tx, q, d, now, EventCancelled, s.cancelledFacts(d))
		return err
	default:
		_, err := s.commitWithEvent(ctx, tx, q, d, now, EventFailed, failedData{
			DeliveryID: d.ID,
			Reason:     "no_courier",
			OffersMade: d.OffersMade,
		})
		return err
	}
}

// cancelBeforeDelivery records that the order is cancelled before its
// delivery exists and answers delivery.cancelled with sequence 1.
func (s *Service) cancelBeforeDelivery(ctx context.Context, tx pgx.Tx, q *db.Queries, orderID uuid.UUID, now time.Time) error {
	if err := q.InsertCancelledOrder(ctx, db.InsertCancelledOrderParams{OrderID: orderID, RequestedAt: now}); err != nil {
		return fmt.Errorf("insert cancelled order: %w", err)
	}
	return s.emitDeliveryEvent(ctx, tx, orderID.String(), 1, EventCancelled, now, cancelledData{
		DeliveryID: orderID,
		Currency:   s.cfg.Currency,
	})
}

func (s *Service) cancelledFacts(d db.Delivery) cancelledData {
	data := cancelledData{
		DeliveryID:         d.ID,
		CourierWasAssigned: d.CourierWasAssigned,
		CompensationMinor:  d.CompensationMinor,
		Currency:           s.cfg.Currency,
	}
	if d.CourierID.Valid {
		id := d.CourierID.UUID
		data.CourierID = &id
	}
	return data
}

// cancelPendingOfferFor cancels the delivery's pending offer, if any. The
// delivery row must already be locked.
func cancelPendingOfferFor(ctx context.Context, q *db.Queries, deliveryID uuid.UUID, now time.Time) error {
	pending, err := q.GetPendingOfferForDelivery(ctx, deliveryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load pending offer: %w", err)
	}
	o, err := q.GetOfferForUpdate(ctx, pending.ID)
	if err != nil {
		return fmt.Errorf("lock offer: %w", err)
	}
	if o.Status != domain.OfferPending {
		return nil
	}
	if err := q.CloseOffer(ctx, db.CloseOfferParams{Status: domain.OfferCancelled, ClosedAt: now, ID: o.ID}); err != nil {
		return fmt.Errorf("cancel offer: %w", err)
	}
	return nil
}
