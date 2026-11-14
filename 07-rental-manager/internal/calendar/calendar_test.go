package calendar

import (
	"errors"
	"testing"
	"time"
	_ "time/tzdata"
)

func TestIsLeap(t *testing.T) {
	tests := map[int]bool{1900: false, 2000: true, 2023: false, 2024: true, 2100: false, 2400: true}
	for year, want := range tests {
		if got := IsLeap(year); got != want {
			t.Errorf("IsLeap(%d) = %v, want %v", year, got, want)
		}
	}
}

func TestDaysInMonth(t *testing.T) {
	tests := []struct {
		year  int
		month time.Month
		want  int
	}{
		{2026, time.January, 31},
		{2026, time.February, 28},
		{2024, time.February, 29},
		{2000, time.February, 29},
		{1900, time.February, 28},
		{2026, time.April, 30},
		{2026, time.June, 30},
		{2026, time.July, 31},
		{2026, time.September, 30},
		{2026, time.November, 30},
		{2026, time.December, 31},
	}
	for _, tt := range tests {
		if got := DaysInMonth(tt.year, tt.month); got != tt.want {
			t.Errorf("DaysInMonth(%d, %s) = %d, want %d", tt.year, tt.month, got, tt.want)
		}
	}
}

func TestClampDay(t *testing.T) {
	tests := []struct {
		year  int
		month time.Month
		day   int
		want  int
	}{
		{2026, time.January, 31, 31},
		{2026, time.February, 31, 28},
		{2024, time.February, 31, 29},
		{2026, time.February, 29, 28},
		{2026, time.March, 29, 29},
		{2026, time.April, 31, 30},
		{2026, time.April, 15, 15},
	}
	for _, tt := range tests {
		if got := ClampDay(tt.year, tt.month, tt.day); got != tt.want {
			t.Errorf("ClampDay(%d, %s, %d) = %d, want %d", tt.year, tt.month, tt.day, got, tt.want)
		}
	}
}

func TestDueDatesFollowOriginalDueDay(t *testing.T) {
	tests := []struct {
		name   string
		dueDay int
		start  Period
		want   []string
	}{
		{"due on the 31st", 31, Period{2026, time.January}, []string{"2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"}},
		{"due on the 31st in a leap year", 31, Period{2024, time.January}, []string{"2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30"}},
		{"due on the 29th", 29, Period{2026, time.January}, []string{"2026-01-29", "2026-02-28", "2026-03-29", "2026-04-29"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := tt.start
			for _, want := range tt.want {
				if got := p.DueDate(tt.dueDay).String(); got != want {
					t.Errorf("DueDate(%s, %d) = %s, want %s", p, tt.dueDay, got, want)
				}
				p = p.Next()
			}
		})
	}
}

func TestAddDays(t *testing.T) {
	tests := []struct {
		from string
		n    int
		want string
	}{
		{"2026-01-31", 1, "2026-02-01"},
		{"2026-02-28", 1, "2026-03-01"},
		{"2024-02-28", 1, "2024-02-29"},
		{"2026-12-31", 1, "2027-01-01"},
		{"2027-01-01", -1, "2026-12-31"},
		{"2026-03-01", -1, "2026-02-28"},
		{"2026-03-07", 2, "2026-03-09"},
		{"2026-11-01", 1, "2026-11-02"},
		{"2026-01-15", 365, "2027-01-15"},
		{"2026-01-15", 0, "2026-01-15"},
	}
	for _, tt := range tests {
		got := mustParse(t, tt.from).AddDays(tt.n).String()
		if got != tt.want {
			t.Errorf("%s + %d days = %s, want %s", tt.from, tt.n, got, tt.want)
		}
	}
}

