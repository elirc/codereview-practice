package ledger

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// BackdateLimitDays is how far in the past a manual entry may be dated.
const BackdateLimitDays = 60

// ManagerReversalDays is the oldest entry age, in days, that a manager may
// reverse. Admins may reverse entries of any age.
const ManagerReversalDays = 60

// Service records manual entries and reversals and reads statements.
type Service struct {
	pool  *pgxpool.Pool
	clock calendar.Clock
	loc   *time.Location
}

// NewService returns a ledger service. "Today" is the clock's date in loc.
func NewService(pool *pgxpool.Pool, clock calendar.Clock, loc *time.Location) *Service {
	return &Service{pool: pool, clock: clock, loc: loc}
}

// Today returns the current business date.
func (s *Service) Today() calendar.Date {
	return calendar.Today(s.clock, s.loc)
}

// ManualEntry is a payment, credit or other charge entered by a user.
// Amount is the positive amount typed in; Key comes from the rendered form.
type ManualEntry struct {
	LeaseID pgtype.UUID
	Kind    billing.Kind
	Amount  money.Cents
	Date    calendar.Date
	Memo    string
	Key     string
}

// Record posts a manual entry. Submitting the same key again returns the
// entry posted the first time.
func (s *Service) Record(ctx context.Context, actor auth.Actor, in ManualEntry) (db.LedgerEntry, error) {
	if !actor.Role.Can(auth.PermEdit) {
		return db.LedgerEntry{}, ErrForbidden
	}
	amount := in.Amount
	switch in.Kind {
	case billing.KindPayment, billing.KindCredit:
		amount = -in.Amount
	case billing.KindOtherCharge:
	default:
		return db.LedgerEntry{}, ErrInvalidKind
	}
	today := s.Today()
	if in.Date.After(today) || calendar.DaysBetween(in.Date, today) > BackdateLimitDays {
		return db.LedgerEntry{}, ErrEntryDateOutOfRange
	}

	var entry db.LedgerEntry
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := LockLease(ctx, q, in.LeaseID)
		if err != nil {
			return err
		}
		if !billing.Billable(l.Status) {
			return ErrLeaseNotPostable
		}
		if in.Date.Before(store.ToDate(l.StartDate)) {
			return ErrEntryBeforeLeaseStart
		}
		entry, _, err = Post(ctx, q, Posting{
			LeaseID:   in.LeaseID,
			Date:      in.Date,
			Kind:      in.Kind,
			Amount:    amount,
			Key:       in.Key,
			Memo:      in.Memo,
			CreatedBy: actor.UserID,
		})
		return err
	})
	if err != nil {
		return db.LedgerEntry{}, err
	}
	return entry, nil
}

// Reverse posts a reversal of entry id dated today.
func (s *Service) Reverse(ctx context.Context, actor auth.Actor, id int64, memo string) (db.LedgerEntry, error) {
	if !actor.Role.Can(auth.PermReverse) {
		return db.LedgerEntry{}, ErrForbidden
	}
	today := s.Today()

	var reversal db.LedgerEntry
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		target, err := q.GetLedgerEntry(ctx, id)
		if store.IsNotFound(err) {
			return ErrEntryNotFound
		}
		if err != nil {
			return fmt.Errorf("loading entry %d: %w", id, err)
		}
		if _, err := LockLease(ctx, q, target.LeaseID); err != nil {
			return err
		}

		if billing.Kind(target.Kind) == billing.KindReversal {
			return ErrReversalNotReversible
		}
		if actor.Role != auth.RoleAdmin && calendar.DaysBetween(store.ToDate(target.EntryDate), today) > ManagerReversalDays {
			return ErrReversalWindow
		}
		switch _, err := q.GetReversalOf(ctx, target.ID); {
		case err == nil:
			return ErrAlreadyReversed
		case !store.IsNotFound(err):
			return fmt.Errorf("checking reversal of entry %d: %w", target.ID, err)
		}

		e, created, err := Post(ctx, q, Posting{
			LeaseID:   target.LeaseID,
			Date:      today,
			Kind:      billing.KindReversal,
			Amount:    -money.Cents(target.AmountCents),
			Reverses:  target.ID,
			Key:       ReversalKey(target.ID),
			Memo:      memo,
			CreatedBy: actor.UserID,
		})
		if store.IsUniqueViolation(err, "ledger_entries_reverses_entry_id_key") {
			return ErrAlreadyReversed
		}
		if err != nil {
			return err
		}
		if !created {
			return ErrAlreadyReversed
		}
		reversal = e
		return nil
	})
	if err != nil {
		return db.LedgerEntry{}, err
	}
	return reversal, nil
}

