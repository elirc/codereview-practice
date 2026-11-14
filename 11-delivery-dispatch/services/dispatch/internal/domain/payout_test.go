package domain

import "testing"

func TestCourierPayoutRounding(t *testing.T) {
	tests := []struct {
		base, fee, share, want int64
	}{
		{300, 340, 8000, 572},
		{300, 425, 8000, 640},
		{300, 1, 5000, 301},
		{300, 1, 4999, 300},
		{0, 0, 8000, 0},
		{300, 1099, 10000, 1399},
	}
	for _, tt := range tests {
		if got := CourierPayout(tt.base, tt.fee, tt.share); got != tt.want {
			t.Errorf("CourierPayout(%d, %d, %d) = %d, want %d", tt.base, tt.fee, tt.share, got, tt.want)
		}
	}
}