func TestDaysBetween(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"2026-01-01", "2026-01-31", 30},
		{"2026-01-31", "2026-03-02", 30},
		{"2024-02-01", "2024-03-01", 29},
		{"2026-03-01", "2026-03-15", 14},
		{"2026-12-31", "2027-01-01", 1},
		{"2026-03-15", "2026-03-01", -14},
	}
	for _, tt := range tests {
		if got := DaysBetween(mustParse(t, tt.a), mustParse(t, tt.b)); got != tt.want {
			t.Errorf("DaysBetween(%s, %s) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}

func TestParse(t *testing.T) {
	valid := []string{"2026-01-01", "2024-02-29", "1999-12-31"}
	for _, s := range valid {
		d, err := Parse(s)
		if err != nil || d.String() != s {
			t.Errorf("Parse(%q) = %v, %v", s, d, err)
		}
	}
	invalid := []string{"", "2026-1-01", "2026-02-30", "2026-13-01", "2023-02-29", "26-01-01", "2026/01/01", "2026-01-01T00:00:00Z", "1850-01-01"}
	for _, s := range invalid {
		if _, err := Parse(s); !errors.Is(err, ErrInvalidDate) {
			t.Errorf("Parse(%q) error = %v, want ErrInvalidDate", s, err)
		}
	}
}

func TestParsePeriod(t *testing.T) {
	p, err := ParsePeriod("2026-02")
	if err != nil || p != (Period{2026, time.February}) {
		t.Fatalf("ParsePeriod = %v, %v", p, err)
	}
	for _, s := range []string{"", "2026-2", "2026-13", "2026-02-01"} {
		if _, err := ParsePeriod(s); !errors.Is(err, ErrInvalidPeriod) {
			t.Errorf("ParsePeriod(%q) error = %v", s, err)
		}
	}
}

func TestPeriodArithmetic(t *testing.T) {
	dec := Period{2026, time.December}
	if got := dec.Next(); got != (Period{2027, time.January}) {
		t.Errorf("Next = %v", got)
	}
	if !dec.Before(dec.Next()) || dec.Next().Before(dec) || dec.Before(dec) {
		t.Error("Before ordering is wrong")
	}
	feb := Period{2024, time.February}
	if feb.First().String() != "2024-02-01" || feb.Last().String() != "2024-02-29" || feb.Days() != 29 {
		t.Errorf("February 2024 bounds: %s..%s (%d days)", feb.First(), feb.Last(), feb.Days())
	}
}

func TestCompareMinMax(t *testing.T) {
	a := mustParse(t, "2026-03-09")
	b := mustParse(t, "2026-03-10")
	if a.Compare(b) != -1 || b.Compare(a) != 1 || a.Compare(a) != 0 {
		t.Error("Compare ordering is wrong")
	}
	if Min(a, b) != a || Max(a, b) != b || Min(b, a) != a || Max(b, a) != b {
		t.Error("Min/Max are wrong")
	}
	if !mustParse(t, "2025-12-31").Before(mustParse(t, "2026-01-01")) {
		t.Error("year boundary ordering is wrong")
	}
}

func TestTodayInZone(t *testing.T) {
	chicago, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		now  time.Time
		want string
	}{
		{"03:00 UTC on the 1st is still the previous day", time.Date(2026, 3, 1, 3, 0, 0, 0, time.UTC), "2026-02-28"},
		{"06:00 UTC on the 1st in winter is the 1st", time.Date(2026, 3, 1, 6, 0, 0, 0, time.UTC), "2026-03-01"},
		{"04:59 UTC in summer is the previous day", time.Date(2026, 7, 1, 4, 59, 0, 0, time.UTC), "2026-06-30"},
		{"05:00 UTC in summer is the new day", time.Date(2026, 7, 1, 5, 0, 0, 0, time.UTC), "2026-07-01"},
		{"new year in UTC is still December", time.Date(2027, 1, 1, 2, 0, 0, 0, time.UTC), "2026-12-31"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Today(FixedClock{T: tt.now}, chicago).String(); got != tt.want {
				t.Errorf("Today = %s, want %s", got, tt.want)
			}
		})
	}
}

func mustParse(t *testing.T, s string) Date {
	t.Helper()
	d, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q): %v", s, err)
	}
	return d
}