// UpdateMemo replaces the memo of entry id and returns the entry.
func (s *Service) UpdateMemo(ctx context.Context, id int64, memo string) (db.LedgerEntry, error) {
	e, err := db.New(s.pool).UpdateLedgerEntryMemo(ctx, db.UpdateLedgerEntryMemoParams{ID: id, Memo: memo})
	if store.IsNotFound(err) {
		return db.LedgerEntry{}, ErrEntryNotFound
	}
	if err != nil {
		return db.LedgerEntry{}, fmt.Errorf("updating memo of entry %d: %w", id, err)
	}
	return e, nil
}

// Statement is a lease's ledger for a date range with running balances.
type Statement struct {
	Lease   db.Lease
	From    calendar.Date
	To      calendar.Date
	Opening money.Cents
	Closing money.Cents
	Lines   []StatementLine
}

// StatementLine is one entry with the balance after it.
type StatementLine struct {
	ID         int64
	Date       calendar.Date
	Kind       billing.Kind
	Amount     money.Cents
	Period     string
	ReversesID int64
	ReversedBy int64
	Memo       string
	CreatedAt  time.Time
	Balance    money.Cents
}

// Statement returns the entries of a lease dated from..to inclusive. The
// opening balance is the balance at the end of the day before from.
func (s *Service) Statement(ctx context.Context, leaseID pgtype.UUID, from, to calendar.Date) (Statement, error) {
	if to.Before(from) {
		return Statement{}, ErrInvalidRange
	}
	st := Statement{From: from, To: to}
	err := store.WithSnapshot(ctx, s.pool, func(q *db.Queries) error {
		l, err := q.GetLease(ctx, leaseID)
		if store.IsNotFound(err) {
			return ErrLeaseNotFound
		}
		if err != nil {
			return fmt.Errorf("loading lease: %w", err)
		}
		st.Lease = l

		opening, err := q.LeaseBalance(ctx, db.LeaseBalanceParams{LeaseID: leaseID, AsOf: store.Date(from.AddDays(-1))})
		if err != nil {
			return fmt.Errorf("opening balance: %w", err)
		}
		rows, err := q.ListStatementEntries(ctx, db.ListStatementEntriesParams{
			LeaseID:  leaseID,
			ToDate:   store.Date(to),
			FromDate: store.Date(from),
		})
		if err != nil {
			return fmt.Errorf("statement entries: %w", err)
		}

		st.Opening = money.Cents(opening)
		st.Closing = st.Opening
		st.Lines = make([]StatementLine, len(rows))
		for i, r := range rows {
			st.Lines[i] = StatementLine{
				ID:         r.ID,
				Date:       store.ToDate(r.EntryDate),
				Kind:       billing.Kind(r.Kind),
				Amount:     money.Cents(r.AmountCents),
				Period:     r.Period.String,
				ReversesID: r.ReversesEntryID.Int64,
				ReversedBy: r.ReversedByID.Int64,
				Memo:       r.Memo,
				CreatedAt:  r.CreatedAt.Time,
				Balance:    money.Cents(r.RunningBalance),
			}
			st.Closing = st.Lines[i].Balance
		}
		return nil
	})
	if err != nil {
		return Statement{}, err
	}
	return st, nil
}

// Balance returns the balance of a lease as of the end of asOf.
func (s *Service) Balance(ctx context.Context, leaseID pgtype.UUID, asOf calendar.Date) (money.Cents, error) {
	b, err := db.New(s.pool).LeaseBalance(ctx, db.LeaseBalanceParams{LeaseID: leaseID, AsOf: store.Date(asOf)})
	if err != nil {
		return 0, fmt.Errorf("lease balance: %w", err)
	}
	return money.Cents(b), nil
}

// CurrentBalance returns the balance of a lease over every entry posted so
// far, from the lease's summary row.
func (s *Service) CurrentBalance(ctx context.Context, leaseID pgtype.UUID) (money.Cents, error) {
	sum, err := db.New(s.pool).GetLeaseSummary(ctx, leaseID)
	if store.IsNotFound(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("lease summary: %w", err)
	}
	return money.Cents(sum.BalanceCents), nil
}
