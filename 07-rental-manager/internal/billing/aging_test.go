package billing

import "testing"

func TestAgeBucketBoundaries(t *testing.T) {
	l := newLedger(t)
	l.charge("2026-04-30", 100)
	l.charge("2026-03-31", 200)
	l.charge("2026-03-30", 400)
	l.charge("2026-03-01", 800)
	l.charge("2026-01-30", 1600)
	l.charge("2026-01-29", 3200)
	asOf := date(t, "2026-04-30")

	got := Age(Allocate(l.entries, asOf), asOf)
	want := Buckets{Current: 300, From31To60: 400 + 800, From61To90: 1600, Over90: 3200}
	if got.Buckets != want {
		t.Fatalf("Buckets = %+v, want %+v", got.Buckets, want)
	}
	if got.Credit != 0 || got.Balance() != 6300 {
		t.Errorf("Credit = %d Balance = %d", got.Credit, got.Balance())
	}
}

func TestAgeAppliesPaymentsBeforeBucketing(t *testing.T) {
	l := newLedger(t)
	l.rent("2026-01-01", 100000)
	l.rent("2026-02-01", 100000)
	l.rent("2026-03-01", 100000)
	l.payment("2026-03-05", 150000)
	asOf := date(t, "2026-03-31")

	got := Age(Allocate(l.entries, asOf), asOf)
	want := Buckets{Current: 100000, From31To60: 50000}
	if got.Buckets != want {
		t.Fatalf("Buckets = %+v, want %+v", got.Buckets, want)
	}
}

func TestAgeReconcilesWithBalances(t *testing.T) {
	asOf := date(t, "2026-03-31")

	owing := newLedger(t)
	owing.rent("2026-01-01", 100000)
	owing.lateFee("2026-01-07", 5000, "2026-01")
	owing.rent("2026-03-01", 100000)
	owing.payment("2026-03-02", 60000)
	reversed := owing.payment("2026-03-03", 20000)
	owing.reverse("2026-03-10", reversed)

	credit := newLedger(t)
	credit.rent("2026-03-01", 100000)
	credit.payment("2026-03-01", 125000)

	var totals Buckets
	var credits, balances int64
	for _, l := range []*ledgerBuilder{owing, credit} {
		a := Age(Allocate(l.entries, asOf), asOf)
		totals.Add(a.Buckets)
		credits += int64(a.Credit)
		var sum int64
		for _, e := range l.entries {
			sum += int64(e.Amount)
		}
		if int64(a.Balance()) != sum {
			t.Errorf("aging balance %d does not match ledger sum %d", a.Balance(), sum)
		}
		balances += sum
	}

	if int64(totals.Total())-credits != balances {
		t.Fatalf("buckets %d minus credits %d != balances %d", totals.Total(), credits, balances)
	}
	if credits != 25000 {
		t.Errorf("credits = %d, want 25000", credits)
	}

	creditOnly := Age(Allocate(credit.entries, asOf), asOf)
	if creditOnly.Buckets != (Buckets{}) {
		t.Errorf("credit-balance lease has non-zero buckets: %+v", creditOnly.Buckets)
	}
}
