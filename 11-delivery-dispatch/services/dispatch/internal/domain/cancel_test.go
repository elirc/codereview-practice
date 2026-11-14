package domain

import "testing"

func TestDecideCancelTable(t *testing.T) {
	tests := []struct {
		status string
		want   CancelDecision
	}{
		{"", CancelDecision{Action: CancelDelivery}},
		{DeliverySearching, CancelDecision{Action: CancelDelivery}},
		{DeliveryOffered, CancelDecision{Action: CancelDelivery}},
		{DeliveryReserving, CancelDecision{Action: CancelDelivery, KeepCourier: true}},
		{DeliveryAssigned, CancelDecision{Action: CancelDelivery, KeepCourier: true, CourierWasAssigned: true}},
		{DeliveryPickedUp, CancelDecision{Action: RejectCancel, Reason: DeliveryPickedUp}},
		{DeliveryDelivered, CancelDecision{Action: RejectCancel, Reason: DeliveryDelivered}},
		{DeliveryCancelled, CancelDecision{Action: RepeatCancelled}},
		{DeliveryFailed, CancelDecision{Action: RepeatFailed}},
	}
	for _, tt := range tests {
		if got := DecideCancel(tt.status); got != tt.want {
			t.Errorf("DecideCancel(%q) = %+v, want %+v", tt.status, got, tt.want)
		}
	}
}
