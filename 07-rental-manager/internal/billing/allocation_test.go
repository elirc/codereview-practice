package billing

import (
	"testing"

	"rentalmanager/internal/money"
)

type ledgerBuilder struct {
	t       *testing.T
	nextID  int64
	entries []Entry
}

func newLedger(t *testing.T) *ledgerBuilder {
	return &ledgerBuilder{t: t, nextID: 1}
}

func (b *ledgerBuilder) add(kind Kind, on string, amount money.Cents, period string, reverses int64) Entry {
	b.t.Helper()
	e := Entry{ID: b.nextID, Date: date(b.t, on), Kind: kind, Amount: amount, Period: period, ReversesID: reverses}
	b.nextID++
	b.entries = append(b.entries, e)
	return e
}

func (b *ledgerBuilder) rent(on string, amount money.Cents) Entry {
	return b.add(KindRent, on, amount, on[:7], 0)
}

func (b *ledgerBuilder) lateFee(on string, amount money.Cents, period string) Entry {
	return b.add(KindLateFee, on, amount, period, 0)
}

func (b *ledgerBuilder) charge(on string, amount money.Cents) Entry {
	return b.add(KindOtherCharge, on, amount, "", 0)
}

func (b *ledgerBuilder) payment(on string, amount money.Cents) Entry {
	return b.add(KindPayment, on, -amount, "", 0)
}

func (b *ledgerBuilder) credit(on string, amount money.Cents) Entry {
	return b.add(KindCredit, on, -amount, "", 0)
}

func (b *ledgerBuilder) reverse(on string, target Entry) Entry {
	return b.add(KindReversal, on, -target.Amount, "", target.ID)
}

func unpaid(t *testing.T, a Allocation, e Entry) money.Cents {
	t.Helper()
	u, ok := a.UnpaidOf(e.ID)
	if !ok {
		t.Fatalf("entry %d is not in the allocation", e.ID)
	}
	return u
}

func TestAllocateOldestFirst(t *testing.T) {
	l := newLedger(t)
	jan := l.rent("2026-01-01", 100000)
	feb := l.rent("2026-02-01", 100000)
	l.payment("2026-01-05", 150000)

	a := Allocate(l.entries, date(t, "2026-02-28"))
	if got := unpaid(t, a, jan); got != 0 {
		t.Errorf("January unpaid = %d, want 0", got)
	}
	if got := unpaid(t, a, feb); got != 50000 {
		t.Errorf("February unpaid = %d, want 50000", got)
	}
	if a.Balance() != 50000 || a.Unapplied != 0 {
		t.Errorf("Balance = %d, Unapplied = %d", a.Balance(), a.Unapplied)
	}
	if oldest, ok := a.OldestUnpaid(); !ok || oldest.ID != feb.ID {
		t.Errorf("OldestUnpaid = %+v, %v", oldest, ok)
	}
}

func TestAllocateCarriesOverpayment(t *testing.T) {
	l := newLedger(t)
	jan := l.rent("2026-01-01", 100000)
	l.payment("2026-01-03", 130000)
	feb := l.rent("2026-02-01", 100000)

	endOfJan := Allocate(l.entries, date(t, "2026-01-31"))
	if endOfJan.Unapplied != 30000 || unpaid(t, endOfJan, jan) != 0 {
		t.Errorf("end of January: unapplied %d", endOfJan.Unapplied)
	}
	if _, ok := endOfJan.UnpaidOf(feb.ID); ok {
		t.Error("February rent is after the cutoff and must not be allocated")
	}
	if endOfJan.Balance() != -30000 {
		t.Errorf("Balance = %d, want -30000", endOfJan.Balance())
	}

	endOfFeb := Allocate(l.entries, date(t, "2026-02-28"))
	if got := unpaid(t, endOfFeb, feb); got != 70000 {
		t.Errorf("February unpaid = %d, want 70000", got)
	}
}

func TestAllocateIgnoresReversedPairs(t *testing.T) {
	l := newLedger(t)
	jan := l.rent("2026-01-01", 100000)
	pay := l.payment("2026-01-02", 100000)
	l.reverse("2026-01-20", pay)
	extra := l.charge("2026-01-03", 2500)
	l.reverse("2026-01-04", extra)

	for _, cutoff := range []string{"2026-01-02", "2026-01-10", "2026-01-31"} {
		a := Allocate(l.entries, date(t, cutoff))
		if got := unpaid(t, a, jan); got != 100000 {
			t.Errorf("cutoff %s: January unpaid = %d, want 100000", cutoff, got)
		}
		if _, ok := a.UnpaidOf(extra.ID); ok {
			t.Errorf("cutoff %s: reversed charge is still open", cutoff)
		}
		if a.Unapplied != 0 || a.Balance() != 100000 {
			t.Errorf("cutoff %s: balance %d unapplied %d", cutoff, a.Balance(), a.Unapplied)
		}
	}
}

func TestAllocateOrdersSameDayByID(t *testing.T) {
	l := newLedger(t)
	l.payment("2026-03-01", 60000)
	first := l.charge("2026-03-01", 50000)
	second := l.rent("2026-03-01", 100000)
	// Present entries out of order; allocation must sort by (date, id).
	entries := []Entry{l.entries[2], l.entries[0], l.entries[1]}

	a := Allocate(entries, date(t, "2026-03-31"))
	if a.Items[0].ID != first.ID || a.Items[1].ID != second.ID {
		t.Fatalf("items out of order: %+v", a.Items)
	}
	if unpaid(t, a, first) != 0 || unpaid(t, a, second) != 90000 {
		t.Errorf("unpaid first %d second %d", unpaid(t, a, first), unpaid(t, a, second))
	}
}

func TestAllocateHonoursCutoff(t *testing.T) {
	l := newLedger(t)
	mar := l.rent("2026-03-01", 100000)
	l.payment("2026-03-05", 40000)
	l.payment("2026-03-07", 60000)
	l.credit("2026-03-06", 10000)

	a := Allocate(l.entries, date(t, "2026-03-06"))
	if got := unpaid(t, a, mar); got != 50000 {
		t.Errorf("unpaid at cutoff = %d, want 50000", got)
	}
	all := Allocate(l.entries, date(t, "2026-03-31"))
	if got := unpaid(t, all, mar); got != 0 || all.Unapplied != 10000 {
		t.Errorf("unpaid = %d unapplied = %d", got, all.Unapplied)
	}
}

func TestAllocateWithNoCredits(t *testing.T) {
	l := newLedger(t)
	l.add(KindDepositCharge, "2026-03-01", 150000, "", 0)
	a := Allocate(l.entries, date(t, "2026-03-01"))
	if a.Balance() != 150000 || len(a.Items) != 1 || a.Items[0].Unpaid != 150000 {
		t.Errorf("allocation = %+v", a)
	}
	if empty := Allocate(nil, date(t, "2026-03-01")); empty.Balance() != 0 {
		t.Errorf("empty ledger balance = %d", empty.Balance())
	}
}
