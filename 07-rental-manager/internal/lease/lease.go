// Package lease manages the lease lifecycle: drafting, activation, edits
// and ending.
package lease

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// Errors returned by the lease service.
var (
	ErrForbidden       = apperr.Forbidden("forbidden", "You do not have permission to do that.")
	ErrNotDraft        = apperr.Conflict("lease_not_draft", "Only draft leases can be changed this way.")
	ErrNotActive       = apperr.Conflict("lease_not_active", "Only active leases can be ended.")
	ErrNotEditable     = apperr.Conflict("lease_not_editable", "Ended leases cannot be edited.")
	ErrUnitOccupied    = apperr.Conflict("unit_occupied", "The unit already has an active lease that overlaps these dates.")
	ErrTenantsRequired = apperr.Rule("tenants_required", "A lease needs at least one tenant with exactly one primary tenant.")
	ErrUnitNotFound    = apperr.Rule("unit_not_found", "The selected unit does not exist.")
	ErrTenantNotFound  = apperr.Rule("tenant_not_found", "A selected tenant does not exist.")
	ErrEndBeforeStart  = apperr.Rule("end_before_start", "The end date cannot be before the start date.")
	ErrEndInFuture     = apperr.Rule("end_date_in_future", "A lease can only be ended with an end date of today or earlier.")
	ErrEndExtends      = apperr.Rule("end_date_extends", "The end date cannot be later than the lease's current end date.")
)

// FeeSettings are the late-fee terms of a lease. BPS is used only for the
// percent kind and Flat only for the flat kind.
type FeeSettings struct {
	GraceDays int
	Kind      billing.FeeKind
	Flat      money.Cents
	BPS       int
	Cap       *money.Cents
}

// Terms are the terms of a draft lease.
type Terms struct {
	UnitID  pgtype.UUID
	Start   calendar.Date
	End     *calendar.Date
	Rent    money.Cents
	DueDay  int
	Deposit money.Cents
	Fees    FeeSettings
}

// Tenants is the set of tenants on a lease. When IDs is non-empty Primary
// is one of them.
type Tenants struct {
	IDs     []pgtype.UUID
	Primary pgtype.UUID
}

// Detail is a lease with the records it refers to.
type Detail struct {
	Lease    db.Lease
	Unit     db.Unit
	Property db.Property
	Tenants  []db.ListLeaseTenantsRow
}

// Service runs lease lifecycle operations.
type Service struct {
	pool  *pgxpool.Pool
	clock calendar.Clock
	loc   *time.Location
}

// NewService returns a lease service.
func NewService(pool *pgxpool.Pool, clock calendar.Clock, loc *time.Location) *Service {
	return &Service{pool: pool, clock: clock, loc: loc}
}

func (s *Service) today() calendar.Date {
	return calendar.Today(s.clock, s.loc)
}

// Get loads a lease with its unit, property and tenants.
func (s *Service) Get(ctx context.Context, id pgtype.UUID) (Detail, error) {
	var d Detail
	err := store.WithSnapshot(ctx, s.pool, func(q *db.Queries) error {
		l, err := q.GetLease(ctx, id)
		if store.IsNotFound(err) {
			return ledger.ErrLeaseNotFound
		}
		if err != nil {
			return fmt.Errorf("loading lease: %w", err)
		}
		unit, err := q.GetUnit(ctx, l.UnitID)
		if err != nil {
			return fmt.Errorf("loading unit: %w", err)
		}
		property, err := q.GetProperty(ctx, unit.PropertyID)
		if err != nil {
			return fmt.Errorf("loading property: %w", err)
		}
		tenants, err := q.ListLeaseTenants(ctx, id)
		if err != nil {
			return fmt.Errorf("loading tenants: %w", err)
		}
		d = Detail{Lease: l, Unit: unit, Property: property, Tenants: tenants}
		return nil
	})
	return d, err
}

// Create stores a new draft lease.
func (s *Service) Create(ctx context.Context, actor auth.Actor, t Terms, tenants Tenants) (db.Lease, error) {
	if !actor.Role.Can(auth.PermEdit) {
		return db.Lease{}, ErrForbidden
	}
	var created db.Lease
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := q.CreateLease(ctx, db.CreateLeaseParams{
			UnitID:           t.UnitID,
			StartDate:        store.Date(t.Start),
			EndDate:          store.OptionalDate(t.End),
			RentCents:        int64(t.Rent),
			DueDay:           int32(t.DueDay),
			GraceDays:        int32(t.Fees.GraceDays),
			LateFeeKind:      string(t.Fees.Kind),
			LateFeeFlatCents: int64(t.Fees.Flat),
			LateFeeBps:       int32(t.Fees.BPS),
			LateFeeCapCents:  capParam(t.Fees.Cap),
			DepositCents:     int64(t.Deposit),
		})
		if store.IsForeignKeyViolation(err, "leases_unit_id_fkey") {
			return ErrUnitNotFound
		}
		if err != nil {
			return fmt.Errorf("creating lease: %w", err)
		}
		created = l
		return replaceTenants(ctx, q, l.ID, tenants)
	})
	if err != nil {
		return db.Lease{}, err
	}
	return created, nil
}

