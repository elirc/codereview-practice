package domain

import "testing"

func TestSurgeTiers(t *testing.T) {
	tests := []struct {
		demand, supply int64
		want           int32
	}{
		{0, 0, 10000},
		{0, 5, 10000},
		{1, 3, 10000},
		{1, 2, 12500},
		{2, 3, 12500},
		{2, 2, 15000},
		{3, 2, 15000},
		{4, 2, 20000},
		{1, 0, 15000},
		{2, 0, 20000},
	}
	for _, tt := range tests {
		if got := SurgeBps(tt.demand, tt.supply); got != tt.want {
			t.Errorf("SurgeBps(%d, %d) = %d, want %d", tt.demand, tt.supply, got, tt.want)
		}
	}
}
