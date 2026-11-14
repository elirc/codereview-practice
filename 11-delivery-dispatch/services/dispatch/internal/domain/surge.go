package domain

// NeutralSurgeBps is the multiplier when there is no surge.
const NeutralSurgeBps = 10000

// SurgeBps returns the zone multiplier for open deliveries (demand) and
// available couriers with a fresh position (supply), with r = demand /
// max(supply, 1): no demand or r < 0.5 → 10000, r < 1 → 12500, r < 2 →
// 15000, otherwise 20000.
func SurgeBps(demand, supply int64) int32 {
	if demand <= 0 {
		return NeutralSurgeBps
	}
	if supply < 1 {
		supply = 1
	}
	switch {
	case 2*demand < supply:
		return NeutralSurgeBps
	case demand < supply:
		return 12500
	case demand < 2*supply:
		return 15000
	default:
		return 20000
	}
}
