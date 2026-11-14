package domain

import "testing"

func TestDeriveStatus(t *testing.T) {
	tests := []struct {
		suspended, onShift, active bool
		want                       string
	}{
		{false, false, false, StatusOffline},
		{false, true, false, StatusAvailable},
		{true, true, false, StatusOffline},
		{true, false, false, StatusOffline},
		{false, true, true, StatusBusy},
		{true, true, true, StatusBusy},
		{true, false, true, StatusBusy},
		{false, false, true, StatusBusy},
	}
	for _, tt := range tests {
		if got := DeriveStatus(tt.suspended, tt.onShift, tt.active); got != tt.want {
			t.Errorf("DeriveStatus(suspended=%v, onShift=%v, active=%v) = %s, want %s", tt.suspended, tt.onShift, tt.active, got, tt.want)
		}
	}
}

func TestValidVehicle(t *testing.T) {
	for _, v := range []string{"bike", "scooter", "car"} {
		if !ValidVehicle(v) {
			t.Errorf("%s rejected", v)
		}
	}
	if ValidVehicle("truck") {
		t.Error("truck accepted")
	}
}
