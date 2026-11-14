package ledger

import (
	"context"
	"fmt"

	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// TermsOf returns the rent terms of a lease.
func TermsOf(l db.Lease) billing.Terms {
	return billing.Terms{
		Start:  store.ToDate(l.StartDate),
		End:    store.ToOptionalDate(l.EndDate),
		Rent:   money.Cents(l.RentCents),
		DueDay: int(l.DueDay),
	}
}

// FeeTermsOf returns the late-fee terms of a lease.
func FeeTermsOf(l db.Lease) billing.FeeTerms {
	terms := billing.FeeTerms{
		Kind:      billing.FeeKind(l.LateFeeKind),
		Flat:      money.Cents(l.LateFeeFlatCents),
		BPS:       int64(l.LateFeeBps),
		GraceDays: int(l.GraceDays),
	}
	if l.LateFeeCapCents.Valid {
		limit := money.Cents(l.LateFeeCapCents.Int64)
		terms.Cap = &limit
	}
	return terms
}

// PostRent posts each rent charge of l whose charge date is on or before
// asOf and whose key is not yet in the ledger, dated by the schedule rather
// than by asOf. It returns the number of entries posted. The caller holds
// the lease row lock.
func PostRent(ctx context.Context, q *db.Queries, l db.Lease, asOf calendar.Date) (int, error) {
	if !billing.Billable(l.Status) {
		return 0, nil
	}
	keys, err := q.ListLeaseKeys(ctx, l.ID)
	if err != nil {
		return 0, fmt.Errorf("listing keys for lease %s: %w", store.FormatUUID(l.ID), err)
	}
	existing := make(map[string]bool, len(keys))
	for _, k := range keys {
		existing[k] = true
	}

	posted := 0
	for _, c := range billing.DueThrough(TermsOf(l), asOf) {
		key := RentKey(l.ID, c.Period)
		if existing[key] {
			continue
		}
		_, created, err := Post(ctx, q, Posting{
			LeaseID: l.ID,
			Date:    c.Date,
			Kind:    billing.KindRent,
			Amount:  c.Amount,
			Period:  c.Period.String(),
			Key:     key,
			Memo:    rentMemo(c),
		})
		if err != nil {
			return posted, fmt.Errorf("posting rent %s for lease %s: %w", c.Period, store.FormatUUID(l.ID), err)
		}
		if created {
			posted++
		}
	}
	return posted, nil
}

func rentMemo(c billing.Charge) string {
	if c.Prorated() {
		return fmt.Sprintf("Rent %s (prorated %d of %d days)", c.Period, c.Days, c.DaysInMonth)
	}
	return fmt.Sprintf("Rent %s", c.Period)
}

// AssessLateFees posts the late fees of l that are due as of asOf. It
// returns the number of entries posted. The caller holds the lease row lock.
func AssessLateFees(ctx context.Context, q *db.Queries, l db.Lease, asOf calendar.Date) (int, error) {
	terms := FeeTermsOf(l)
	if !billing.Billable(l.Status) || terms.Kind == billing.FeeNone {
		return 0, nil
	}
	rows, err := q.ListLeaseEntries(ctx, l.ID)
	if err != nil {
		return 0, fmt.Errorf("listing entries for lease %s: %w", store.FormatUUID(l.ID), err)
	}

	posted := 0
	for _, d := range billing.LateFeesDue(terms, ToEntries(rows), asOf) {
		_, created, err := Post(ctx, q, Posting{
			LeaseID: l.ID,
			Date:    d.Date,
			Kind:    billing.KindLateFee,
			Amount:  d.Amount,
			Period:  d.Period,
			Key:     LateFeeKey(l.ID, d.Period),
			Memo:    fmt.Sprintf("Late fee for %s rent (%s unpaid after %s)", d.Period, d.Unpaid, d.Deadline),
		})
		if err != nil {
			return posted, fmt.Errorf("posting late fee %s for lease %s: %w", d.Period, store.FormatUUID(l.ID), err)
		}
		if created {
			posted++
		}
	}
	return posted, nil
}

// PostDeposit posts the deposit charge of l, dated on the lease start.
func PostDeposit(ctx context.Context, q *db.Queries, l db.Lease) (bool, error) {
	if l.DepositCents <= 0 {
		return false, nil
	}
	_, created, err := Post(ctx, q, Posting{
		LeaseID: l.ID,
		Date:    store.ToDate(l.StartDate),
		Kind:    billing.KindDepositCharge,
		Amount:  money.Cents(l.DepositCents),
		Key:     DepositKey(l.ID),
		Memo:    "Security deposit",
	})
	if err != nil {
		return false, fmt.Errorf("posting deposit for lease %s: %w", store.FormatUUID(l.ID), err)
	}
	return created, nil
}
