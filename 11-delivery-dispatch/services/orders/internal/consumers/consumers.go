// Package consumers decodes the dispatch events the orders service consumes
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
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/service"
)

var errInvalidData = errors.New("invalid event data")

type deliveryEventData struct {
	DeliveryID         uuid.UUID     `json:"delivery_id"`
	CourierID          uuid.NullUUID `json:"courier_id"`
	EtaMinutes         *int32        `json:"eta_minutes"`
	CourierWasAssigned bool          `json:"courier_was_assigned"`
	Reason             string        `json:"reason"`
}

// needsCourier lists the delivery events whose data must name a courier.
var needsCourier = map[string]bool{
	domain.EventDeliveryAssigned:  true,
	domain.EventDeliveryPickedUp:  true,
	domain.EventDeliveryDelivered: true,
}

func onDeliveryEvent(svc *service.Service) inbox.Handler {
	return func(ctx context.Context, tx pgx.Tx, env envelope.Envelope) error {
		var d deliveryEventData
		if err := env.DecodeData(&d); err != nil {
			return err
		}
		if d.DeliveryID == uuid.Nil || d.DeliveryID.String() != env.AggregateID {
			return fmt.Errorf("%w: %s delivery_id must match aggregate_id", errInvalidData, env.Type)
		}
		if needsCourier[env.Type] && !d.CourierID.Valid {
			return fmt.Errorf("%w: %s needs courier_id", errInvalidData, env.Type)
		}
		if env.Type == domain.EventDeliveryAssigned && d.EtaMinutes == nil {
			return fmt.Errorf("%w: %s needs eta_minutes", errInvalidData, env.Type)
		}
		return svc.ApplyDeliveryEvent(ctx, tx, d.DeliveryID, domain.DeliveryEvent{
			Type:               env.Type,
			Sequence:           env.Sequence,
			CourierID:          d.CourierID,
			ETAMinutes:         d.EtaMinutes,
			CourierWasAssigned: d.CourierWasAssigned,
			Reason:             d.Reason,
		})
	}
}

// DispatchHandlers returns the handlers of the orders-on-DISPATCH consumer.
func DispatchHandlers(svc *service.Service) map[string]inbox.Handler {
	h := onDeliveryEvent(svc)
	return map[string]inbox.Handler{
		domain.EventDeliveryAssigned:       h,
		domain.EventDeliveryUnassigned:     h,
		domain.EventDeliveryPickedUp:       h,
		domain.EventDeliveryDelivered:      h,
		domain.EventDeliveryFailed:         h,
		domain.EventDeliveryCancelled:      h,
		domain.EventDeliveryCancelRejected: h,
	}
}
