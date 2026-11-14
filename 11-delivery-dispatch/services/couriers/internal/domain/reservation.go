package domain

import "github.com/google/uuid"

// Reservation rejection reasons.
const (
	RejectOffline   = "offline"
	RejectBusy      = "busy"
	RejectSuspended = "suspended"
)

// ReservationOutcome is how a courier answers a reservation request: attach
// the courier (Reserve), confirm an existing attachment (AlreadyReserved), or
// reject with Reason.
type ReservationOutcome struct {
	Reserve         bool
	AlreadyReserved bool
	Reason          string
}

// DecideReservation returns the answer to a request to reserve a courier for
// deliveryID, given the courier's suspension, shift and active delivery.
func DecideReservation(suspended, onShift bool, activeDelivery uuid.NullUUID, deliveryID uuid.UUID) ReservationOutcome {
	if activeDelivery.Valid && activeDelivery.UUID == deliveryID {
		return ReservationOutcome{AlreadyReserved: true}
	}
	switch DeriveStatus(suspended, onShift, activeDelivery.Valid) {
	case StatusAvailable:
		return ReservationOutcome{Reserve: true}
	case StatusBusy:
		return ReservationOutcome{Reason: RejectBusy}
	}
	if suspended {
		return ReservationOutcome{Reason: RejectSuspended}
	}
	return ReservationOutcome{Reason: RejectOffline}
}
