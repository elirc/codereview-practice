package domain

import (
	"time"

	"github.com/google/uuid"
)

// Delivery event types consumed from dispatch.
const (
	EventDeliveryAssigned       = "delivery.assigned"
	EventDeliveryUnassigned     = "delivery.unassigned"
	EventDeliveryPickedUp       = "delivery.picked_up"
	EventDeliveryDelivered      = "delivery.delivered"
	EventDeliveryCancelled      = "delivery.cancelled"
	EventDeliveryCancelRejected = "delivery.cancel_rejected"
	EventDeliveryFailed         = "delivery.failed"
)

// DeliveryEvent is the part of a delivery.* event the order lifecycle uses.
type DeliveryEvent struct {
	Type               string
	Sequence           int64
	CourierID          uuid.NullUUID
	ETAMinutes         *int32
	CourierWasAssigned bool
	Reason             string
}

// OrderState is the mutable part of an order that delivery events change.
type OrderState struct {
	Status               string
	CourierID            uuid.NullUUID
	ETAMinutes           *int32
	DeliverySequence     int64
	CancelRequest        string
	CancelRequestedBy    *string
	CancelRetryAt        *time.Time
	CancelReason         *string
	CancellationFeeMinor int64
	RefundMinor          int64
	TotalMinor           int64
}

// ApplyDeliveryEvent returns the order state after ev and whether ev changed
// anything. Events for terminal orders, and events whose sequence is not
// newer than the last one applied, change nothing.
func ApplyDeliveryEvent(s OrderState, ev DeliveryEvent, cancelFeeMinor int64) (OrderState, bool) {
	if IsTerminal(s.Status) || ev.Sequence <= s.DeliverySequence {
		return s, false
	}
	n := s
	n.DeliverySequence = ev.Sequence
	switch ev.Type {
	case EventDeliveryAssigned:
		n.Status = StatusCourierAssigned
		n.CourierID = ev.CourierID
		n.ETAMinutes = ev.ETAMinutes
	case EventDeliveryUnassigned:
		n.Status = StatusConfirmed
		n.CourierID = uuid.NullUUID{}
		n.ETAMinutes = nil
	case EventDeliveryPickedUp:
		n.Status = StatusPickedUp
		n.CourierID = ev.CourierID
	case EventDeliveryDelivered:
		n.Status = StatusDelivered
		if ev.CourierID.Valid {
			n.CourierID = ev.CourierID
		}
	case EventDeliveryCancelled:
		by := RequesterOps
		if s.CancelRequestedBy != nil {
			by = *s.CancelRequestedBy
		}
		n = Cancel(n, by, CancellationFee(by, ev.CourierWasAssigned, cancelFeeMinor, s.TotalMinor))
	case EventDeliveryCancelRejected:
		n.CancelRequest = CancelRequestRejected
		n.CancelRetryAt = nil
		switch ev.Reason {
		case "picked_up":
			n.Status = StatusPickedUp
		case "delivered":
			n.Status = StatusDelivered
		}
	case EventDeliveryFailed:
		n = Cancel(n, ReasonNoCourier, 0)
	default:
		return s, false
	}
	return n, true
}

// Cancel returns s cancelled for reason with the given fee and the rest of the
// total refunded.
func Cancel(s OrderState, reason string, feeMinor int64) OrderState {
	r := reason
	s.Status = StatusCancelled
	s.CancelReason = &r
	s.CancellationFeeMinor = feeMinor
	s.RefundMinor = s.TotalMinor - feeMinor
	s.CancelRetryAt = nil
	return s
}
