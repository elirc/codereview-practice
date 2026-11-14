// Package domain holds the dispatch service's pure rules: delivery and offer
// states, ETA, courier payout, surge tiers and the cancellation decision.
package domain

// Delivery statuses.
const (
	DeliverySearching = "searching"
	DeliveryOffered   = "offered"
	DeliveryReserving = "reserving"
	DeliveryAssigned  = "assigned"
	DeliveryPickedUp  = "picked_up"
	DeliveryDelivered = "delivered"
	DeliveryCancelled = "cancelled"
	DeliveryFailed    = "failed"
)

// Offer statuses.
const (
	OfferPending   = "pending"
	OfferAccepted  = "accepted"
	OfferDeclined  = "declined"
	OfferExpired   = "expired"
	OfferCancelled = "cancelled"
)

// Courier statuses as projected from the couriers service.
const (
	CourierOffline   = "offline"
	CourierAvailable = "available"
	CourierBusy      = "busy"
)

// ValidCourierStatus reports whether s is a projected courier status.
func ValidCourierStatus(s string) bool {
	return s == CourierOffline || s == CourierAvailable || s == CourierBusy
}

// ValidVehicle reports whether v is a known vehicle.
func ValidVehicle(v string) bool {
	_, ok := speedMPerMin[v]
	return ok
}

// speedMPerMin is the travel speed used for ETAs, in metres per minute.
var speedMPerMin = map[string]float64{
	"bike":    250,
	"scooter": 400,
	"car":     500,
}
