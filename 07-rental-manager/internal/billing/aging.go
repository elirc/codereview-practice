package billing

import (
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
)

// Buckets split unpaid amounts by the age of the charge in days.
type Buckets struct {
	Current    money.Cents
	From31To60 money.Cents
	From61To90 money.Cents
	Over90     money.Cents
}

// Total returns the sum of all buckets.
func (b Buckets) Total() money.Cents {
	return b.Current + b.From31To60 + b.From61To90 + b.Over90
}

// Add accumulates o into b.
func (b *Buckets) Add(o Buckets) {
	b.Current += o.Current
	b.From31To60 += o.From31To60
	b.From61To90 += o.From61To90
	b.Over90 += o.Over90
}

// Aging is one lease's receivables: unpaid charges by age, plus any credit
// that is not applied to a charge.
type Aging struct {
	Buckets
	Credit money.Cents
}

// Balance returns the amount owed; it equals the ledger balance for the
// same entries and date.
func (a Aging) Balance() money.Cents {
	return a.Total() - a.Credit
}

// Age buckets the unpaid remainders in alloc by days between each charge's
// entry date and asOf. alloc should have been computed with cutoff asOf.
func Age(alloc Allocation, asOf calendar.Date) Aging {
	var b Buckets
	for _, it := range alloc.Items {
		if it.Unpaid <= 0 {
			continue
		}
		switch age := calendar.DaysBetween(it.Date, asOf); {
		case age <= 30:
			b.Current += it.Unpaid
		case age <= 60:
			b.From31To60 += it.Unpaid
		case age <= 90:
			b.From61To90 += it.Unpaid
		default:
			b.Over90 += it.Unpaid
		}
	}
	return Aging{Buckets: b, Credit: alloc.Unapplied}
}
