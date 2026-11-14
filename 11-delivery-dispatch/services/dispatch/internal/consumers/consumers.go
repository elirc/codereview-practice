// Package consumers decodes the events dispatch consumes and hands them to
// the service inside the inbox transaction.
package consumers

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/geo"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/services/dispatch/internal/domain"
	"deliverydispatch/services/dispatch/internal/service"
)

// errInvalidData reports event data that is missing required fields.
var errInvalidData = errors.New("invalid event data")

func invalid(eventType, field string) error {
	return fmt.Errorf("%w: %s.%s", errInvalidData, eventType, field)
}

type orderConfirmed struct {
	OrderID          uuid.UUID       `json:"order_id"`
	ZoneID           string          `json:"zone_id"`
	Pickup           *envelope.Point `json:"pickup"`
	Dropoff          *envelope.Point `json:"dropoff"`
	ReadyAt          time.Time       `json:"ready_at"`
	DeliveryFeeMinor int64           `json:"delivery_fee_minor"`
	SurgeBps         int32           `json:"surge_bps"`
}

func validPoint(p *envelope.Point) bool {
	return p != nil && geo.ValidLon(p.Lon) && geo.ValidLat(p.Lat)
}

func onOrderConfirmed(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		var d orderConfirmed
		if err := env.DecodeData(&d); err != nil {
			return err
		}
		switch {
		case d.OrderID == uuid.Nil:
			return invalid(env.Type, "order_id")
		case d.ZoneID == "":
			return invalid(env.Type, "zone_id")
		case !validPoint(d.Pickup):
			return invalid(env.Type, "pickup")
		case !validPoint(d.Dropoff):
			return invalid(env.Type, "dropoff")
		case d.ReadyAt.IsZero():
			return invalid(env.Type, "ready_at")
		case d.DeliveryFeeMinor < 0:
			return invalid(env.Type, "delivery_fee_minor")
		case d.SurgeBps <= 0:
			return invalid(env.Type, "surge_bps")
		}
		return svc.CreateDelivery(ctx, tx, service.NewDelivery{
			OrderID:          d.OrderID,
			ZoneID:           d.ZoneID,
			PickupLon:        d.Pickup.Lon,
			PickupLat:        d.Pickup.Lat,
			DropoffLon:       d.Dropoff.Lon,
			DropoffLat:       d.Dropoff.Lat,
			ReadyAt:          d.ReadyAt,
			DeliveryFeeMinor: d.DeliveryFeeMinor,
			SurgeBps:         d.SurgeBps,
		})
	}
}

type courierStatusChanged struct {
	CourierID uuid.UUID `json:"courier_id"`
	Status    string    `json:"status"`
	ZoneID    *string   `json:"zone_id"`
	Vehicle   string    `json:"vehicle"`
}

func onCourierStatusChanged(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		var d courierStatusChanged
		if err := env.DecodeData(&d); err != nil {
			return err
		}
		switch {
		case d.CourierID == uuid.Nil:
			return invalid(env.Type, "courier_id")
		case !domain.ValidCourierStatus(d.Status):
			return invalid(env.Type, "status")
		case !domain.ValidVehicle(d.Vehicle):
			return invalid(env.Type, "vehicle")
		}
		return svc.ApplyCourierStatus(ctx, tx, service.CourierStatus{
			CourierID: d.CourierID,
			Status:    d.Status,
			ZoneID:    d.ZoneID,
			Vehicle:   d.Vehicle,
			Sequence:  env.Sequence,
		})
	}
}

type courierLocationUpdated struct {
	CourierID  uuid.UUID `json:"courier_id"`
	Lon        *float64  `json:"lon"`
	Lat        *float64  `json:"lat"`
	RecordedAt time.Time `json:"recorded_at"`
}

func onCourierLocationUpdated(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		var d courierLocationUpdated
		if err := env.DecodeData(&d); err != nil {
			return err
		}
		switch {
		case d.CourierID == uuid.Nil:
			return invalid(env.Type, "courier_id")
		case d.Lon == nil || !geo.ValidLon(*d.Lon):
			return invalid(env.Type, "lon")
		case d.Lat == nil || !geo.ValidLat(*d.Lat):
			return invalid(env.Type, "lat")
		case d.RecordedAt.IsZero():
			return invalid(env.Type, "recorded_at")
		}
		return svc.ApplyCourierPosition(ctx, tx, service.CourierPosition{
			CourierID:  d.CourierID,
			Lon:        *d.Lon,
			Lat:        *d.Lat,
			RecordedAt: d.RecordedAt,
		})
	}
}

type courierReservation struct {
	CourierID  uuid.UUID `json:"courier_id"`
	DeliveryID uuid.UUID `json:"delivery_id"`
}

func decodeReservation(env envelope.Envelope) (courierReservation, error) {
	var d courierReservation
	if err := env.DecodeData(&d); err != nil {
		return d, err
	}
	if d.CourierID == uuid.Nil {
		return d, invalid(env.Type, "courier_id")
	}
	if d.DeliveryID == uuid.Nil {
		return d, invalid(env.Type, "delivery_id")
	}
	return d, nil
}

func onCourierReserved(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		d, err := decodeReservation(env)
		if err != nil {
			return err
		}
		return svc.HandleReserved(ctx, tx, d.CourierID, d.DeliveryID)
	}
}

func onReservationRejected(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		d, err := decodeReservation(env)
		if err != nil {
			return err
		}
		return svc.HandleReservationRejected(ctx, tx, d.CourierID, d.DeliveryID)
	}
}

// OrdersHandlers returns the handlers of the dispatch-on-ORDERS consumer.
func OrdersHandlers(svc *service.Service) map[string]inbox.Handler {
	return map[string]inbox.Handler{
		"order.confirmed": onOrderConfirmed(svc),
	}
}

// CouriersHandlers returns the handlers of the dispatch-on-COURIERS consumer.
func CouriersHandlers(svc *service.Service) map[string]inbox.Handler {
	return map[string]inbox.Handler{
		"courier.status_changed":       onCourierStatusChanged(svc),
		"courier.location_updated":     onCourierLocationUpdated(svc),
		"courier.reserved":             onCourierReserved(svc),
		"courier.reservation_rejected": onReservationRejected(svc),
	}
}
