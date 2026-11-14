package domain

import "testing"

func TestTransitionTable(t *testing.T) {
	allowed := map[[2]string]bool{
		{StatusPlaced, StatusConfirmed}:                true,
		{StatusPlaced, StatusCancelled}:                true,
		{StatusPlaced, StatusPickedUp}:                 true,
		{StatusPlaced, StatusDelivered}:                true,
		{StatusConfirmed, StatusCourierAssigned}:       true,
		{StatusConfirmed, StatusPickedUp}:              true,
		{StatusConfirmed, StatusDelivered}:             true,
		{StatusConfirmed, StatusCancelled}:             true,
		{StatusCourierAssigned, StatusConfirmed}:       true,
		{StatusCourierAssigned, StatusPickedUp}:        true,
		{StatusCourierAssigned, StatusDelivered}:       true,
		{StatusCourierAssigned, StatusCancelled}:       true,
		{StatusPickedUp, StatusDelivered}:              true,
		{StatusPickedUp, StatusCancelled}:              false,
		{StatusPlaced, StatusCourierAssigned}:          false,
		{StatusDelivered, StatusCancelled}:             false,
		{StatusCancelled, StatusConfirmed}:             false,
		{StatusCancelled, StatusDelivered}:             false,
		{StatusDelivered, StatusPickedUp}:              false,
		{StatusPickedUp, StatusCourierAssigned}:        false,
		{StatusCourierAssigned, StatusCourierAssigned}: false,
	}
	for pair, want := range allowed {
		if got := CanTransition(pair[0], pair[1]); got != want {
			t.Errorf("CanTransition(%s, %s) = %v, want %v", pair[0], pair[1], got, want)
		}
	}
}

func TestTerminalStatuses(t *testing.T) {
	for _, s := range []string{StatusPlaced, StatusConfirmed, StatusCourierAssigned, StatusPickedUp} {
		if IsTerminal(s) {
			t.Errorf("%s reported terminal", s)
		}
	}
	for _, s := range []string{StatusDelivered, StatusCancelled} {
		if !IsTerminal(s) {
			t.Errorf("%s not reported terminal", s)
		}
	}
}