// UpdateDraft replaces every term and the tenants of a draft lease.
func (s *Service) UpdateDraft(ctx context.Context, actor auth.Actor, id pgtype.UUID, t Terms, tenants Tenants) (db.Lease, error) {
	if !actor.Role.Can(auth.PermEdit) {
		return db.Lease{}, ErrForbidden
	}
	var updated db.Lease
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := ledger.LockLease(ctx, q, id)
		if err != nil {
			return err
		}
		if l.Status != billing.LeaseDraft {
			return ErrNotDraft
		}
		updated, err = q.UpdateDraftLease(ctx, db.UpdateDraftLeaseParams{
			ID:               id,
			UnitID:           t.UnitID,
			StartDate:        store.Date(t.Start),
			EndDate:          store.OptionalDate(t.End),
			RentCents:        int64(t.Rent),
			DueDay:           int32(t.DueDay),
			GraceDays:        int32(t.Fees.GraceDays),
			LateFeeKind:      string(t.Fees.Kind),
			LateFeeFlatCents: int64(t.Fees.Flat),
			LateFeeBps:       int32(t.Fees.BPS),
			LateFeeCapCents:  capParam(t.Fees.Cap),
			DepositCents:     int64(t.Deposit),
		})
		if store.IsForeignKeyViolation(err, "leases_unit_id_fkey") {
			return ErrUnitNotFound
		}
		if err != nil {
			return fmt.Errorf("updating lease: %w", err)
		}
		return replaceTenants(ctx, q, id, tenants)
	})
	if err != nil {
		return db.Lease{}, err
	}
	return updated, nil
}

// UpdateActive changes the late-fee settings and tenants of an active
// lease. The new settings apply only to fees assessed afterwards.
func (s *Service) UpdateActive(ctx context.Context, actor auth.Actor, id pgtype.UUID, fees FeeSettings, tenants Tenants) (db.Lease, error) {
	if !actor.Role.Can(auth.PermEdit) {
		return db.Lease{}, ErrForbidden
	}
	if len(tenants.IDs) == 0 {
		return db.Lease{}, ErrTenantsRequired
	}
	var updated db.Lease
	err := store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := ledger.LockLease(ctx, q, id)
		if err != nil {
			return err
		}
		if l.Status != billing.LeaseActive {
			return ErrNotEditable
		}
		updated, err = q.UpdateLeaseFeeTerms(ctx, db.UpdateLeaseFeeTermsParams{
			ID:               id,
			GraceDays:        int32(fees.GraceDays),
			LateFeeKind:      string(fees.Kind),
			LateFeeFlatCents: int64(fees.Flat),
			LateFeeBps:       int32(fees.BPS),
			LateFeeCapCents:  capParam(fees.Cap),
		})
		if err != nil {
			return fmt.Errorf("updating fee terms: %w", err)
		}
		return replaceTenants(ctx, q, id, tenants)
	})
	if err != nil {
		return db.Lease{}, err
	}
	return updated, nil
}

// Delete removes a draft lease.
func (s *Service) Delete(ctx context.Context, actor auth.Actor, id pgtype.UUID) error {
	if !actor.Role.Can(auth.PermEdit) {
		return ErrForbidden
	}
	return store.WithTx(ctx, s.pool, func(q *db.Queries) error {
		l, err := ledger.LockLease(ctx, q, id)
		if err != nil {
			return err
		}
		if l.Status != billing.LeaseDraft {
			return ErrNotDraft
		}
		n, err := q.DeleteDraftLease(ctx, id)
		if err != nil {
			return fmt.Errorf("deleting lease: %w", err)
		}
		if n != 1 {
			return ErrNotDraft
		}
		return nil
	})
}

func replaceTenants(ctx context.Context, q *db.Queries, leaseID pgtype.UUID, tenants Tenants) error {
	if err := q.DeleteLeaseTenants(ctx, leaseID); err != nil {
		return fmt.Errorf("clearing lease tenants: %w", err)
	}
	for _, id := range tenants.IDs {
		err := q.AddLeaseTenant(ctx, db.AddLeaseTenantParams{LeaseID: leaseID, TenantID: id, IsPrimary: id == tenants.Primary})
		if store.IsForeignKeyViolation(err, "lease_tenants_tenant_id_fkey") {
			return ErrTenantNotFound
		}
		if err != nil {
			return fmt.Errorf("adding lease tenant: %w", err)
		}
	}
	return nil
}

func capParam(c *money.Cents) pgtype.Int8 {
	if c == nil {
		return pgtype.Int8{}
	}
	return store.Int8(int64(*c))
}
