package domain

import (
	"testing"
	"time"
)

func TestTravelMinutes(t *testing.T) {
	tests := []struct {
		vehicle  string
		distance float64
		want     int64
	}{
		{"bike", 0, 0},
		{"bike", 1000, 6},
		{"scooter", 1000, 4},
		{"car", 1000, 3},
		{"car", 2000, 6},
		{"unknown", 1000, 6},
	}
	for _, tt := range tests {
		if got := TravelMinutes(tt.vehicle, tt.distance); got != tt.want {
			t.Errorf("TravelMinutes(%s, %.0f) = %d, want %d", tt.vehicle, tt.distance, got, tt.want)
		}
	}
}

func TestETAUsesWaitWhenCourierArrivesBeforeFoodIsReady(t *testing.T) {
	now := time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)
	ready := now.Add(10*time.Minute + 30*time.Second)
	if got := ETAMinutes("bike", 1000, 2000, ready, now); got != 11+11 {
		t.Fatalf("ETA = %d, want 22", got)
	}
}

func TestETAUsesTravelTimeWhenFoodIsReadyFirst(t *testing.T) {
	now := time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)
	if got := ETAMinutes("car", 4000, 2000, now.Add(-5*time.Minute), now); got != 11+6 {
		t.Fatalf("ETA = %d, want 17", got)
	}
	if got := ETAMinutes("car", 4000, 2000, now.Add(5*time.Minute), now); got != 11+6 {
		t.Fatalf("ETA with a short wait = %d, want 17", got)
	}
}
