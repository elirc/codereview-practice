// Package domain holds the couriers service's pure rules: derived status,
// location acceptance and publishing, and reservation outcomes.
package domain

// Derived courier statuses.
const (
	StatusOffline   = "offline"
	StatusAvailable = "available"
	StatusBusy      = "busy"
)

// Vehicles.
const (
	VehicleBike    = "bike"
	VehicleScooter = "scooter"
	VehicleCar     = "car"
)

// Earning kinds.
const (
	EarningDelivery     = "delivery"
	EarningCompensation = "cancellation_compensation"
)

// ValidVehicle reports whether v is a known vehicle.
func ValidVehicle(v string) bool {
	return v == VehicleBike || v == VehicleScooter || v == VehicleCar
}

// DeriveStatus returns busy when a delivery is active, available when on
// shift and not suspended, and offline otherwise.
func DeriveStatus(suspended, onShift, hasActiveDelivery bool) string {
	switch {
	case hasActiveDelivery:
		return StatusBusy
	case onShift && !suspended:
		return StatusAvailable
	default:
		return StatusOffline
	}
}
