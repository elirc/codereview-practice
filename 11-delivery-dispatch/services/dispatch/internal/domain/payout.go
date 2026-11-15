package domain

// CourierPayout returns roundHalfUp(baseMinor + feeMinor × surgeBps / 10000 ×
// shareBps / 10000): the courier's share is taken from the delivery fee at
// the delivery's surge multiplier.
func CourierPayout(baseMinor, feeMinor, surgeBps, shareBps int64) int64 {
	const scale = 10000 * 10000
	return (baseMinor*scale + feeMinor*surgeBps*shareBps + scale/2) / scale
}
