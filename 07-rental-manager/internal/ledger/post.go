// Package ledger posts and reads lease ledger entries.
package ledger

import (
	"context"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// Errors returned by the ledger.
var (
	ErrLeaseNotFound         = apperr.NotFound("lease_not_found", "Lease not found.")
	ErrEntryNotFound         = apperr.NotFound("entry_not_found", "Ledger entry not found.")
	ErrForbidden             = apperr.Forbidden("forbidden", "You do not have permission to do that.")
	ErrLeaseNotPostable      = apperr.Conflict("lease_not_postable", "Entries can only be posted to active or ended leases.")
	ErrKeyConflict           = apperr.Conflict("idempotency_key_conflict", "This form was already submitted for a different lease.")
	ErrAlreadyReversed       = apperr.Conflict("already_reversed", "This entry has already been reversed.")
	ErrReversalNotReversible = apperr.Rule("reversal_not_reversible", "A reversal cannot itself be reversed.")
	ErrReversalWindow        = apperr.Forbidden("reversal_window_closed", "Managers can only reverse entries dated within the last 60 days.")
	ErrInvalidKind           = apperr.Rule("invalid_entry_kind", "Only payments, credits and other charges can be entered manually.")
	ErrEntryDateOutOfRange   = apperr.Rule("entry_date_out_of_range", "The entry date must be today or within the last 60 days.")
	ErrEntryBeforeLeaseStart = apperr.Rule("entry_before_lease_start", "The entry date cannot be before the lease starts.")
	ErrInvalidRange          = apperr.Rule("invalid_date_range", "The start of the range must not be after its end.")
)

// Posting is a ledger entry to be written. Amount carries the stored sign.
type Posting struct {
	LeaseID   pgtype.UUID
	Date      calendar.Date
	Kind      billing.Kind
	Amount    money.Cents
	Period    string
	Reverses  int64
	Key       string
	Memo      string
	CreatedBy pgtype.UUID
}

// Post writes p unless an entry with the same idempotency key exists, in
// which case the existing entry is returned with created == false. Callers
// hold the lease row lock for the duration of their transaction.
func Post(ctx context.Context, q *db.Queries, p Posting) (entry db.LedgerEntry, created bool, err error) {
	params := db.InsertLedgerEntryParams{
		LeaseID:        p.LeaseID,
		EntryDate:      store.Date(p.Date),
		Kind:           string(p.Kind),
		AmountCents:    int64(p.Amount),
		Period:         store.Text(p.Period),
		IdempotencyKey: p.Key,
		Memo:           p.Memo,
		CreatedBy:      p.CreatedBy,
	}
	if p.Reverses != 0 {
		params.ReversesEntryID = store.Int8(p.Reverses)
	}

	entry, err = q.InsertLedgerEntry(ctx, params)
	if err == nil {
		return entry, true, nil
	}
	if !store.IsNotFound(err) {
		return db.LedgerEntry{}, false, fmt.Errorf("inserting ledger entry %q: %w", p.Key, err)
	}

	// ON CONFLICT DO NOTHING returns no row; the entry already exists.
	existing, err := q.GetLedgerEntryByKey(ctx, p.Key)
	if err != nil {
		return db.LedgerEntry{}, false, fmt.Errorf("loading ledger entry %q: %w", p.Key, err)
	}
	if existing.LeaseID != p.LeaseID {
		return db.LedgerEntry{}, false, ErrKeyConflict
	}
	return existing, false, nil
}

// RentKey is the idempotency key of the rent charge for period p.
func RentKey(leaseID pgtype.UUID, p calendar.Period) string {
	return "rent:" + store.FormatUUID(leaseID) + ":" + p.String()
}

// LateFeeKey is the idempotency key of the late fee for period (YYYY-MM).
func LateFeeKey(leaseID pgtype.UUID, period string) string {
	return "late:" + store.FormatUUID(leaseID) + ":" + period
}

// DepositKey is the idempotency key of a lease's deposit charge.
func DepositKey(leaseID pgtype.UUID) string {
	return "deposit:" + store.FormatUUID(leaseID)
}

// ReversalKey is the idempotency key of the reversal of entry id.
func ReversalKey(id int64) string {
	return "reversal:" + strconv.FormatInt(id, 10)
}

// LockLease loads a lease and locks its row until the transaction ends.
func LockLease(ctx context.Context, q *db.Queries, id pgtype.UUID) (db.Lease, error) {
	l, err := q.GetLeaseForUpdate(ctx, id)
	if store.IsNotFound(err) {
		return db.Lease{}, ErrLeaseNotFound
	}
	if err != nil {
		return db.Lease{}, fmt.Errorf("locking lease %s: %w", store.FormatUUID(id), err)
	}
	return l, nil
}

// ToEntry converts a stored entry for the billing rules.
func ToEntry(e db.LedgerEntry) billing.Entry {
	return billing.Entry{
		ID:         e.ID,
		Date:       store.ToDate(e.EntryDate),
		Kind:       billing.Kind(e.Kind),
		Amount:     money.Cents(e.AmountCents),
		Period:     e.Period.String,
		ReversesID: e.ReversesEntryID.Int64,
	}
}

// ToEntries converts stored entries, keeping their order.
func ToEntries(rows []db.LedgerEntry) []billing.Entry {
	out := make([]billing.Entry, len(rows))
	for i, r := range rows {
		out[i] = ToEntry(r)
	}
	return out
}
