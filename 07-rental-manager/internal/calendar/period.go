package calendar

import (
	"errors"
	"fmt"
	"time"
)

// Period is a calendar month, written YYYY-MM.
type Period struct {
	Year  int
	Month time.Month
}

// ErrInvalidPeriod is returned by ParsePeriod.
var ErrInvalidPeriod = errors.New("must be a month in the form YYYY-MM")

// ParsePeriod parses a YYYY-MM period.
func ParsePeriod(s string) (Period, error) {
	if len(s) != len("2006-01") {
		return Period{}, ErrInvalidPeriod
	}
	t, err := time.Parse("2006-01", s)
	if err != nil || t.Year() < 1900 {
		return Period{}, ErrInvalidPeriod
	}
	return Period{Year: t.Year(), Month: t.Month()}, nil
}

// String formats p as YYYY-MM.
func (p Period) String() string {
	return fmt.Sprintf("%04d-%02d", p.Year, int(p.Month))
}

// Next returns the following month.
func (p Period) Next() Period {
	if p.Month == time.December {
		return Period{Year: p.Year + 1, Month: time.January}
	}
	return Period{Year: p.Year, Month: p.Month + 1}
}

// Before reports whether p is an earlier month than q.
func (p Period) Before(q Period) bool {
	return p.Year < q.Year || (p.Year == q.Year && p.Month < q.Month)
}

// Days returns the number of days in p.
func (p Period) Days() int {
	return DaysInMonth(p.Year, p.Month)
}

// First returns the first day of p.
func (p Period) First() Date {
	return Date{Year: p.Year, Month: p.Month, Day: 1}
}

// Last returns the last day of p.
func (p Period) Last() Date {
	return Date{Year: p.Year, Month: p.Month, Day: p.Days()}
}

// DueDate returns the date in p on which a payment with the given day of
// month falls due, clamped to the end of short months.
func (p Period) DueDate(dueDay int) Date {
	return Date{Year: p.Year, Month: p.Month, Day: ClampDay(p.Year, p.Month, dueDay)}
}
