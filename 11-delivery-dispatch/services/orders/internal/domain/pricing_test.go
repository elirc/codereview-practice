package domain

import (
	"testing"
	"time"
)

func TestDeliveryFeeRounding(t *testing.T) {
	rules := FeeRules{BaseFeeMinor: 199, PerKmMinor: 60}
	tests := []struct {
		name      string
		distanceM int64
		surgeBps  int64
		want      int64
	}{
		{"documented example rounds 424.625 up", 2345, 12500, 425},
		{"no surge", 2345, 10000, 340},
		{"zero distance", 0, 10000, 199},
		{"exact half rounds up", 25, 10000, 201},
		{"just under half rounds down", 24, 10000, 200},
		{"double surge", 1000, 20000, 518},
		{"maximum distance", 15000, 10000, 1099},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DeliveryFee(rules, tt.distanceM, tt.surgeBps); got != tt.want {
				t.Fatalf("DeliveryFee(%d m, %d bps) = %d, want %d", tt.distanceM, tt.surgeBps, got, tt.want)
			}
		})
	}
}

func TestQuoteETAMinutes(t *testing.T) {
	tests := []struct {
		prep, distance, want int64
	}{
		{15, 0, 20},
		{15, 1, 21},
		{15, 2561, 30},
		{15, 2562, 31},
		{15, 3330, 33},
		{15, 3331, 34},
		{30, 15000, 94},
	}
	for _, tt := range tests {
		if got := QuoteETAMinutes(tt.prep, tt.distance); got != tt.want {
			t.Errorf("QuoteETAMinutes(%d, %d) = %d, want %d", tt.prep, tt.distance, got, tt.want)
		}
	}
}

func TestQuoteUsableUntilExpiry(t *testing.T) {
	expires := time.Date(2026, 3, 1, 12, 5, 0, 0, time.UTC)
	if !QuoteUsable(expires, expires.Add(-time.Millisecond)) {
		t.Fatal("quote should be usable a millisecond before expiry")
	}
	if QuoteUsable(expires, expires) {
		t.Fatal("quote should not be usable at its expiry instant")
	}
	if QuoteUsable(expires, expires.Add(time.Second)) {
		t.Fatal("quote should not be usable after expiry")
	}
}

func TestSubtotal(t *testing.T) {
	items := []Item{
		{Name: "Jollof rice", Quantity: 2, UnitPriceMinor: 1250},
		{Name: "Plantain", Quantity: 3, UnitPriceMinor: 300},
	}
	if got := Subtotal(items); got != 3400 {
		t.Fatalf("Subtotal = %d, want 3400", got)
	}
}
