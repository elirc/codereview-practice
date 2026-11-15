package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/services/couriers/internal/domain"
	"deliverydispatch/services/couriers/internal/store/db"
)

type reservedData struct {
	CourierID  uuid.UUID `json:"courier_id"`
	DeliveryID uuid.UUID `json:"delivery_id"`
}

type reservationRejectedData struct {
	CourierID  uuid.UUID `json:"courier_id"`
	DeliveryID uuid.UUID `json:"delivery_id"`
	Reason     string    `json:"reason"`
}

// lockCourier loads and locks a courier named by an event.
func (s *Service) lockCourier(ctx context.Context, q *db.Queries, id uuid.UUID) (db.Courier, error) {
	c, err := q.GetCourierForUpdate(ctx, id)
	if err != nil {
		return db.Courier{}, fmt.Errorf("lock courier %s: %w", id, err)
	}
	return c, nil
}

// HandleCourierRequested answers dispatch's request to reserve courierID for
// deliveryID with courier.reserved or courier.reservation_rejected. Only an
// available courier is changed: they are attached to the delivery.
func (s *Service) HandleCourierRequested(ctx context.Context, tx pgx.Tx, deliveryID, courierID uuid.UUID) error {
	q := s.q.WithTx(tx)
	c, err := q.GetCourier(ctx, courierID)
	if err != nil {
		return fmt.Errorf("load courier %s: %w", courierID, err)
	}
	now := s.clock.Now()
	outcome := domain.DecideReservation(c.Suspended, c.ShiftZoneID != nil, c.ActiveDeliveryID, deliveryID)
	if !outcome.Reserve {
		return s.answerUnchanged(ctx, tx, c, deliveryID, outcome, now)
	}
	if _, err := s.lockCourier(ctx, q, c.ID); err != nil {
		return err
	}
	after := c
	after.ActiveDeliveryID = uuid.NullUUID{UUID: deliveryID, Valid: true}
	saved, err := s.commitStatus(ctx, tx, q, c, after, now)
	if err != nil {
		return err
	}
	return s.emitCourierEvent(ctx, tx, c.ID, EventReserved, saved.StatusVersion, now, reservedData{CourierID: c.ID, DeliveryID: deliveryID})
}

// answerUnchanged records the answer to a reservation request that leaves the
// courier as they are: courier.reserved again when they already hold the
// delivery, otherwise courier.reservation_rejected with the outcome's reason.
func (s *Service) answerUnchanged(ctx context.Context, tx pgx.Tx, c db.Courier, deliveryID uuid.UUID, outcome domain.ReservationOutcome, now time.Time) error {
	if outcome.AlreadyReserved {
		return s.emitCourierEvent(ctx, tx, c.ID, EventReserved, c.StatusVersion, now, reservedData{CourierID: c.ID, DeliveryID: deliveryID})
	}
	return s.emitCourierEvent(ctx, tx, c.ID, EventReservationRejected, c.StatusVersion, now, reservationRejectedData{
		CourierID:  c.ID,
		DeliveryID: deliveryID,
		Reason:     outcome.Reason,
	})
}

// ReleaseCourier detaches courierID from deliveryID when that is their active
// delivery; otherwise it changes nothing.
func (s *Service) ReleaseCourier(ctx context.Context, tx pgx.Tx, deliveryID, courierID uuid.UUID) error {
	q := s.q.WithTx(tx)
	c, err := s.lockCourier(ctx, q, courierID)
	if err != nil {
		return err
	}
	if !c.ActiveDeliveryID.Valid || c.ActiveDeliveryID.UUID != deliveryID {
		return nil
	}
	after := c
	after.ActiveDeliveryID = uuid.NullUUID{}
	_, err = s.commitStatus(ctx, tx, q, c, after, s.clock.Now())
	return err
}
