package domain

// CancelAction is dispatch's answer to a cancel request.
type CancelAction int

// Cancel actions.
const (
	// CancelDelivery cancels the delivery and answers delivery.cancelled.
	CancelDelivery CancelAction = iota + 1
	// RejectCancel answers delivery.cancel_rejected.
	RejectCancel
	// RepeatCancelled answers delivery.cancelled again with the stored facts.
	RepeatCancelled
	// RepeatFailed answers delivery.failed again.
	RepeatFailed
)

// CancelDecision is the answer to a cancel request for a delivery in a given
// status. For CancelDelivery, KeepCourier tells whether the courier is named
// in the answer and CourierWasAssigned whether they are compensated. For
// RejectCancel, Reason is the delivery status that prevents cancelling.
type CancelDecision struct {
	Action             CancelAction
	KeepCourier        bool
	CourierWasAssigned bool
	Reason             string
}

// DecideCancel returns the answer to a cancel request for a delivery in
// status; an empty status means the delivery does not exist.
func DecideCancel(status string) CancelDecision {
	switch status {
	case "", DeliverySearching, DeliveryOffered:
		return CancelDecision{Action: CancelDelivery}
	case DeliveryReserving:
		return CancelDecision{Action: CancelDelivery, KeepCourier: true}
	case DeliveryAssigned:
		return CancelDecision{Action: CancelDelivery, KeepCourier: true, CourierWasAssigned: true}
	case DeliveryPickedUp, DeliveryDelivered:
		return CancelDecision{Action: RejectCancel, Reason: status}
	case DeliveryCancelled:
		return CancelDecision{Action: RepeatCancelled}
	default:
		return CancelDecision{Action: RepeatFailed}
	}
}
