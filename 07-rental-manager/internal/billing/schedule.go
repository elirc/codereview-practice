package billing

import (
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
)

// Terms are the parts of a lease that determine its rent schedule. End is
// the inclusive last day of occupancy, or nil for a month-to-month lease.
type Terms struct {
	Start  calendar.Date
	End    *calendar.Date
	Rent   money.Cents
	DueDay int
}

// Charge is the rent for one period of a lease.
type Charge struct {
	Period      calendar.Period
	Date        calendar.Date
	Amount      money.Cents
	Days        int
	DaysInMonth int
}

// Prorated reports whether the charge covers only part of its month.
func (c Charge) Prorated() bool {
	return c.Days != c.DaysInMonth
}

// FirstPeriod returns the month in which the lease starts.
func (t Terms) FirstPeriod() calendar.Period {
	return t.Start.Period()
}

// LastPeriod returns the month in which the lease ends, and false for an
// open-ended lease.
func (t Terms) LastPeriod() (calendar.Period, bool) {
	if t.End == nil {
		return calendar.Period{}, false
	}
	return t.End.Period(), true
}

// ChargeFor returns the rent charge for period p. It returns false when the
// lease occupies no day of p or when the prorated amount rounds to zero.
func ChargeFor(t Terms, p calendar.Period) (Charge, bool) {
	occStart := calendar.Max(t.Start, p.First())
	occEnd := p.Last()
	if t.End != nil {
		occEnd = calendar.Min(*t.End, occEnd)
	}
	if occEnd.Before(occStart) {
		return Charge{}, false
	}

	days := calendar.DaysBetween(occStart, occEnd) + 1
	dim := p.Days()
	amount := t.Rent
	if days != dim {
		amount = money.Prorate(t.Rent, int64(days), int64(dim))
	}
	if amount == 0 {
		return Charge{}, false
	}

	date := p.DueDate(t.DueDay)
	if p == t.FirstPeriod() {
		date = calendar.Max(t.Start, date)
	}
	return Charge{Period: p, Date: date, Amount: amount, Days: days, DaysInMonth: dim}, true
}

// Schedule returns the charges of every period from the lease's first month
// through the month `through`, stopping at the lease's last month.
func Schedule(t Terms, through calendar.Period) []Charge {
	last, bounded := t.LastPeriod()
	var charges []Charge
	for p := t.FirstPeriod(); !through.Before(p); p = p.Next() {
		if bounded && last.Before(p) {
			break
		}
		if c, ok := ChargeFor(t, p); ok {
			charges = append(charges, c)
		}
	}
	return charges
}

// DueThrough returns the scheduled charges whose charge date is on or
// before asOf.
func DueThrough(t Terms, asOf calendar.Date) []Charge {
	var due []Charge
	for _, c := range Schedule(t, asOf.Period()) {
		if !c.Date.After(asOf) {
			due = append(due, c)
		}
	}
	return due
}

// PostedRent is a rent charge that is already in the ledger and not reversed.
type PostedRent struct {
	Period calendar.Period
	Amount money.Cents
}

// CreditLine is one period whose posted rent exceeds the rent now due.
type CreditLine struct {
	Period calendar.Period
	Posted money.Cents
	Due    money.Cents
}

// EndCredit is the suggested credit when a lease end date moves earlier.
type EndCredit struct {
	Lines []CreditLine
	Total money.Cents
}

// SuggestEndCredit compares rent already posted with the rent due under t,
// which carries the new end date, and suggests crediting the difference.
func SuggestEndCredit(t Terms, posted []PostedRent) EndCredit {
	var out EndCredit
	for _, pr := range posted {
		var due money.Cents
		if c, ok := ChargeFor(t, pr.Period); ok {
			due = c.Amount
		}
		if pr.Amount > due {
			out.Lines = append(out.Lines, CreditLine{Period: pr.Period, Posted: pr.Amount, Due: due})
			out.Total += pr.Amount - due
		}
	}
	return out
}
