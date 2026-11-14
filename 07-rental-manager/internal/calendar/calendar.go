// Package calendar works with civil dates and calendar-month periods. Dates
// carry no time of day and no zone; converting an instant to a Date always
// names the zone explicitly.
package calendar

import (
	"errors"
	"fmt"
	"time"
)

// Date is a civil date in the proleptic Gregorian calendar.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// ErrInvalidDate is returned by Parse for anything other than a real
// calendar date written as YYYY-MM-DD.
var ErrInvalidDate = errors.New("must be a date in the form YYYY-MM-DD")

// New returns the date year-month-day. The caller supplies a valid date.
func New(year int, month time.Month, day int) Date {
	return Date{Year: year, Month: month, Day: day}
}

// Parse parses a YYYY-MM-DD date.
func Parse(s string) (Date, error) {
	if len(s) != len("2006-01-02") {
		return Date{}, ErrInvalidDate
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil || t.Year() < 1900 {
		return Date{}, ErrInvalidDate
	}
	return Date{Year: t.Year(), Month: t.Month(), Day: t.Day()}, nil
}

// FromTime returns the civil date of instant t in loc.
func FromTime(t time.Time, loc *time.Location) Date {
	t = t.In(loc)
	return Date{Year: t.Year(), Month: t.Month(), Day: t.Day()}
}

// IsLeap reports whether year is a Gregorian leap year.
func IsLeap(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}

// DaysInMonth returns the number of days in the given month.
func DaysInMonth(year int, month time.Month) int {
	switch month {
	case time.February:
		if IsLeap(year) {
			return 29
		}
		return 28
	case time.April, time.June, time.September, time.November:
		return 30
	default:
		return 31
	}
}

// ClampDay returns day, or the last day of the month when the month is
// shorter than day.
func ClampDay(year int, month time.Month, day int) int {
	if n := DaysInMonth(year, month); day > n {
		return n
	}
	return day
}

// midnightUTC is used only for day arithmetic: UTC has no DST transitions,
// so every day is exactly 24 hours long.
func (d Date) midnightUTC() time.Time {
	return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)
}

// AddDays returns the date n days after d (before d when n is negative).
func (d Date) AddDays(n int) Date {
	t := time.Date(d.Year, d.Month, d.Day+n, 0, 0, 0, 0, time.UTC)
	return Date{Year: t.Year(), Month: t.Month(), Day: t.Day()}
}

// DaysBetween returns the number of days from a to b; it is negative when b
// is before a.
func DaysBetween(a, b Date) int {
	return int(b.midnightUTC().Sub(a.midnightUTC()) / (24 * time.Hour))
}

// Compare returns -1, 0 or +1 as d is before, equal to or after o.
func (d Date) Compare(o Date) int {
	switch {
	case d.Year != o.Year:
		return sign(d.Year - o.Year)
	case d.Month != o.Month:
		return sign(int(d.Month) - int(o.Month))
	default:
		return sign(d.Day - o.Day)
	}
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	default:
		return 0
	}
}

// Before reports whether d is before o.
func (d Date) Before(o Date) bool { return d.Compare(o) < 0 }

// After reports whether d is after o.
func (d Date) After(o Date) bool { return d.Compare(o) > 0 }

// IsZero reports whether d is the zero Date.
func (d Date) IsZero() bool { return d == Date{} }

// Min returns the earlier of a and b.
func Min(a, b Date) Date {
	if b.Before(a) {
		return b
	}
	return a
}

// Max returns the later of a and b.
func Max(a, b Date) Date {
	if b.After(a) {
		return b
	}
	return a
}

// Period returns the calendar month containing d.
func (d Date) Period() Period {
	return Period{Year: d.Year, Month: d.Month}
}

// String formats d as YYYY-MM-DD.
func (d Date) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.Year, int(d.Month), d.Day)
}

// MarshalText encodes d as YYYY-MM-DD.
func (d Date) MarshalText() ([]byte, error) {
	return []byte(d.String()), nil
}

// Clock supplies the current instant.
type Clock interface {
	Now() time.Time
}

// SystemClock reads the machine clock.
type SystemClock struct{}

// Now returns the current time.
func (SystemClock) Now() time.Time { return time.Now() }

// FixedClock always returns T.
type FixedClock struct {
	T time.Time
}

// Now returns c.T.
func (c FixedClock) Now() time.Time { return c.T }

// Today returns the current civil date in loc according to c.
func Today(c Clock, loc *time.Location) Date {
	return FromTime(c.Now(), loc)
}
