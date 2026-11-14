package domain

import (
	"testing"

	"github.com/google/uuid"
)

func courier() uuid.NullUUID {
	return uuid.NullUUID{UUID: uuid.New(), Valid: true}
}

func confirmedState() OrderState {
	return OrderState{Status: StatusConfirmed, CancelRequest: CancelRequestNone, TotalMinor: 3340}
}

func TestApplyDeliveryEventMeanings(t *testing.T) {
	eta := int32(22)
	c := courier()
	tests := []struct {
		name       string
		ev         DeliveryEvent
		wantStatus string
	}{
		{"assigned", DeliveryEvent{Type: EventDeliveryAssigned, Sequence: 2, CourierID: c, ETAMinutes: &eta}, StatusCourierAssigned},
		{"picked up without assignment", DeliveryEvent{Type: EventDeliveryPickedUp, Sequence: 4, CourierID: c}, StatusPickedUp},
		{"delivered", DeliveryEvent{Type: EventDeliveryDelivered, Sequence: 5, CourierID: c}, StatusDelivered},
		{"unassigned", DeliveryEvent{Type: EventDeliveryUnassigned, Sequence: 3, CourierID: c}, StatusConfirmed},
		{"failed", DeliveryEvent{Type: EventDeliveryFailed, Sequence: 6}, StatusCancelled},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed := ApplyDeliveryEvent(confirmedState(), tt.ev, 500)
			if !changed || got.Status != tt.wantStatus || got.DeliverySequence != tt.ev.Sequence {
				t.Fatalf("got %+v, changed=%v", got, changed)
			}
		})
	}
}

func TestApplyDeliveryEventNeverGoesBackwards(t *testing.T) {
	c := courier()
	s := confirmedState()
	s, _ = ApplyDeliveryEvent(s, DeliveryEvent{Type: EventDeliveryPickedUp, Sequence: 4, CourierID: c}, 500)

	late, changed := ApplyDeliveryEvent(s, DeliveryEvent{Type: EventDeliveryAssigned, Sequence: 2, CourierID: courier()}, 500)
	if changed || late.Status != StatusPickedUp || late.CourierID != c {
		t.Fatalf("late assigned applied: %+v", late)
	}
	same, changed := ApplyDeliveryEvent(s, DeliveryEvent{Type: EventDeliveryUnassigned, Sequence: 4}, 500)
	if changed || same.Status != StatusPickedUp {
		t.Fatalf("equal sequence applied: %+v", same)
	}
}

func TestApplyDeliveryEventIgnoresTerminalOrders(t *testing.T) {
	for _, status := range []string{StatusDelivered, StatusCancelled} {
		s := OrderState{Status: status, DeliverySequence: 3, TotalMinor: 1000}
		for _, typ := range []string{EventDeliveryAssigned, EventDeliveryCancelled, EventDeliveryFailed, EventDeliveryDelivered} {
			if _, changed := ApplyDeliveryEvent(s, DeliveryEvent{Type: typ, Sequence: 9, CourierID: courier()}, 500); changed {
				t.Errorf("%s applied to a %s order", typ, status)
			}
		}
	}
}

func TestCancellationTerms(t *testing.T) {
	by := func(s string) *string { return &s }
	tests := []struct {
		name        string
		requestedBy *string
		assigned    bool
		wantFee     int64
	}{
		{"customer, no courier", by(RequesterCustomer), false, 0},
		{"customer, courier assigned", by(RequesterCustomer), true, 500},
		{"restaurant, courier assigned", by(RequesterRestaurant), true, 0},
		{"ops, courier assigned", by(RequesterOps), true, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := OrderState{Status: StatusCourierAssigned, CancelRequest: CancelRequestPending, CancelRequestedBy: tt.requestedBy, TotalMinor: 3340}
			got, changed := ApplyDeliveryEvent(s, DeliveryEvent{Type: EventDeliveryCancelled, Sequence: 5, CourierWasAssigned: tt.assigned}, 500)
			if !changed || got.Status != StatusCancelled || got.CancellationFeeMinor != tt.wantFee || got.RefundMinor != 3340-tt.wantFee {
				t.Fatalf("got %+v", got)
			}
			if *got.CancelReason != *tt.requestedBy {
				t.Fatalf("reason = %s", *got.CancelReason)
			}
		})
	}
	if fee := CancellationFee(RequesterCustomer, true, 500, 300); fee != 300 {
		t.Fatalf("fee capped at total = %d, want 300", fee)
	}
}

func TestCancelRejectedKeepsOrderGoing(t *testing.T) {
	requester := RequesterCustomer
	s := OrderState{Status: StatusCourierAssigned, CancelRequest: CancelRequestPending, CancelRequestedBy: &requester, TotalMinor: 3340, DeliverySequence: 2}
	got, changed := ApplyDeliveryEvent(s, DeliveryEvent{Type: EventDeliveryCancelRejected, Sequence: 4, Reason: "picked_up"}, 500)
	if !changed || got.CancelRequest != CancelRequestRejected || got.Status != StatusPickedUp {
		t.Fatalf("got %+v", got)
	}
	if DecideCancel(got.Status, got.CancelRequest) != CancelRefused {
		t.Fatal("a picked-up order should refuse further cancellation")
	}
	if DecideCancel(StatusConfirmed, CancelRequestRejected) != CancelAskDispatch {
		t.Fatal("a rejected request should be judged afresh")
	}
	if DecideCancel(StatusConfirmed, CancelRequestPending) != CancelAlreadyPending || DecideCancel(StatusPlaced, CancelRequestNone) != CancelNow {
		t.Fatal("cancel decision table")
	}
}
