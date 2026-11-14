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

// CourierStatus is a courier.status_changed event.
type CourierStatus struct {
	CourierID uuid.UUID
	Status    string
	ZoneID    *string
	Vehicle   string
	Sequence  int64
}

// ApplyCourierStatus projects a courier status change. Changes older than
// the stored status_version are ignored. When the applied status is not
// available, the courier's pending offer is cancelled and its delivery
// searches again.
func (s *Service) ApplyCourierStatus(ctx context.Context, tx pgx.Tx, ev CourierStatus) error {
	q := s.q.WithTx(tx)
	if err := lockPendingOfferOf(ctx, q, ev.CourierID); err != nil {
		return err
	}
	n, err := q.ApplyCourierStatus(ctx, db.ApplyCourierStatusParams{
		CourierID:     ev.CourierID,
		ZoneID:        ev.ZoneID,
		Status:        ev.Status,
		Vehicle:       ev.Vehicle,
		StatusVersion: ev.Sequence,
	})
	if err != nil {
		return fmt.Errorf("apply courier status: %w", err)
	}
	if n == 0 || ev.Status == domain.CourierAvailable {
		return nil
	}
	return s.cancelPendingOfferOf(ctx, q, ev.CourierID, s.clock.Now())
}

// CourierPosition is a courier.location_updated event.
type CourierPosition struct {
	CourierID  uuid.UUID
	Lon        float64
	Lat        float64
	RecordedAt time.Time
}

// ApplyCourierPosition projects a courier position when it is newer than the
// stored one. An unknown courier is recorded as offline.
func (s *Service) ApplyCourierPosition(ctx context.Context, tx pgx.Tx, ev CourierPosition) error {
	_, err := s.q.WithTx(tx).ApplyCourierPosition(ctx, db.ApplyCourierPositionParams{
		CourierID:  ev.CourierID,
		Lon:        ev.Lon,
		Lat:        ev.Lat,
		PositionAt: ev.RecordedAt,
	})
	if err != nil {
		return fmt.Errorf("apply courier position: %w", err)
	}
	return nil
}

// lockPendingOfferOf loads the courier's pending offer and its delivery for
// update, if there is one.
func lockPendingOfferOf(ctx context.Context, q *db.Queries, courierID uuid.UUID) error {
	o, err := q.GetPendingOfferForCourier(ctx, courierID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load pending offer: %w", err)
	}
	if _, err := q.GetDeliveryForUpdate(ctx, o.DeliveryID); err != nil {
		return fmt.Errorf("lock delivery: %w", err)
	}
	if _, err := q.GetOfferForUpdate(ctx, o.ID); err != nil {
		return fmt.Errorf("lock offer: %w", err)
	}
	return nil
}

// cancelPendingOfferOf cancels the courier's pending offer, if any, and puts
// its delivery back to searching immediately.
func (s *Service) cancelPendingOfferOf(ctx context.Context, q *db.Queries, courierID uuid.UUID, now time.Time) error {
	pending, err := q.GetPendingOfferForCourier(ctx, courierID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load pending offer: %w", err)
	}
	d, err := q.GetDeliveryForUpdate(ctx, pending.DeliveryID)
	if err != nil {
		return fmt.Errorf("lock delivery: %w", err)
	}
	o, err := q.GetOfferForUpdate(ctx, pending.ID)
	if err != nil {
		return fmt.Errorf("lock offer: %w", err)
	}
	if o.Status != domain.OfferPending {
		return nil
	}
	return reopenSearch(ctx, q, d, o, domain.OfferCancelled, now)
}

// reopenSearch closes offer o with status and, when its delivery is still
// offered, returns the delivery to searching with an immediate next offer.
func reopenSearch(ctx context.Context, q *db.Queries, d db.Delivery, o db.Offer, status string, now time.Time) error {
	if err := q.CloseOffer(ctx, db.CloseOfferParams{Status: status, ClosedAt: now, ID: o.ID}); err != nil {
		return fmt.Errorf("close offer: %w", err)
	}
	if d.Status != domain.DeliveryOffered {
		return nil
	}
	d.Status = domain.DeliverySearching
	d.NextOfferAt = now
	return saveDelivery(ctx, q, d, now)
}

// NewDelivery is an order.confirmed event.
type NewDelivery struct {
	OrderID          uuid.UUID
	ZoneID           string
	PickupLon        float64
	PickupLat        float64
	DropoffLon       float64
	DropoffLat       float64
	ReadyAt          time.Time
	DeliveryFeeMinor int64
	SurgeBps         int32
}

// CreateDelivery starts the search for a courier for a confirmed order,
// unless the order was already cancelled or its delivery exists.
func (s *Service) CreateDelivery(ctx context.Context, tx pgx.Tx, nd NewDelivery) error {
	q := s.q.WithTx(tx)
	if err := q.LockOrderKey(ctx, pgxtx.AdvisoryKey(nd.OrderID)); err != nil {
		return fmt.Errorf("lock order key: %w", err)
	}
	cancelled, err := q.CancelledOrderExists(ctx, nd.OrderID)
	if err != nil {
		return fmt.Errorf("check cancelled order: %w", err)
	}
	if cancelled {
		return nil
	}
	now := s.clock.Now()
	if _, err := q.InsertDelivery(ctx, db.InsertDeliveryParams{
		ID:               nd.OrderID,
		ZoneID:           nd.ZoneID,
		PickupLon:        nd.PickupLon,
		PickupLat:        nd.PickupLat,
		DropoffLon:       nd.DropoffLon,
		DropoffLat:       nd.DropoffLat,
		ReadyAt:          nd.ReadyAt,
		DeliveryFeeMinor: nd.DeliveryFeeMinor,
		SurgeBps:         nd.SurgeBps,
		NextOfferAt:      now,
		SearchDeadline:   now.Add(s.cfg.SearchTimeout),
		CreatedAt:        now,
	}); err != nil {
		return fmt.Errorf("insert delivery: %w", err)
	}
	return nil
}
