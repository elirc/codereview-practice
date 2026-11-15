package testdb

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// Fixture builds records directly through the generated queries.
type Fixture struct {
	t    testing.TB
	seq  int
	Pool *pgxpool.Pool
	Q    *db.Queries
}

// New opens the test database and returns a fixture builder for it.
func New(t testing.TB) *Fixture {
	pool := Open(t)
	return &Fixture{t: t, Pool: pool, Q: db.New(pool)}
}

func (f *Fixture) next() int {
	f.seq++
	return f.seq
}

// User creates a user with the given role and an unusable password hash.
func (f *Fixture) User(role auth.Role) db.User {
	f.t.Helper()
	n := f.next()
	u, err := f.Q.CreateUser(context.Background(), db.CreateUserParams{
		Email:        fmt.Sprintf("%s%d@example.test", role, n),
		PasswordHash: "!",
		Name:         fmt.Sprintf("Test %s %d", role, n),
		Role:         string(role),
	})
	if err != nil {
		f.t.Fatalf("creating user: %v", err)
	}
	return u
}

// Actor creates a user with role and returns it as an actor.
func (f *Fixture) Actor(role auth.Role) auth.Actor {
	f.t.Helper()
	u := f.User(role)
	return auth.Actor{UserID: u.ID, Role: role}
}

// Unit creates a property with one unit.
func (f *Fixture) Unit() db.Unit {
	f.t.Helper()
	ctx := context.Background()
	n := f.next()
	p, err := f.Q.CreateProperty(ctx, db.CreatePropertyParams{Name: fmt.Sprintf("Property %d", n), Address: "1 Main St"})
	if err != nil {
		f.t.Fatalf("creating property: %v", err)
	}
	u, err := f.Q.CreateUnit(ctx, db.CreateUnitParams{PropertyID: p.ID, Label: fmt.Sprintf("U%d", n), Bedrooms: 2, MarketRentCents: 100000})
	if err != nil {
		f.t.Fatalf("creating unit: %v", err)
	}
	return u
}

// Tenant creates a tenant.
func (f *Fixture) Tenant() db.Tenant {
	f.t.Helper()
	tn, err := f.Q.CreateTenant(context.Background(), db.CreateTenantParams{FullName: fmt.Sprintf("Tenant %d", f.next())})
	if err != nil {
		f.t.Fatalf("creating tenant: %v", err)
	}
	return tn
}

// LeaseOptions configures DraftLease and ActiveLease. Zero values select
// a new unit, a 2026-01-01 open-ended start, 1,000.00 rent due on the 1st,
// no late fee and one primary tenant.
type LeaseOptions struct {
	UnitID    pgtype.UUID
	Start     string
	End       string
	Rent      money.Cents
	DueDay    int
	GraceDays int
	FeeKind   billing.FeeKind
	FlatFee   money.Cents
	FeeBPS    int
	FeeCap    money.Cents
	Deposit   money.Cents
	NoTenant  bool
}

// DraftLease creates a draft lease.
func (f *Fixture) DraftLease(o LeaseOptions) db.Lease {
	f.t.Helper()
	ctx := context.Background()
	if !o.UnitID.Valid {
		o.UnitID = f.Unit().ID
	}
	if o.Start == "" {
		o.Start = "2026-01-01"
	}
	if o.Rent == 0 {
		o.Rent = 100000
	}
	if o.DueDay == 0 {
		o.DueDay = 1
	}
	if o.FeeKind == "" {
		o.FeeKind = billing.FeeNone
	}
	params := db.CreateLeaseParams{
		UnitID:           o.UnitID,
		StartDate:        store.Date(MustDate(f.t, o.Start)),
		RentCents:        int64(o.Rent),
		DueDay:           int32(o.DueDay),
		GraceDays:        int32(o.GraceDays),
		LateFeeKind:      string(o.FeeKind),
		LateFeeFlatCents: int64(o.FlatFee),
		LateFeeBps:       int32(o.FeeBPS),
		DepositCents:     int64(o.Deposit),
	}
	if o.End != "" {
		params.EndDate = store.Date(MustDate(f.t, o.End))
	}
	if o.FeeCap > 0 {
		params.LateFeeCapCents = store.Int8(int64(o.FeeCap))
	}
	l, err := f.Q.CreateLease(ctx, params)
	if err != nil {
		f.t.Fatalf("creating lease: %v", err)
	}
	if !o.NoTenant {
		err := f.Q.AddLeaseTenant(ctx, db.AddLeaseTenantParams{LeaseID: l.ID, TenantID: f.Tenant().ID, IsPrimary: true})
		if err != nil {
			f.t.Fatalf("adding tenant: %v", err)
		}
	}
	return l
}

// ActiveLease creates a lease and marks it active without posting anything.
func (f *Fixture) ActiveLease(o LeaseOptions) db.Lease {
	f.t.Helper()
	l := f.DraftLease(o)
	activatedAt := store.Timestamptz(time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC))
	active, err := f.Q.ActivateLease(context.Background(), db.ActivateLeaseParams{ID: l.ID, ActivatedAt: activatedAt})
	if err != nil {
		f.t.Fatalf("activating lease: %v", err)
	}
	return active
}

// Insert writes an entry directly with a random idempotency key and adds it
// to the lease's summary. Amount is signed as stored.
func (f *Fixture) Insert(leaseID pgtype.UUID, kind billing.Kind, date string, amount money.Cents, period string) db.LedgerEntry {
	f.t.Helper()
	key, err := store.NewUUID()
	if err != nil {
		f.t.Fatal(err)
	}
	e, err := f.Q.InsertLedgerEntry(context.Background(), db.InsertLedgerEntryParams{
		LeaseID:        leaseID,
		EntryDate:      store.Date(MustDate(f.t, date)),
		Kind:           string(kind),
		AmountCents:    int64(amount),
		Period:         store.Text(period),
		IdempotencyKey: "fixture:" + store.FormatUUID(key),
		Memo:           "fixture",
	})
	if err != nil {
		f.t.Fatalf("inserting %s entry: %v", kind, err)
	}
	err = f.Q.AddToLeaseSummary(context.Background(), db.AddToLeaseSummaryParams{LeaseID: leaseID, AmountCents: int64(amount)})
	if err != nil {
		f.t.Fatalf("updating lease summary: %v", err)
	}
	return e
}

// Entries returns a lease's entries ordered by (entry_date, id).
func (f *Fixture) Entries(leaseID pgtype.UUID) []db.LedgerEntry {
	f.t.Helper()
	rows, err := f.Q.ListLeaseEntries(context.Background(), leaseID)
	if err != nil {
		f.t.Fatalf("listing entries: %v", err)
	}
	return rows
}

// Lease reloads a lease.
func (f *Fixture) Lease(id pgtype.UUID) db.Lease {
	f.t.Helper()
	l, err := f.Q.GetLease(context.Background(), id)
	if err != nil {
		f.t.Fatalf("loading lease: %v", err)
	}
	return l
}
