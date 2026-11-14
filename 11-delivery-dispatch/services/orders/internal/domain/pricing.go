// Package domain holds the orders service's pure rules: pricing, the order
// lifecycle and cancellation terms.
package domain

import "time"

// NeutralSurgeBps is the surge multiplier of a zone with no stored surge.
const NeutralSurgeBps = 10000

// Item is one line of a quote.
type Item struct {
	Name           string `json:"name"`
	Quantity       int64  `json:"quantity"`
	UnitPriceMinor int64  `json:"unit_price_minor"`
}

// Item limits.
const (
	MinItems          = 1
	MaxItems          = 40
	MinQuantity       = 1
	MaxQuantity       = 50
	MaxUnitPriceMinor = 10_000_000
)

// FeeRules are the tariff settings that price a delivery.
type FeeRules struct {
	BaseFeeMinor int64
	PerKmMinor   int64
}

// Subtotal returns the sum of quantity × unit price over items.
func Subtotal(items []Item) int64 {
	var total int64
	for _, it := range items {
		total += it.Quantity * it.UnitPriceMinor
	}
	return total
}

// DeliveryFee returns roundHalfUp((base × 1000 + perKm × distanceM) × surgeBps / (1000 × 10000)).
func DeliveryFee(rules FeeRules, distanceM, surgeBps int64) int64 {
	numerator := (rules.BaseFeeMinor*1000 + rules.PerKmMinor*distanceM) * surgeBps
	return divRoundHalfUp(numerator, 1000*10000)
}

// QuoteETAMinutes returns prepMinutes + ceil(distanceM × 1.3 / 333) + 5.
func QuoteETAMinutes(prepMinutes, distanceM int64) int64 {
	travel := (distanceM*13 + 3329) / 3330
	return prepMinutes + travel + 5
}

// QuoteUsable reports whether a quote expiring at expiresAt may still be used at now.
func QuoteUsable(expiresAt, now time.Time) bool {
	return now.Before(expiresAt)
}

func divRoundHalfUp(n, d int64) int64 {
	return (n + d/2) / d
}
