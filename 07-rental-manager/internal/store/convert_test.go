package store

import (
	"strings"
	"testing"
	"time"

	"rentalmanager/internal/calendar"
)

func TestUUIDRoundTrip(t *testing.T) {
	const s = "0f8fad5b-d9cb-469f-a165-70867728950e"
	u, err := ParseUUID(s)
	if err != nil {
		t.Fatalf("ParseUUID: %v", err)
	}
	if got := FormatUUID(u); got != s {
		t.Fatalf("FormatUUID = %q, want %q", got, s)
	}
	upper, err := ParseUUID(strings.ToUpper(s))
	if err != nil || upper != u {
		t.Fatalf("upper-case UUID did not parse to the same value: %v", err)
	}
}

func TestParseUUIDRejectsMalformed(t *testing.T) {
	for _, s := range []string{"", "123", "0f8fad5bd9cb469fa16570867728950e", "0f8fad5b-d9cb-469f-a165-70867728950g", "0f8fad5b-d9cb-469f-a16570867728950e-"} {
		if _, err := ParseUUID(s); err == nil {
			t.Errorf("ParseUUID(%q) succeeded", s)
		}
	}
}

func TestNewUUIDIsVersion4(t *testing.T) {
	u, err := NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	s := FormatUUID(u)
	if s[14] != '4' || !strings.ContainsRune("89ab", rune(s[19])) {
		t.Fatalf("not a version 4 UUID: %s", s)
	}
}

func TestDateConversion(t *testing.T) {
	d := calendar.New(2024, time.February, 29)
	if got := ToDate(Date(d)); got != d {
		t.Fatalf("round trip = %v, want %v", got, d)
	}
	if ToOptionalDate(OptionalDate(nil)) != nil {
		t.Fatal("nil date did not round trip")
	}
}
