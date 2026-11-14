package money

import (
	"errors"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		in      string
		want    Cents
		wantErr error
	}{
		{"1000", 100000, nil},
		{"1000.5", 100050, nil},
		{"1000.05", 100005, nil},
		{"0.25", 25, nil},
		{"007", 700, nil},
		{" 12.30 ", 1230, nil},
		{"0", 0, nil},
		{"999999999.99", 99999999999, nil},
		{"1000000000", 0, ErrTooLarge},
		{"12.345", 0, ErrSyntax},
		{"-5", 0, ErrSyntax},
		{"+5", 0, ErrSyntax},
		{"1e3", 0, ErrSyntax},
		{"1,000.00", 0, ErrSyntax},
		{"", 0, ErrSyntax},
		{".5", 0, ErrSyntax},
		{"5.", 0, ErrSyntax},
		{"1 000", 0, ErrSyntax},
		{"$10", 0, ErrSyntax},
		{"NaN", 0, ErrSyntax},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := Parse(tt.in)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Parse(%q) error = %v, want %v", tt.in, err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("Parse(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestParsePositive(t *testing.T) {
	tests := []struct {
		in      string
		want    Cents
		wantErr error
	}{
		{"1000", 100000, nil},
		{"0.01", 1, nil},
		{"0", 0, ErrNotPositive},
		{"0.00", 0, ErrNotPositive},
		{"-5", 0, ErrSyntax},
		{"", 0, ErrSyntax},
	}
	for _, tt := range tests {
		got, err := ParsePositive(tt.in)
		if !errors.Is(err, tt.wantErr) || got != tt.want {
			t.Errorf("ParsePositive(%q) = %d, %v; want %d, %v", tt.in, got, err, tt.want, tt.wantErr)
		}
	}
}

func TestFormat(t *testing.T) {
	tests := []struct {
		in    Cents
		str   string
		plain string
	}{
		{0, "$0.00", "0.00"},
		{5, "$0.05", "0.05"},
		{100050, "$1,000.50", "1000.50"},
		{123456789, "$1,234,567.89", "1234567.89"},
		{-1200, "-$12.00", "-12.00"},
		{99999, "$999.99", "999.99"},
	}
	for _, tt := range tests {
		if got := tt.in.String(); got != tt.str {
			t.Errorf("Cents(%d).String() = %q, want %q", tt.in, got, tt.str)
		}
		if got := tt.in.Plain(); got != tt.plain {
			t.Errorf("Cents(%d).Plain() = %q, want %q", tt.in, got, tt.plain)
		}
	}
}

func TestPlainRoundTrips(t *testing.T) {
	for _, c := range []Cents{0, 1, 10, 99, 100, 123456} {
		got, err := Parse(c.Plain())
		if err != nil || got != c {
			t.Errorf("Parse(%q) = %d, %v; want %d", c.Plain(), got, err, c)
		}
	}
}

func TestRounding(t *testing.T) {
	tests := []struct {
		name string
		got  Cents
		want Cents
	}{
		{"prorate 10 of 31 days", Prorate(100000, 10, 31), 32258},
		{"prorate 1 of 31 days", Prorate(100001, 1, 31), 3226},
		{"prorate 15 of 29 days", Prorate(150000, 15, 29), 77586},
		{"prorate full month", Prorate(150000, 30, 30), 150000},
		{"half rounds up", Prorate(1, 1, 2), 1},
		{"below half rounds down", Prorate(1, 1, 3), 0},
		{"5% of 1000.00", BasisPoints(100000, 500), 5000},
		{"5% of 0.10 rounds half up", BasisPoints(10, 500), 1},
		{"1bp of 49.99 rounds to zero", BasisPoints(4999, 1), 0},
		{"1bp of 50.00 rounds half up", BasisPoints(5000, 1), 1},
	}
	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s: got %d, want %d", tt.name, tt.got, tt.want)
		}
	}
}
