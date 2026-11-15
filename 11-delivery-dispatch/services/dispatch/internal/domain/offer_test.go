package domain

import (
	"testing"
	"time"
)

func TestOfferOpen(t *testing.T) {
	expires := time.Date(2026, 3, 2, 18, 0, 30, 0, time.UTC)
	tests := []struct {
		name string
		now  time.Time
		want bool
	}{
		{"just created", expires.Add(-30 * time.Second), true},
		{"a second left", expires.Add(-time.Second), true},
		{"a millisecond late", expires.Add(time.Millisecond), false},
		{"long gone", expires.Add(time.Minute), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := OfferOpen(expires, tt.now); got != tt.want {
				t.Fatalf("OfferOpen(%v, %v) = %v, want %v", expires, tt.now, got, tt.want)
			}
		})
	}
}
