package billing

import (
	"testing"

	"rentalmanager/internal/money"
)

func flat(amount money.Cents, grace int) FeeTerms {
	return FeeTerms{Kind: FeeFlat, Flat: amount, GraceDays: grace}
}

func percent(bps int64, grace int) FeeTerms {
	return FeeTerms{Kind: FeePercent, BPS: bps, GraceDays: grace}
}

func capped(terms FeeTerms, limit money.Cents) FeeTerms {
	terms.Cap = &limit
	return terms
}

func TestFee(t *testing.T) {
	tests := []struct {
		name   string
		terms  FeeTerms
		unpaid money.Cents
		want   money.Cents
	}{
		{"flat ignores the unpaid amount", flat(5000, 5), 100, 5000},
		{"percent of the unpaid amount", percent(500, 5), 60000, 3000},
		{"percent rounds half up", percent(500, 5), 10, 1},
		{"cap limits a percent fee", capped(percent(2500, 5), 10000), 100000, 10000},
		{"cap above the fee has no effect", capped(percent(500, 5), 10000), 100000, 5000},
		{"cap limits a flat fee", capped(flat(7500, 5), 5000), 100, 5000},
		{"percent rounding to zero", percent(1, 5), 4999, 0},
	}
	for _, tt := range tests {
		if got := Fee(tt.terms, tt.unpaid); got != tt.want {
			t.Errorf("%s: Fee = %d, want %d", tt.name, got, tt.want)
		}
	}
}

func TestDecideLateFee(t *testing.T) {
	type scenario func(l *ledgerBuilder)
	marchRent := func(l *ledgerBuilder) { l.rent("2026-03-01", 100000) }

	tests := []struct {
		name        string
		terms       FeeTerms
		ledger      scenario
		asOf        string
		outcome     FeeOutcome
		unpaid      money.Cents
		amount      money.Cents
		postingDate string
	}{
		{
			name: "no late fee terms", terms: FeeTerms{Kind: FeeNone, GraceDays: 5},
			ledger: marchRent, asOf: "2026-03-20", outcome: FeeOutcomeNoTerms,
		},
		{
			name: "still within grace on the deadline", terms: flat(5000, 5),
			ledger: marchRent, asOf: "2026-03-06", outcome: FeeOutcomeWithinGrace,
		},
		{
			name: "assessable the day after the deadline", terms: flat(5000, 5),
			ledger: marchRent, asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 100000, amount: 5000, postingDate: "2026-03-07",
		},
		{
			name: "grace zero is assessable the day after the due date", terms: flat(5000, 0),
			ledger: marchRent, asOf: "2026-03-02", outcome: FeeOutcomeAssess,
			unpaid: 100000, amount: 5000, postingDate: "2026-03-02",
		},
		{
			name: "grace zero on the due date", terms: flat(5000, 0),
			ledger: marchRent, asOf: "2026-03-01", outcome: FeeOutcomeWithinGrace,
		},
		{
			name: "payment dated on the deadline is on time", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				l.payment("2026-03-06", 100000)
			},
			asOf: "2026-03-10", outcome: FeeOutcomePaidOnTime,
		},
		{
			name: "payment dated the day after the deadline is late", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				l.payment("2026-03-07", 100000)
			},
			asOf: "2026-03-10", outcome: FeeOutcomeAssess,
			unpaid: 100000, amount: 5000, postingDate: "2026-03-07",
		},
		{
			name: "partial payment: percent fee on the remainder", terms: percent(500, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				l.payment("2026-03-03", 40000)
			},
			asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 60000, amount: 3000, postingDate: "2026-03-07",
		},
		{
			name: "partial payment: flat fee in full", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				l.payment("2026-03-03", 40000)
			},
			asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 60000, amount: 5000, postingDate: "2026-03-07",
		},
		{
			name: "overpayment of the previous month reduces the basis", terms: percent(500, 5),
			ledger: func(l *ledgerBuilder) {
				l.rent("2026-02-01", 100000)
				l.payment("2026-02-02", 130000)
				marchRent(l)
			},
			asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 70000, amount: 3500, postingDate: "2026-03-07",
		},
		{
			name: "older other charge absorbs the payment first", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				l.charge("2026-02-10", 50000)
				marchRent(l)
				l.payment("2026-03-03", 100000)
			},
			asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 50000, amount: 5000, postingDate: "2026-03-07",
		},
		{
			name: "earlier unpaid late fee is not part of the basis", terms: percent(500, 5),
			ledger: func(l *ledgerBuilder) {
				l.rent("2026-02-01", 100000)
				l.lateFee("2026-02-07", 5000, "2026-02")
				marchRent(l)
				l.payment("2026-03-02", 200000)
			},
			asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 5000, amount: 250, postingDate: "2026-03-07",
		},
		{
			name: "cap limits the fee", terms: capped(percent(2500, 5), 10000),
			ledger: marchRent, asOf: "2026-03-07", outcome: FeeOutcomeAssess,
			unpaid: 100000, amount: 10000, postingDate: "2026-03-07",
		},
		{
			name: "fee rounding to zero is not posted", terms: percent(1, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				l.payment("2026-03-02", 95001)
			},
			asOf: "2026-03-07", outcome: FeeOutcomeZeroFee, unpaid: 4999,
		},
		{
			name: "late run dates the fee the day after the deadline", terms: flat(5000, 5),
			ledger: marchRent, asOf: "2026-03-16", outcome: FeeOutcomeAssess,
			unpaid: 100000, amount: 5000, postingDate: "2026-03-07",
		},
		{
			name: "existing late fee is never reassessed", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				l.lateFee("2026-03-07", 5000, "2026-03")
				l.payment("2026-03-04", 100000)
			},
			asOf: "2026-03-20", outcome: FeeOutcomeAlreadyAssessed,
		},
		{
			name: "reversed late fee still counts as assessed", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				fee := l.lateFee("2026-03-07", 5000, "2026-03")
				l.reverse("2026-03-09", fee)
			},
			asOf: "2026-03-20", outcome: FeeOutcomeAlreadyAssessed,
		},
		{
			name: "reversing an on-time payment makes the period assessable", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				marchRent(l)
				pay := l.payment("2026-03-02", 100000)
				l.reverse("2026-03-12", pay)
			},
			asOf: "2026-03-12", outcome: FeeOutcomeAssess,
			unpaid: 100000, amount: 5000, postingDate: "2026-03-07",
		},
		{
			name: "reversed rent has no fee", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) {
				rent := l.rent("2026-03-01", 100000)
				l.reverse("2026-03-02", rent)
			},
			asOf: "2026-03-20", outcome: FeeOutcomeNoRent,
		},
		{
			name: "period without rent", terms: flat(5000, 5),
			ledger: func(l *ledgerBuilder) { l.charge("2026-03-01", 100000) },
			asOf:   "2026-03-20", outcome: FeeOutcomeNoRent,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := newLedger(t)
			tt.ledger(l)
			d := DecideLateFee(tt.terms, l.entries, "2026-03", date(t, tt.asOf))
			if d.Outcome != tt.outcome {
				t.Fatalf("Outcome = %s, want %s (%+v)", d.Outcome, tt.outcome, d)
			}
			if d.Unpaid != tt.unpaid || d.Amount != tt.amount {
				t.Errorf("Unpaid = %d Amount = %d, want %d and %d", d.Unpaid, d.Amount, tt.unpaid, tt.amount)
			}
			if tt.postingDate != "" && d.Date.String() != tt.postingDate {
				t.Errorf("Date = %s, want %s", d.Date, tt.postingDate)
			}
		})
	}
}

