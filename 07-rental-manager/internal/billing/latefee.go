package billing

import (
	"sort"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
)

// FeeKind selects how a lease's late fee is computed.
type FeeKind string

// Late fee kinds.
const (
	FeeNone    FeeKind = "none"
	FeeFlat    FeeKind = "flat"
	FeePercent FeeKind = "percent"
)

// FeeTerms are the late-fee settings of a lease. Cap is nil when uncapped.
type FeeTerms struct {
	Kind      FeeKind
	Flat      money.Cents
	BPS       int64
	Cap       *money.Cents
	GraceDays int
}

// FeeOutcome is the result of evaluating one period for a late fee.
type FeeOutcome string

// Late fee outcomes.
const (
	FeeOutcomeNoTerms         FeeOutcome = "no_late_fee_terms"
	FeeOutcomeAlreadyAssessed FeeOutcome = "already_assessed"
	FeeOutcomeNoRent          FeeOutcome = "no_rent_charge"
	FeeOutcomeWithinGrace     FeeOutcome = "within_grace"
	FeeOutcomePaidOnTime      FeeOutcome = "paid_on_time"
	FeeOutcomeZeroFee         FeeOutcome = "zero_fee"
	FeeOutcomeAssess          FeeOutcome = "assess"
)

// FeeDecision describes whether and how a late fee is charged for a period.
// Amount and Date are set only when Outcome is FeeOutcomeAssess.
type FeeDecision struct {
	Outcome  FeeOutcome
	Period   string
	Deadline calendar.Date
	Unpaid   money.Cents
	Amount   money.Cents
	Date     calendar.Date
}

// Fee computes the late fee owed on an unpaid rent remainder.
func Fee(terms FeeTerms, unpaid money.Cents) money.Cents {
	var fee money.Cents
	switch terms.Kind {
	case FeeFlat:
		fee = terms.Flat
	case FeePercent:
		fee = money.BasisPoints(unpaid, terms.BPS)
	}
	if terms.Cap != nil && fee > *terms.Cap {
		fee = *terms.Cap
	}
	return fee
}

// DecideLateFee evaluates the late fee for period (YYYY-MM) as of asOf.
// entries must be the lease's complete ledger.
func DecideLateFee(terms FeeTerms, entries []Entry, period string, asOf calendar.Date) FeeDecision {
	d := FeeDecision{Period: period}
	if terms.Kind != FeeFlat && terms.Kind != FeePercent {
		d.Outcome = FeeOutcomeNoTerms
		return d
	}
	for _, e := range entries {
		if e.Kind == KindLateFee && e.Period == period {
			d.Outcome = FeeOutcomeAlreadyAssessed
			return d
		}
	}

	reversed := ReversedIDs(entries)
	var rent Entry
	found := false
	for _, e := range entries {
		if e.Kind == KindRent && e.Period == period && !reversed[e.ID] {
			rent, found = e, true
			break
		}
	}
	if !found {
		d.Outcome = FeeOutcomeNoRent
		return d
	}

	d.Deadline = rent.Date.AddDays(terms.GraceDays)
	if !asOf.After(d.Deadline) {
		d.Outcome = FeeOutcomeWithinGrace
		return d
	}

	d.Unpaid, _ = Allocate(entries, d.Deadline).UnpaidOf(rent.ID)
	if d.Unpaid <= 0 {
		d.Outcome = FeeOutcomePaidOnTime
		return d
	}

	fee := Fee(terms, d.Unpaid)
	if fee <= 0 {
		d.Outcome = FeeOutcomeZeroFee
		return d
	}
	d.Outcome = FeeOutcomeAssess
	d.Amount = fee
	d.Date = d.Deadline.AddDays(1)
	return d
}

// LateFeesDue returns the fees to post as of asOf, oldest period first.
// Each fee is added to the working ledger before later periods are
// decided, as it would be had the job run on every day, so the caller must
// post them in the returned order. Periods up to the latest one that
// already has a fee were decided by earlier runs and are not evaluated.
func LateFeesDue(terms FeeTerms, entries []Entry, asOf calendar.Date) []FeeDecision {
	working := append([]Entry(nil), entries...)
	sort.Slice(working, func(i, j int) bool { return entryBefore(working[i], working[j]) })
	nextID := int64(1)
	assessed := ""
	for _, e := range working {
		nextID = max(nextID, e.ID+1)
		if e.Kind == KindLateFee && e.Period > assessed {
			assessed = e.Period
		}
	}

	var periods []string
	seen := make(map[string]bool)
	for _, e := range working {
		if e.Kind == KindRent && e.Period > assessed && !seen[e.Period] {
			seen[e.Period] = true
			periods = append(periods, e.Period)
		}
	}

	var due []FeeDecision
	for _, p := range periods {
		d := DecideLateFee(terms, working, p, asOf)
		if d.Outcome != FeeOutcomeAssess {
			continue
		}
		due = append(due, d)
		working = append(working, Entry{ID: nextID, Date: d.Date, Kind: KindLateFee, Amount: d.Amount, Period: p})
		nextID++
	}
	return due
}
