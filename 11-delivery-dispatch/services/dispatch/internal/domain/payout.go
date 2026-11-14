package domain

// CourierPayout returns roundHalfUp(baseMinor + feeMinor × shareBps / 10000).
func CourierPayout(baseMinor, feeMinor, shareBps int64) int64 {
	return (baseMinor*10000 + feeMinor*shareBps + 5000) / 10000
}
