package domain

import (
	"testing"
	"time"
)

func TestJudgeLocation(t *testing.T) {
	now := time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		recorded time.Time
		want     LocationVerdict
	}{
		{"now", now, LocationAccepted},
		{"30s ahead", now.Add(30 * time.Second), LocationAccepted},
		{"31s ahead", now.Add(31 * time.Second), LocationInFuture},
		{"exactly 5 min old", now.Add(-5 * time.Minute), LocationAccepted},
		{"6 min old", now.Add(-6 * time.Minute), LocationTooOld},
	}
	for _, tt := range tests {
		if got := JudgeLocation(tt.recorded, now); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestShouldReplacePosition(t *testing.T) {
	stored := time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)
	if !ShouldReplacePosition(nil, stored) {
		t.Error("first position not stored")
	}
	if ShouldReplacePosition(&stored, stored) || ShouldReplacePosition(&stored, stored.Add(-time.Second)) {
		t.Error("older or equal ping replaced the position")
	}
	if !ShouldReplacePosition(&stored, stored.Add(time.Millisecond)) {
		t.Error("newer ping did not replace the position")
	}
}

func TestShouldPublishLocation(t *testing.T) {
	pub := time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		onShift   bool
		published *time.Time
		recorded  time.Time
		distance  float64
		want      bool
	}{
		{"first ping on shift", true, nil, pub, 0, true},
		{"off shift", false, nil, pub, 500, false},
		{"4s later without movement", true, &pub, pub.Add(4 * time.Second), 0, false},
		{"10s later", true, &pub, pub.Add(10 * time.Second), 0, true},
		{"60m away at once", true, &pub, pub.Add(time.Second), 60, true},
		{"49m away", true, &pub, pub.Add(time.Second), 49.9, false},
		{"exactly 50m away", true, &pub, pub.Add(time.Second), 50, true},
	}
	for _, tt := range tests {
		if got := ShouldPublishLocation(tt.onShift, tt.published, tt.recorded, tt.distance); got != tt.want {
			t.Errorf("%s: got %v, want %v", tt.name, got, tt.want)
		}
	}
}