func TestLateFeesDueMatchesDailyRunsWhenCatchingUp(t *testing.T) {
	l := newLedger(t)
	l.rent("2026-02-01", 100000)
	l.payment("2026-02-03", 20000)
	l.rent("2026-03-01", 100000)
	l.payment("2026-03-02", 100000)

	due := LateFeesDue(percent(500, 5), l.entries, date(t, "2026-03-15"))
	if len(due) != 2 {
		t.Fatalf("got %d fees, want 2: %+v", len(due), due)
	}
	if due[0].Period != "2026-02" || due[0].Unpaid != 80000 || due[0].Amount != 4000 {
		t.Errorf("February fee = %+v", due[0])
	}
	// The February fee, dated 2026-02-07, absorbs part of the payments
	// before March's rent, exactly as if it had been posted on that day.
	if due[1].Period != "2026-03" || due[1].Unpaid != 84000 || due[1].Amount != 4200 {
		t.Errorf("March fee = %+v", due[1])
	}
}

func TestLateFeesDueEvaluatesOnlyRentPeriods(t *testing.T) {
	l := newLedger(t)
	l.rent("2026-02-01", 100000)
	l.payment("2026-02-03", 100000)
	l.lateFee("2026-02-07", 5000, "2026-02")
	l.charge("2026-02-15", 30000)
	l.rent("2026-03-01", 100000)

	due := LateFeesDue(flat(5000, 5), l.entries, date(t, "2026-03-31"))
	if len(due) != 1 {
		t.Fatalf("got %d fees, want 1: %+v", len(due), due)
	}
	if due[0].Period != "2026-03" || due[0].Unpaid != 100000 {
		t.Errorf("fee = %+v", due[0])
	}
}

func TestLateFeesDueContinuesAfterAssessedPeriods(t *testing.T) {
	l := newLedger(t)
	l.rent("2026-01-01", 100000)
	l.lateFee("2026-01-07", 5000, "2026-01")
	l.rent("2026-02-01", 100000)
	l.lateFee("2026-02-07", 5000, "2026-02")
	l.rent("2026-03-01", 100000)
	l.rent("2026-04-01", 100000)

	due := LateFeesDue(flat(5000, 5), l.entries, date(t, "2026-04-20"))
	if len(due) != 2 {
		t.Fatalf("got %d fees, want 2: %+v", len(due), due)
	}
	if due[0].Period != "2026-03" || due[0].Date.String() != "2026-03-07" {
		t.Errorf("March fee = %+v", due[0])
	}
	if due[1].Period != "2026-04" || due[1].Date.String() != "2026-04-07" {
		t.Errorf("April fee = %+v", due[1])
	}
}
