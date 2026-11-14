package service

import (
	"time"

	"github.com/google/uuid"
)

// Event types published by the dispatch service.
const (
	EventCourierRequested = "delivery.courier_requested"
	EventCourierReleased  = "delivery.courier_released"
	EventAssigned         = "delivery.assigned"
	EventUnassigned       = "delivery.unassigned"
	EventPickedUp         = "delivery.picked_up"
	EventDelivered        = "delivery.delivered"
	EventCancelled        = "delivery.cancelled"
	EventCancelRejected   = "delivery.cancel_rejected"
	EventFailed           = "delivery.failed"
	EventSurgeUpdated     = "surge.updated"
)

const (
	aggregateDelivery = "delivery"
	aggregateZone     = "zone"
)

type courierRequestedData struct {
	DeliveryID      uuid.UUID `json:"delivery_id"`
	CourierID       uuid.UUID `json:"courier_id"`
	ReserveDeadline time.Time `json:"reserve_deadline"`
}

type courierReleasedData struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	CourierID  uuid.UUID `json:"courier_id"`
	Reason     string    `json:"reason"`
}

type assignedData struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	CourierID  uuid.UUID `json:"courier_id"`
	EtaMinutes int32     `json:"eta_minutes"`
}

type unassignedData struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	CourierID  uuid.UUID `json:"courier_id"`
	Reason     string    `json:"reason"`
}

type pickedUpData struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	CourierID  uuid.UUID `json:"courier_id"`
	PickedUpAt time.Time `json:"picked_up_at"`
}

type deliveredData struct {
	DeliveryID         uuid.UUID `json:"delivery_id"`
	CourierID          uuid.UUID `json:"courier_id"`
	DeliveredAt        time.Time `json:"delivered_at"`
	CourierPayoutMinor int64     `json:"courier_payout_minor"`
	Currency           string    `json:"currency"`
}

type cancelledData struct {
	DeliveryID         uuid.UUID  `json:"delivery_id"`
	CourierID          *uuid.UUID `json:"courier_id"`
	CourierWasAssigned bool       `json:"courier_was_assigned"`
	CompensationMinor  int64      `json:"compensation_minor"`
	Currency           string     `json:"currency"`
}

type cancelRejectedData struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	Reason     string    `json:"reason"`
}

type failedData struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
	Reason     string    `json:"reason"`
	OffersMade int32     `json:"offers_made"`
}

type surgeUpdatedData struct {
	ZoneID        string `json:"zone_id"`
	MultiplierBps int32  `json:"multiplier_bps"`
}
