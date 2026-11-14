package lease

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// Activate makes a draft lease active, posts its deposit and catches up
// rent as of today.
func (s *Service) Activate(ctx context.Context, actor auth.Actor, id pgtype.UUID) (db.Lease, error) {
	if !actor.Role.Can(auth.PermEdit) {
		return db.Lease{}, ErrForbidden
	}
	now := s.clock.Now()
	today := calendar.FromTime(now, s.loc)

	var activated db.Lease
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := ledger.LockLease(ctx, q, id)
		if err != nil {
			return err
		}
		if l.Status != billing.LeaseDraft {
			return ErrNotDraft
		}
		tenants, err := q.ListLeaseTenants(ctx, id)
		if err != nil {
			return fmt.Errorf("loading tenants: %w", err)
		}
		primaries := 0
		for _, t := range tenants {
			if t.IsPrimary {
				primaries++
			}
		}
		if len(tenants) == 0 || primaries != 1 {
			return ErrTenantsRequired
		}

		// Postgres reports exclusion violations as 23P01.
		activated, err = q.ActivateLease(ctx, db.ActivateLeaseParams{ID: id, ActivatedAt: store.Timestamptz(now)})
		if store.IsExclusionViolation(err, "leases_unit_no_overlap") {
			return ErrUnitOccupied
		}
		if err != nil {
			return fmt.Errorf("activating lease: %w", err)
		}

		if _, err := ledger.PostDeposit(ctx, q, activated); err != nil {
			return err
		}
		if _, err := ledger.PostRent(ctx, q, activated, today); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return db.Lease{}, err
	}
	return activated, nil
}

// EndPreview shows the effect of ending a lease on a given date.
type EndPreview struct {
	EndDate calendar.Date
	Credit  billing.EndCredit
}

// PreviewEnd validates an end date and computes the suggested credit
// without changing anything.
func (s *Service) PreviewEnd(ctx context.Context, id pgtype.UUID, end calendar.Date) (EndPreview, error) {
	var preview EndPreview
	err := store.WithSnapshot(ctx, s.pool, func(q *db.Queries) error {
		l, err := q.GetLease(ctx, id)
		if store.IsNotFound(err) {
			return ledger.ErrLeaseNotFound
		}
		if err != nil {
			return fmt.Errorf("loading lease: %w", err)
		}
		if err := checkEnd(l, end, s.today()); err != nil {
			return err
		}
		credit, err := suggestedCredit(ctx, q, l, end)
		if err != nil {
			return err
		}
		preview = EndPreview{EndDate: end, Credit: credit}
		return nil
	})
	return preview, err
}

// EndRequest asks to end a lease. When PostCredit is set and a credit is
// suggested, it is posted with idempotency key Key.
type EndRequest struct {
	EndDate    calendar.Date
	PostCredit bool
	Key        string
}

// EndResult is the ended lease and the credit posted, if any.
type EndResult struct {
	Lease  db.Lease
	Credit *db.LedgerEntry
}

// End sets the end date of an active lease and marks it ended. Rent that
// was already posted is left as it is; the suggested credit is posted in
// the same transaction only when requested.
func (s *Service) End(ctx context.Context, actor auth.Actor, id pgtype.UUID, in EndRequest) (EndResult, error) {
	if !actor.Role.Can(auth.PermEdit) {
		return EndResult{}, ErrForbidden
	}
	now := s.clock.Now()
	today := calendar.FromTime(now, s.loc)

	var res EndResult
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := ledger.LockLease(ctx, q, id)
		if err != nil {
			return err
		}
		if err := checkEnd(l, in.EndDate, today); err != nil {
			return err
		}
		credit, err := suggestedCredit(ctx, q, l, in.EndDate)
		if err != nil {
			return err
		}

		res.Lease, err = q.EndLease(ctx, db.EndLeaseParams{
			ID:      id,
			EndDate: store.Date(in.EndDate),
			EndedAt: store.Timestamptz(now),
		})
		if store.IsNotFound(err) {
			return ErrNotActive
		}
		if err != nil {
			return fmt.Errorf("ending lease: %w", err)
		}

		if !in.PostCredit || credit.Total <= 0 {
			return nil
		}
		entry, _, err := ledger.Post(ctx, q, ledger.Posting{
			LeaseID:   id,
			Date:      today,
			Kind:      billing.KindCredit,
			Amount:    -credit.Total,
			Key:       in.Key,
			Memo:      fmt.Sprintf("Rent credit for lease ending %s", in.EndDate),
			CreatedBy: actor.UserID,
		})
		if err != nil {
			return err
		}
		res.Credit = &entry
		return nil
	})
	if err != nil {
		return EndResult{}, err
	}
	return res, nil
}

func checkEnd(l db.Lease, end, today calendar.Date) error {
	if l.Status != billing.LeaseActive {
		return ErrNotActive
	}
	if end.Before(store.ToDate(l.StartDate)) {
		return ErrEndBeforeStart
	}
	if end.After(today) {
		return ErrEndInFuture
	}
	if current := store.ToOptionalDate(l.EndDate); current != nil && end.After(*current) {
		return ErrEndExtends
	}
	return nil
}

func suggestedCredit(ctx context.Context, q *db.Queries, l db.Lease, end calendar.Date) (billing.EndCredit, error) {
	rows, err := q.ListLeaseEntries(ctx, l.ID)
	if err != nil {
		return billing.EndCredit{}, fmt.Errorf("listing entries: %w", err)
	}
	entries := ledger.ToEntries(rows)
	reversed := billing.ReversedIDs(entries)

	var posted []billing.PostedRent
	for _, e := range entries {
		if e.Kind != billing.KindRent || reversed[e.ID] {
			continue
		}
		p, err := calendar.ParsePeriod(e.Period)
		if err != nil {
			return billing.EndCredit{}, fmt.Errorf("rent entry %d has period %q: %w", e.ID, e.Period, err)
		}
		posted = append(posted, billing.PostedRent{Period: p, Amount: e.Amount})
	}

	terms := ledger.TermsOf(l)
	terms.End = &end
	return billing.SuggestEndCredit(terms, posted), nil
}
