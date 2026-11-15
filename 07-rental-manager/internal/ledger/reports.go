package ledger

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// LeaseRef identifies a lease in reports.
type LeaseRef struct {
	ID       pgtype.UUID
	Status   string
	Property string
	Unit     string
	Tenant   string
	Rent     money.Cents
}

// RentRollRow is one active lease in the rent roll.
type RentRollRow struct {
	LeaseRef
	Balance      money.Cents
	OldestUnpaid *calendar.Date
	DaysPastDue  int
}

// AgingRow is one lease's aged receivables.
type AgingRow struct {
	LeaseRef
	billing.Aging
}

// AgingReport is the aged receivables report. Totals.Total() minus Credits
// equals Balances, the sum of ledger balances.
type AgingReport struct {
	AsOf     calendar.Date
	Rows     []AgingRow
	Totals   billing.Buckets
	Credits  money.Cents
	Balances money.Cents
}

// Overview summarises receivables for the dashboard.
type Overview struct {
	AsOf         calendar.Date
	ActiveLeases int
	TotalOwed    money.Cents
	PastDue      int
}

type receivable struct {
	ref     LeaseRef
	billed  bool
	balance money.Cents
	alloc   billing.Allocation
}

// receivables reads every lease with its ledger as of asOf from a single
// snapshot. Entries dated after asOf, reversals included, are not yet
// effective, which keeps allocations consistent with balances.
func (s *Service) receivables(ctx context.Context, asOf calendar.Date) ([]receivable, error) {
	var out []receivable
	err := store.WithSnapshot(ctx, s.pool, func(q *db.Queries) error {
		leases, err := q.ListLeases(ctx)
		if err != nil {
			return fmt.Errorf("listing leases: %w", err)
		}
		rows, err := q.ListEntriesThrough(ctx, store.Date(asOf))
		if err != nil {
			return fmt.Errorf("listing entries: %w", err)
		}
		summaries, err := q.ListLeaseSummaries(ctx)
		if err != nil {
			return fmt.Errorf("listing balances: %w", err)
		}

		entries := make(map[pgtype.UUID][]billing.Entry)
		for _, r := range rows {
			entries[r.LeaseID] = append(entries[r.LeaseID], ToEntry(r))
		}
		balance := make(map[pgtype.UUID]money.Cents, len(summaries))
		for _, b := range summaries {
			balance[b.LeaseID] = money.Cents(b.BalanceCents)
		}

		out = make([]receivable, 0, len(leases))
		for _, l := range leases {
			out = append(out, receivable{
				ref: LeaseRef{
					ID:       l.ID,
					Status:   l.Status,
					Property: l.PropertyName,
					Unit:     l.UnitLabel,
					Tenant:   l.PrimaryTenantName.String,
					Rent:     money.Cents(l.RentCents),
				},
				billed:  billing.Billable(l.Status),
				balance: balance[l.ID],
				alloc:   billing.Allocate(entries[l.ID], asOf),
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RentRoll lists active leases with their balance and oldest unpaid charge
// as of asOf.
func (s *Service) RentRoll(ctx context.Context, asOf calendar.Date) ([]RentRollRow, error) {
	recs, err := s.receivables(ctx, asOf)
	if err != nil {
		return nil, err
	}
	var rows []RentRollRow
	for _, r := range recs {
		if r.ref.Status != billing.LeaseActive {
			continue
		}
		row := RentRollRow{LeaseRef: r.ref, Balance: r.balance}
		if item, ok := r.alloc.OldestUnpaid(); ok {
			oldest := item.Date
			row.OldestUnpaid = &oldest
			row.DaysPastDue = max(calendar.DaysBetween(oldest, asOf), 0)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// Aging buckets every billed lease's unpaid charges by age as of asOf.
func (s *Service) Aging(ctx context.Context, asOf calendar.Date) (AgingReport, error) {
	recs, err := s.receivables(ctx, asOf)
	if err != nil {
		return AgingReport{}, err
	}
	report := AgingReport{AsOf: asOf}
	for _, r := range recs {
		if !r.billed {
			continue
		}
		aging := billing.Age(r.alloc, asOf)
		report.Rows = append(report.Rows, AgingRow{LeaseRef: r.ref, Aging: aging})
		report.Totals.Add(aging.Buckets)
		report.Credits += aging.Credit
		report.Balances += r.balance
	}
	return report, nil
}

// Overview returns dashboard totals as of asOf.
func (s *Service) Overview(ctx context.Context, asOf calendar.Date) (Overview, error) {
	recs, err := s.receivables(ctx, asOf)
	if err != nil {
		return Overview{}, err
	}
	ov := Overview{AsOf: asOf}
	for _, r := range recs {
		if r.ref.Status == billing.LeaseActive {
			ov.ActiveLeases++
		}
		if r.balance > 0 {
			ov.TotalOwed += r.balance
		}
		if item, ok := r.alloc.OldestUnpaid(); ok && item.Date.Before(asOf) {
			ov.PastDue++
		}
	}
	return ov, nil
}
