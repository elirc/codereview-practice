package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/dispatch/internal/domain"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// ReservationBatch is how many overdue reservations one sweeper pass handles.
const ReservationBatch = 100

// Release reasons on delivery.courier_released.
const (
	ReleaseReserveTimeout = "reserve_timeout"
	ReleaseNotReserving   = "not_reserving"
)

func (s *Service) lockDelivery(ctx context.Context, q *db.Queries, id uuid.UUID) (db.Delivery, error) {
	d, err := q.GetDeliveryForUpdate(ctx, id)
	if err != nil {
		return db.Delivery{}, fmt.Errorf("lock delivery %s: %w", id, err)
	}
	return d, nil
}

// HandleReserved completes a reservation: a delivery still reserving with
// this courier before its deadline becomes assigned with an ETA. A delivery
// already assigned to or picked up by this courier is left as it is. In any
// other case the courier is released again.
func (s *Service) HandleReserved(ctx context.Context, tx pgx.Tx, courierID, deliveryID uuid.UUID) error {
	q := s.q.WithTx(tx)
	d, err := s.lockDelivery(ctx, q, deliveryID)
	if err != nil {
		return err
	}
	now := s.clock.Now()
	mine := isCourierOf(d, courierID)
	switch {
	case d.Status == domain.DeliveryReserving && mine && now.Before(*d.ReserveDeadline):
		return s.assign(ctx, tx, q, d, courierID, now)
	case d.Status == domain.DeliveryReserving && mine:
		return s.releaseReservation(ctx, tx, q, d, now)
	case mine && (d.Status == domain.DeliveryAssigned || d.Status == domain.DeliveryPickedUp):
		return nil
	default:
		d.Version++
		if err := saveDelivery(ctx, q, d, now); err != nil {
			return err
		}
		return s.emitDeliveryEvent(ctx, tx, d.ID.String(), d.Version, EventCourierReleased, now, courierReleasedData{
			DeliveryID: d.ID,
			CourierID:  courierID,
			Reason:     ReleaseNotReserving,
		})
	}
}

func (s *Service) assign(ctx context.Context, tx pgx.Tx, q *db.Queries, d db.Delivery, courierID uuid.UUID, now time.Time) error {
	dist, err := q.GetAssignmentDistances(ctx, db.GetAssignmentDistancesParams{
		PickupLon:  d.PickupLon,
		PickupLat:  d.PickupLat,
		DropoffLon: d.DropoffLon,
		DropoffLat: d.DropoffLat,
		CourierID:  courierID,
	})
	if err != nil {
		return fmt.Errorf("measure assignment distances: %w", err)
	}
	eta := int32(domain.ETAMinutes(dist.Vehicle, dist.ToPickupM, dist.ToDropoffM, d.ReadyAt, now))
	d.Status = domain.DeliveryAssigned
	d.ReserveDeadline = nil
	d.EtaMinutes = &eta
	_, err = s.commitWithEvent(ctx, tx, q, d, now, EventAssigned, assignedData{
		DeliveryID: d.ID,
		CourierID:  courierID,
		EtaMinutes: eta,
	})
	return err
}

// releaseReservation returns a reserving delivery to searching and records
// delivery.courier_released for its courier.
func (s *Service) releaseReservation(ctx context.Context, tx pgx.Tx, q *db.Queries, d db.Delivery, now time.Time) error {
	courierID := d.CourierID.UUID
	d.Status = domain.DeliverySearching
	d.CourierID = uuid.NullUUID{}
	d.ReserveDeadline = nil
	d.NextOfferAt = now
	_, err := s.commitWithEvent(ctx, tx, q, d, now, EventCourierReleased, courierReleasedData{
		DeliveryID: d.ID,
		CourierID:  courierID,
		Reason:     ReleaseReserveTimeout,
	})
	return err
}

// HandleReservationRejected returns a delivery reserving this courier to
// searching. Otherwise it changes nothing.
func (s *Service) HandleReservationRejected(ctx context.Context, tx pgx.Tx, courierID, deliveryID uuid.UUID) error {
	q := s.q.WithTx(tx)
	d, err := s.lockDelivery(ctx, q, deliveryID)
	if err != nil {
		return err
	}
	if d.Status != domain.DeliveryReserving || !isCourierOf(d, courierID) {
		return nil
	}
	now := s.clock.Now()
	d.Status = domain.DeliverySearching
	d.CourierID = uuid.NullUUID{}
	d.ReserveDeadline = nil
	d.NextOfferAt = now
	return saveDelivery(ctx, q, d, now)
}

// ExpireReservations releases reservations whose deadline is at or before
// now, one transaction each, and returns how many it released.
func (s *Service) ExpireReservations(ctx context.Context, now time.Time) (int, error) {
	ids, err := s.q.ListExpiredReservations(ctx, db.ListExpiredReservationsParams{Now: now, BatchSize: ReservationBatch})
	if err != nil {
		return 0, fmt.Errorf("list expired reservations: %w", err)
	}
	released := 0
	for _, id := range ids {
		var done bool
		err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
			q := s.q.WithTx(tx)
			d, err := s.lockDelivery(ctx, q, id)
			if err != nil {
				return err
			}
			if d.Status != domain.DeliveryReserving || now.Before(*d.ReserveDeadline) {
				return nil
			}
			done = true
			return s.releaseReservation(ctx, tx, q, d, now)
		})
		if err != nil {
			s.logger.ErrorContext(ctx, "reservation timeout failed", "delivery_id", id, "error", err.Error())
			continue
		}
		if done {
			released++
		}
	}
	return released, nil
}
