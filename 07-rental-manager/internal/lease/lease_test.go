package lease_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/lease"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
	"rentalmanager/internal/testdb"
)

const today = "2026-03-15"

func newService(t *testing.T, f *testdb.Fixture) *lease.Service {
	return lease.NewService(f.Pool, testdb.ClockAt(t, today), testdb.Chicago)
}

func TestActivateRejectsOverlapAndAcceptsAdjacentLease(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	unit := f.Unit()
	f.ActiveLease(testdb.LeaseOptions{UnitID: unit.ID, Start: "2026-01-01", End: "2026-06-30"})

	overlapping := f.DraftLease(testdb.LeaseOptions{UnitID: unit.ID, Start: "2026-06-30"})
	if _, err := svc.Activate(ctx, manager, overlapping.ID); !errors.Is(err, lease.ErrUnitOccupied) {
		t.Fatalf("overlapping activation error = %v, want ErrUnitOccupied", err)
	}
	if got := f.Lease(overlapping.ID); got.Status != billing.LeaseDraft {
		t.Errorf("rejected lease status = %s", got.Status)
	}
	if n := len(f.Entries(overlapping.ID)); n != 0 {
		t.Errorf("rejected lease has %d entries", n)
	}

	adjacent := f.DraftLease(testdb.LeaseOptions{UnitID: unit.ID, Start: "2026-07-01"})
	if _, err := svc.Activate(ctx, manager, adjacent.ID); err != nil {
		t.Fatalf("adjacent activation: %v", err)
	}

	later := f.DraftLease(testdb.LeaseOptions{UnitID: unit.ID, Start: "2027-06-01", End: "2027-12-31"})
	if _, err := svc.Activate(ctx, manager, later.ID); !errors.Is(err, lease.ErrUnitOccupied) {
		t.Errorf("activation overlapping an open-ended lease: error = %v, want ErrUnitOccupied", err)
	}

	otherUnit := f.DraftLease(testdb.LeaseOptions{Start: "2026-02-01"})
	if _, err := svc.Activate(ctx, manager, otherUnit.ID); err != nil {
		t.Errorf("activation on another unit: %v", err)
	}
}

func TestActivateRequiresTenantsAndDraftStatus(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)

	noTenant := f.DraftLease(testdb.LeaseOptions{NoTenant: true})
	if _, err := svc.Activate(ctx, manager, noTenant.ID); !errors.Is(err, lease.ErrTenantsRequired) {
		t.Errorf("error = %v, want ErrTenantsRequired", err)
	}

	l := f.DraftLease(testdb.LeaseOptions{})
	if _, err := svc.Activate(ctx, f.Actor(auth.RoleViewer), l.ID); !errors.Is(err, lease.ErrForbidden) {
		t.Errorf("viewer error = %v, want ErrForbidden", err)
	}
	if _, err := svc.Activate(ctx, manager, l.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Activate(ctx, manager, l.ID); !errors.Is(err, lease.ErrNotDraft) {
		t.Errorf("second activation error = %v, want ErrNotDraft", err)
	}
}

