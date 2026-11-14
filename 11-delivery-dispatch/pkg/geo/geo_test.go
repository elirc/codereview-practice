package geo

import (
	"math"
	"testing"
)

func TestDistanceM(t *testing.T) {
	tests := []struct {
		name                   string
		lon1, lat1, lon2, lat2 float64
		want, tolerance        float64
	}{
		{"same point", 3.38, 6.52, 3.38, 6.52, 0, 0.001},
		{"one degree of latitude", 0, 0, 0, 1, 111195, 5},
		{"one degree of longitude at the equator", 0, 0, 1, 0, 111195, 5},
		{"Lagos short hop", 3.3792, 6.5244, 3.3958, 6.5244, 1835, 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DistanceM(tt.lon1, tt.lat1, tt.lon2, tt.lat2)
			if math.Abs(got-tt.want) > tt.tolerance {
				t.Fatalf("DistanceM = %.1f, want %.1f ± %.1f", got, tt.want, tt.tolerance)
			}
		})
	}
}

func TestCeilMRoundsUp(t *testing.T) {
	d := DistanceM(0, 0, 0, 0.01)
	if got := CeilM(0, 0, 0, 0.01); float64(got) < d || float64(got)-d >= 1 {
		t.Fatalf("CeilM = %d for %.3f", got, d)
	}
}

func TestCoordinateRanges(t *testing.T) {
	if !ValidLon(-180) || !ValidLon(180) || ValidLon(180.0001) || ValidLon(math.NaN()) {
		t.Fatal("ValidLon boundaries")
	}
	if !ValidLat(-90) || !ValidLat(90) || ValidLat(-90.0001) {
		t.Fatal("ValidLat boundaries")
	}
}
