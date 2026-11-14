package domain

import (
	"testing"

	"github.com/google/uuid"
)

func TestDecideReservation(t *testing.T) {
	d := uuid.New()
	other := uuid.NullUUID{UUID: uuid.New(), Valid: true}
	same := uuid.NullUUID{UUID: d, Valid: true}
	tests := []struct {
		name      string
		suspended bool
		onShift   bool
		active    uuid.NullUUID
		want      ReservationOutcome
	}{
		{"available", false, true, uuid.NullUUID{}, ReservationOutcome{Reserve: true}},
		{"already reserved for this delivery", false, true, same, ReservationOutcome{AlreadyReserved: true}},
		{"busy with another delivery", false, true, other, ReservationOutcome{Reason: RejectBusy}},
		{"off shift", false, false, uuid.NullUUID{}, ReservationOutcome{Reason: RejectOffline}},
		{"suspended", true, false, uuid.NullUUID{}, ReservationOutcome{Reason: RejectSuspended}},
		{"suspended mid-delivery", true, false, other, ReservationOutcome{Reason: RejectBusy}},
	}
	for _, tt := range tests {
		if got := DecideReservation(tt.suspended, tt.onShift, tt.active, d); got != tt.want {
			t.Errorf("%s: got %+v, want %+v", tt.name, got, tt.want)
		}
	}
}
