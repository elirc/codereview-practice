package domain

import (
	"math"
	"time"
)

// routeFactor converts straight-line distance to an estimated route length.
const routeFactor = 1.3

// TravelMinutes returns ceil(distanceM × 1.3 / speed) for the vehicle.
// Unknown vehicles travel at bike speed.
func TravelMinutes(vehicle string, distanceM float64) int64 {
	speed, ok := speedMPerMin[vehicle]
	if !ok {
		speed = speedMPerMin["bike"]
	}
	return int64(math.Ceil(distanceM * routeFactor / speed))
}

// ETAMinutes returns max(minutes to pickup, minutes until the food is ready)
// plus the minutes from pickup to drop-off.
func ETAMinutes(vehicle string, toPickupM, toDropoffM float64, readyAt, now time.Time) int64 {
	toPickup := TravelMinutes(vehicle, toPickupM)
	toDropoff := TravelMinutes(vehicle, toDropoffM)
	wait := int64(math.Ceil(readyAt.Sub(now).Minutes()))
	if wait < 0 {
		wait = 0
	}
	return max(toPickup, wait) + toDropoff
}
