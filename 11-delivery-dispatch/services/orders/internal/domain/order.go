package domain

// Order statuses.
const (
	StatusPlaced          = "placed"
	StatusConfirmed       = "confirmed"
	StatusCourierAssigned = "courier_assigned"
	StatusPickedUp        = "picked_up"
	StatusDelivered       = "delivered"
	StatusCancelled       = "cancelled"
)

// Cancel request states.
const (
	CancelRequestNone     = "none"
	CancelRequestPending  = "pending"
	CancelRequestRejected = "rejected"
)

// Who may ask for a cancellation; these values double as cancel reasons.
const (
	RequesterCustomer   = "customer"
	RequesterRestaurant = "restaurant"
	RequesterOps        = "ops"
)

// Cancel reasons other than the requesters above.
const (
	ReasonRestaurantRejected = "restaurant_rejected"
	ReasonConfirmTimeout     = "confirm_timeout"
	ReasonNoCourier          = "no_courier"
)

// IsTerminal reports whether status ends the lifecycle.
func IsTerminal(status string) bool {
	return status == StatusDelivered || status == StatusCancelled
}

// ValidStatus reports whether s is a known order status.
func ValidStatus(s string) bool {
	switch s {
	case StatusPlaced, StatusConfirmed, StatusCourierAssigned, StatusPickedUp, StatusDelivered, StatusCancelled:
		return true
	}
	return false
}

var transitions = map[string][]string{
	StatusPlaced:          {StatusConfirmed, StatusCancelled, StatusPickedUp, StatusDelivered},
	StatusConfirmed:       {StatusCourierAssigned, StatusPickedUp, StatusDelivered, StatusCancelled},
	StatusCourierAssigned: {StatusConfirmed, StatusPickedUp, StatusDelivered, StatusCancelled},
	StatusPickedUp:        {StatusDelivered},
}

// CanTransition reports whether the lifecycle allows moving from one status to another.
func CanTransition(from, to string) bool {
	for _, s := range transitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

// CancelAction is the outcome of a cancellation request against an order.
type CancelAction int

// Cancel actions.
const (
	CancelNow CancelAction = iota + 1
	CancelAskDispatch
	CancelAlreadyPending
	CancelRefused
)

// DecideCancel returns what a cancellation request does to an order in the
// given status and cancel-request state.
func DecideCancel(status, cancelRequest string) CancelAction {
	switch status {
	case StatusPlaced:
		return CancelNow
	case StatusConfirmed, StatusCourierAssigned:
		if cancelRequest == CancelRequestPending {
			return CancelAlreadyPending
		}
		return CancelAskDispatch
	default:
		return CancelRefused
	}
}

// CancellationFee returns the customer's fee for a cancellation dispatch accepted:
// zero when no courier was assigned or when the restaurant or ops asked,
// otherwise min(cancelFeeMinor, totalMinor).
func CancellationFee(requestedBy string, courierWasAssigned bool, cancelFeeMinor, totalMinor int64) int64 {
	if !courierWasAssigned || requestedBy != RequesterCustomer {
		return 0
	}
	return min(cancelFeeMinor, totalMinor)
}
