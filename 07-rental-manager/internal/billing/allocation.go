package billing

import (
	"sort"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
)

// Entry is a ledger entry as seen by the billing rules. Amount is signed as
// stored: charges positive, payments and credits negative. ReversesID is 0
// unless the entry is a reversal.
type Entry struct {
	ID         int64
	Date       calendar.Date
	Kind       Kind
	Amount     money.Cents
	Period     string
	ReversesID int64
}

// Item is a charge together with the part of it that remains unpaid.
type Item struct {
	Entry
	Unpaid money.Cents
}

// Allocation is the result of applying credits to charges oldest first.
// Items are ordered by (date, id); Unapplied is credit left over after
// every charge is paid.
type Allocation struct {
	Items     []Item
	Unapplied money.Cents
}

// ReversedIDs returns the IDs of entries that some entry in entries reverses.
func ReversedIDs(entries []Entry) map[int64]bool {
	reversed := make(map[int64]bool)
	for _, e := range entries {
		if e.Kind == KindReversal && e.ReversesID != 0 {
			reversed[e.ReversesID] = true
		}
	}
	return reversed
}

// Allocate applies the payments and credits dated on or before cutoff to the
// charges dated on or before cutoff, oldest first. A reversal and the entry
// it reverses are both left out, whatever their dates, so the reversal
// status of an entry is decided by the entries passed in.
func Allocate(entries []Entry, cutoff calendar.Date) Allocation {
	reversed := ReversedIDs(entries)
	var items []Item
	var credit money.Cents
	for _, e := range entries {
		if e.Kind == KindReversal || reversed[e.ID] || e.Date.After(cutoff) {
			continue
		}
		switch {
		case e.Kind.IsCharge():
			items = append(items, Item{Entry: e, Unpaid: e.Amount})
		case e.Kind.IsCredit():
			credit -= e.Amount
		}
	}

	sort.Slice(items, func(i, j int) bool {
		return entryBefore(items[i].Entry, items[j].Entry)
	})
	for i := range items {
		if credit == 0 {
			break
		}
		applied := min(credit, items[i].Unpaid)
		items[i].Unpaid -= applied
		credit -= applied
	}
	return Allocation{Items: items, Unapplied: credit}
}

func entryBefore(a, b Entry) bool {
	if c := a.Date.Compare(b.Date); c != 0 {
		return c < 0
	}
	return a.ID < b.ID
}

// UnpaidOf returns the unpaid remainder of the charge with the given id, and
// false when that charge is not part of the allocation.
func (a Allocation) UnpaidOf(id int64) (money.Cents, bool) {
	for _, it := range a.Items {
		if it.ID == id {
			return it.Unpaid, true
		}
	}
	return 0, false
}

// Balance returns what the tenant owes; negative means a credit balance.
func (a Allocation) Balance() money.Cents {
	var total money.Cents
	for _, it := range a.Items {
		total += it.Unpaid
	}
	return total - a.Unapplied
}

// OldestUnpaid returns the earliest charge with an unpaid remainder.
func (a Allocation) OldestUnpaid() (Item, bool) {
	for _, it := range a.Items {
		if it.Unpaid > 0 {
			return it, true
		}
	}
	return Item{}, false
}
