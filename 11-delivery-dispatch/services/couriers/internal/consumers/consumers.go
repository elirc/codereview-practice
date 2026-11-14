// Package consumers decodes the dispatch events the couriers service consumes
// and hands them to the service inside the inbox transaction.
package consumers

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/services/couriers/internal/service"
)

var errInvalidData = errors.New("invalid event data")

type courierAndDelivery struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	CourierID  uuid.UUID `json:"courier_id"`
}

func decodePair(env envelope.Envelope) (courierAndDelivery, error) {
	var d courierAndDelivery
	if err := env.DecodeData(&d); err != nil {
		return d, err
	}
	if d.DeliveryID == uuid.Nil || d.CourierID == uuid.Nil {
		return d, fmt.Errorf("%w: %s needs delivery_id and courier_id", errInvalidData, env.Type)
	}
	return d, nil
}

func onCourierRequested(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		d, err := decodePair(env)
		if err != nil {
			return err
		}
		return svc.HandleCourierRequested(ctx, tx, d.DeliveryID, d.CourierID)
	}
}

func onRelease(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		d, err := decodePair(env)
		if err != nil {
			return err
		}
		return svc.ReleaseCourier(ctx, tx, d.DeliveryID, d.CourierID)
	}
}

type deliveredEvent struct {
	DeliveryID         uuid.UUID `json:"delivery_id"`
	CourierID          uuid.UUID `json:"courier_id"`
	CourierPayoutMinor *int64    `json:"courier_payout_minor"`
}

func onDelivered(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		var d deliveredEvent
		if err := env.DecodeData(&d); err != nil {
			return err
		}
		if d.DeliveryID == uuid.Nil || d.CourierID == uuid.Nil || d.CourierPayoutMinor == nil || *d.CourierPayoutMinor < 0 {
			return fmt.Errorf("%w: %s needs delivery_id, courier_id and courier_payout_minor", errInvalidData, env.Type)
		}
		return svc.HandleDelivered(ctx, tx, d.DeliveryID, d.CourierID, *d.CourierPayoutMinor)
	}
}

type cancelledEvent struct {
	DeliveryID         uuid.UUID     `json:"delivery_id"`
	CourierID          uuid.NullUUID `json:"courier_id"`
	CourierWasAssigned bool          `json:"courier_was_assigned"`
	CompensationMinor  int64         `json:"compensation_minor"`
}

func onCancelled(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		var d cancelledEvent
		if err := env.DecodeData(&d); err != nil {
			return err
		}
		if d.DeliveryID == uuid.Nil || d.CompensationMinor < 0 {
			return fmt.Errorf("%w: %s needs delivery_id", errInvalidData, env.Type)
		}
		return svc.HandleCancelled(ctx, tx, d.DeliveryID, d.CourierID, d.CourierWasAssigned, d.CompensationMinor)
	}
}

// DispatchHandlers returns the handlers of the couriers-on-DISPATCH consumer.
func DispatchHandlers(svc *service.Service) map[string]inbox.Handler {
	return map[string]inbox.Handler{
		"delivery.courier_requested": onCourierRequested(svc),
		"delivery.courier_released":  onRelease(svc),
		"delivery.unassigned":        onRelease(svc),
		"delivery.delivered":         onDelivered(svc),
		"delivery.cancelled":         onCancelled(svc),
	}
}
