package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/services/orders/internal/store/db"
)

// Event types published by the orders service.
const (
	EventOrderConfirmed       = "order.confirmed"
	EventOrderCancelRequested = "order.cancel_requested"
	EventOrderCancelled       = "order.cancelled"
)

const aggregateOrder = "order"

type orderConfirmedData struct {
	OrderID          uuid.UUID      `json:"order_id"`
	RestaurantID     uuid.UUID      `json:"restaurant_id"`
	ZoneID           string         `json:"zone_id"`
	Pickup           envelope.Point `json:"pickup"`
	Dropoff          envelope.Point `json:"dropoff"`
	ReadyAt          time.Time      `json:"ready_at"`
	DeliveryFeeMinor int64          `json:"delivery_fee_minor"`
	SurgeBps         int32          `json:"surge_bps"`
	Currency         string         `json:"currency"`
}

type orderCancelRequestedData struct {
	OrderID     uuid.UUID `json:"order_id"`
	RequestedBy string    `json:"requested_by"`
	Attempt     int32     `json:"attempt"`
}

type orderCancelledData struct {
	OrderID              uuid.UUID `json:"order_id"`
	Reason               string    `json:"reason"`
	CancellationFeeMinor int64     `json:"cancellation_fee_minor"`
	RefundMinor          int64     `json:"refund_minor"`
	Currency             string    `json:"currency"`
}

func (s *Service) emitOrderEvent(ctx context.Context, tx pgx.Tx, o db.Order, eventType string, now time.Time, data any) error {
	_, err := s.emit.Emit(ctx, tx, outbox.Event{
		Type:          eventType,
		AggregateType: aggregateOrder,
		AggregateID:   o.ID.String(),
		Sequence:      o.Version,
		OccurredAt:    now,
		Data:          data,
	})
	return err
}

func (s *Service) emitConfirmed(ctx context.Context, tx pgx.Tx, o db.Order, now time.Time) error {
	return s.emitOrderEvent(ctx, tx, o, EventOrderConfirmed, now, orderConfirmedData{
		OrderID:          o.ID,
		RestaurantID:     o.RestaurantID,
		ZoneID:           o.ZoneID,
		Pickup:           envelope.Point{Lon: o.PickupLon, Lat: o.PickupLat},
		Dropoff:          envelope.Point{Lon: o.DropoffLon, Lat: o.DropoffLat},
		ReadyAt:          o.ReadyAt.UTC(),
		DeliveryFeeMinor: o.DeliveryFeeMinor,
		SurgeBps:         o.SurgeBps,
		Currency:         s.cfg.Currency,
	})
}

func (s *Service) emitCancelRequested(ctx context.Context, tx pgx.Tx, o db.Order, now time.Time) error {
	return s.emitOrderEvent(ctx, tx, o, EventOrderCancelRequested, now, orderCancelRequestedData{
		OrderID:     o.ID,
		RequestedBy: deref(o.CancelRequestedBy),
		Attempt:     o.CancelRequestAttempts,
	})
}

func (s *Service) emitCancelled(ctx context.Context, tx pgx.Tx, o db.Order, now time.Time) error {
	return s.emitOrderEvent(ctx, tx, o, EventOrderCancelled, now, orderCancelledData{
		OrderID:              o.ID,
		Reason:               deref(o.CancelReason),
		CancellationFeeMinor: o.CancellationFeeMinor,
		RefundMinor:          o.RefundMinor,
		Currency:             s.cfg.Currency,
	})
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