func TestActivateWithPastStartCatchesUp(t *testing.T) {
	f := testdb.New(t)
	svc := newService(t, f)
	l := f.DraftLease(testdb.LeaseOptions{Start: "2025-12-10", Rent: 124000, DueDay: 1, Deposit: 150000})

	activated, err := svc.Activate(context.Background(), f.Actor(auth.RoleManager), l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activated.Status != billing.LeaseActive || !activated.ActivatedAt.Valid {
		t.Errorf("activated lease = %+v", activated)
	}

	want := []struct {
		kind   string
		date   string
		amount int64
		period string
	}{
		{"deposit_charge", "2025-12-10", 150000, ""},
		{"rent", "2025-12-10", 88000, "2025-12"},
		{"rent", "2026-01-01", 124000, "2026-01"},
		{"rent", "2026-02-01", 124000, "2026-02"},
		{"rent", "2026-03-01", 124000, "2026-03"},
	}
	got := f.Entries(l.ID)
	if len(got) != len(want) {
		t.Fatalf("got %d entries, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		e := got[i]
		if e.Kind != w.kind || store.ToDate(e.EntryDate).String() != w.date || e.AmountCents != w.amount || e.Period.String != w.period {
			t.Errorf("entry %d = %s %s %d %q, want %s %s %d %q", i,
				e.Kind, store.ToDate(e.EntryDate), e.AmountCents, e.Period.String, w.kind, w.date, w.amount, w.period)
		}
	}
}

func postRent(t *testing.T, f *testdb.Fixture, l db.Lease) {
	t.Helper()
	ctx := context.Background()
	err := store.WithTx(ctx, f.Pool, func(q *db.Queries) error {
		_, err := ledger.PostRent(ctx, q, l, testdb.MustDate(t, today))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEndLeaseSuggestsCreditAndPostsItOnlyWhenAsked(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	endDate := testdb.MustDate(t, "2026-03-10")

	l := f.ActiveLease(testdb.LeaseOptions{Rent: 310000})
	postRent(t, f, l)

	preview, err := svc.PreviewEnd(ctx, l.ID, endDate)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Credit.Total != 210000 || len(preview.Credit.Lines) != 1 || preview.Credit.Lines[0].Due != 100000 {
		t.Fatalf("preview credit = %+v", preview.Credit)
	}

	res, err := svc.End(ctx, manager, l.ID, lease.EndRequest{EndDate: endDate})
	if err != nil {
		t.Fatal(err)
	}
	if res.Lease.Status != billing.LeaseEnded || store.ToDate(res.Lease.EndDate) != endDate || res.Credit != nil {
		t.Errorf("end result = %+v", res)
	}
	if n := len(f.Entries(l.ID)); n != 3 {
		t.Errorf("ledger has %d entries after ending without credit, want 3", n)
	}

	confirmed := f.ActiveLease(testdb.LeaseOptions{Rent: 310000})
	postRent(t, f, confirmed)
	key, err := store.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	res, err = svc.End(ctx, manager, confirmed.ID, lease.EndRequest{EndDate: endDate, PostCredit: true, Key: store.FormatUUID(key)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Credit == nil || res.Credit.AmountCents != -210000 || res.Credit.Kind != "credit" || store.ToDate(res.Credit.EntryDate).String() != today {
		t.Fatalf("posted credit = %+v", res.Credit)
	}
}

func TestEndLeaseRules(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	active := f.ActiveLease(testdb.LeaseOptions{Start: "2026-02-01", End: "2026-03-12"})
	draft := f.DraftLease(testdb.LeaseOptions{})

	tests := []struct {
		name string
		id   pgtype.UUID
		end  string
		want error
	}{
		{"before the start", active.ID, "2026-01-31", lease.ErrEndBeforeStart},
		{"in the future", active.ID, "2026-03-16", lease.ErrEndInFuture},
		{"after the current end date", active.ID, "2026-03-13", lease.ErrEndExtends},
		{"draft lease", draft.ID, "2026-03-01", lease.ErrNotActive},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := svc.End(ctx, manager, tt.id, lease.EndRequest{EndDate: testdb.MustDate(t, tt.end)})
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}

	if _, err := svc.End(ctx, manager, active.ID, lease.EndRequest{EndDate: testdb.MustDate(t, "2026-02-01")}); err != nil {
		t.Fatalf("ending on the start date: %v", err)
	}
	if _, err := svc.End(ctx, manager, active.ID, lease.EndRequest{EndDate: testdb.MustDate(t, "2026-02-01")}); !errors.Is(err, lease.ErrNotActive) {
		t.Errorf("ending twice: error = %v, want ErrNotActive", err)
	}
}

func TestEditAndDeleteRules(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	tenant := f.Tenant()

	active := f.ActiveLease(testdb.LeaseOptions{})
	if err := svc.Delete(ctx, manager, active.ID); !errors.Is(err, lease.ErrNotDraft) {
		t.Errorf("deleting an active lease: error = %v, want ErrNotDraft", err)
	}
	fees := lease.FeeSettings{GraceDays: 3, Kind: billing.FeeFlat, Flat: 5000}
	if _, err := svc.UpdateActive(ctx, manager, active.ID, fees, lease.Tenants{}); !errors.Is(err, lease.ErrTenantsRequired) {
		t.Errorf("removing every tenant: error = %v, want ErrTenantsRequired", err)
	}
	updated, err := svc.UpdateActive(ctx, manager, active.ID, fees, lease.Tenants{IDs: []pgtype.UUID{tenant.ID}, Primary: tenant.ID})
	if err != nil {
		t.Fatal(err)
	}
	if updated.GraceDays != 3 || updated.LateFeeKind != "flat" || updated.RentCents != active.RentCents {
		t.Errorf("updated lease = %+v", updated)
	}

	draft := f.DraftLease(testdb.LeaseOptions{})
	if _, err := svc.UpdateActive(ctx, manager, draft.ID, fees, lease.Tenants{IDs: []pgtype.UUID{tenant.ID}, Primary: tenant.ID}); !errors.Is(err, lease.ErrNotEditable) {
		t.Errorf("active-only edit on a draft: error = %v, want ErrNotEditable", err)
	}
	if err := svc.Delete(ctx, manager, draft.ID); err != nil {
		t.Fatalf("deleting a draft: %v", err)
	}
	if _, err := f.Q.GetLease(ctx, draft.ID); !store.IsNotFound(err) {
		t.Errorf("draft still present: %v", err)
	}
}
