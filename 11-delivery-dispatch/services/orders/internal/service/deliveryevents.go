package service

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

func stateOf(o db.Order) domain.OrderState {
	return domain.OrderState{
		Status:               o.Status,
		CourierID:            o.CourierID,
		ETAMinutes:           o.EtaMinutes,
		DeliverySequence:     o.DeliverySequence,
		CancelRequest:        o.CancelRequest,
		CancelRequestedBy:    o.CancelRequestedBy,
		CancelRetryAt:        o.CancelRetryAt,
		CancelReason:         o.CancelReason,
		CancellationFeeMinor: o.CancellationFeeMinor,
		RefundMinor:          o.RefundMinor,
		TotalMinor:           o.TotalMinor,
	}
}

func withState(o db.Order, s domain.OrderState) db.Order {
	o.Status = s.Status
	o.CourierID = s.CourierID
	o.EtaMinutes = s.ETAMinutes
	o.DeliverySequence = s.DeliverySequence
	o.CancelRequest = s.CancelRequest
	o.CancelRequestedBy = s.CancelRequestedBy
	o.CancelRetryAt = s.CancelRetryAt
	o.CancelReason = s.CancelReason
	o.CancellationFeeMinor = s.CancellationFeeMinor
	o.RefundMinor = s.RefundMinor
	return o
}

// ApplyDeliveryEvent applies a delivery.* event to its order within tx. It
// records order.cancelled when the event cancels the order. An order that
// does not exist is an error.
func (s *Service) ApplyDeliveryEvent(ctx context.Context, tx pgx.Tx, orderID uuid.UUID, ev domain.DeliveryEvent) error {
	q := s.q.WithTx(tx)
	o, err := q.GetOrderForUpdate(ctx, orderID)
	if err != nil {
		return fmt.Errorf("lock order %s: %w", orderID, err)
	}
	next, changed := domain.ApplyDeliveryEvent(stateOf(o), ev, s.cfg.CancelFeeMinor)
	if !changed {
		return nil
	}
	now := s.clock.Now()
	saved, err := s.save(ctx, q, o, withState(o, next), ev.Type, now)
	if err != nil {
		return err
	}
	if saved.Status == domain.StatusCancelled {
		return s.emitCancelled(ctx, tx, saved, now)
	}
	return nil
}
