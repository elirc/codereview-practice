package domain

import "testing"

func TestCourierPayoutRounding(t *testing.T) {
	tests := []struct {
		base, fee, surge, share, want int64
	}{
		{300, 340, 10000, 8000, 572},
		{300, 425, 10000, 8000, 640},
		{300, 1, 10000, 5000, 301},
		{300, 1, 10000, 4999, 300},
		{0, 0, 10000, 8000, 0},
		{300, 1099, 10000, 10000, 1399},
		{300, 340, 15000, 8000, 708},
		{300, 340, 20000, 8000, 844},
		{300, 1, 12500, 4000, 301},
	}
	for _, tt := range tests {
		if got := CourierPayout(tt.base, tt.fee, tt.surge, tt.share); got != tt.want {
			t.Errorf("CourierPayout(%d, %d, %d, %d) = %d, want %d", tt.base, tt.fee, tt.surge, tt.share, got, tt.want)
		}
	}
}
