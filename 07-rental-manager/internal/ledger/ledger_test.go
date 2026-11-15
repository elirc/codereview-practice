package ledger_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
	"rentalmanager/internal/testdb"
)

const today = "2026-03-15"

func newService(t *testing.T, f *testdb.Fixture) *ledger.Service {
	return ledger.NewService(f.Pool, testdb.ClockAt(t, today), testdb.Chicago)
}

func newKey(t *testing.T) string {
	t.Helper()
	u, err := store.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return store.FormatUUID(u)
}

func rentPosting(t *testing.T, l db.Lease, period string) ledger.Posting {
	p, err := calendar.ParsePeriod(period)
	if err != nil {
		t.Fatal(err)
	}
	return ledger.Posting{
		LeaseID: l.ID,
		Date:    p.First(),
		Kind:    billing.KindRent,
		Amount:  money.Cents(l.RentCents),
		Period:  period,
		Key:     ledger.RentKey(l.ID, p),
		Memo:    "Rent " + period,
	}
}

func balance(t *testing.T, svc *ledger.Service, l db.Lease, asOf calendar.Date) money.Cents {
	t.Helper()
	b, err := svc.Balance(context.Background(), l.ID, asOf)
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	return b
}

func TestPostWithExistingKeyReturnsExistingEntry(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	l := f.ActiveLease(testdb.LeaseOptions{})
	p := rentPosting(t, l, "2026-01")

	var ids []int64
	for i := 0; i < 2; i++ {
		err := store.WithTx(ctx, f.Pool, func(q *db.Queries) error {
			e, created, err := ledger.Post(ctx, q, p)
			if err != nil {
				return err
			}
			if created != (i == 0) {
				t.Errorf("attempt %d: created = %v", i, created)
			}
			ids = append(ids, e.ID)
			return nil
		})
		if err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if ids[0] != ids[1] {
		t.Errorf("second post returned entry %d, want %d", ids[1], ids[0])
	}
	if n := len(f.Entries(l.ID)); n != 1 {
		t.Errorf("ledger has %d entries, want 1", n)
	}
}

func TestPostIsIdempotentUnderConcurrency(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	l := f.ActiveLease(testdb.LeaseOptions{})
	p := rentPosting(t, l, "2026-02")

	const workers = 8
	type result struct {
		id      int64
		created bool
		err     error
	}
	results := make(chan result, workers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			var r result
			r.err = store.WithTx(ctx, f.Pool, func(q *db.Queries) error {
				e, created, err := ledger.Post(ctx, q, p)
				r.id, r.created = e.ID, created
				return err
			})
			results <- r
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	created := 0
	var firstID int64
	for r := range results {
		if r.err != nil {
			t.Fatalf("post failed: %v", r.err)
		}
		if firstID == 0 {
			firstID = r.id
		}
		if r.id != firstID {
			t.Errorf("got entry %d and %d for one key", firstID, r.id)
		}
		if r.created {
			created++
		}
	}
	if created != 1 {
		t.Errorf("%d posts created an entry, want 1", created)
	}
	if n := len(f.Entries(l.ID)); n != 1 {
		t.Errorf("ledger has %d entries, want 1", n)
	}
}

func TestPostRejectsKeyUsedByAnotherLease(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	a := f.ActiveLease(testdb.LeaseOptions{})
	b := f.ActiveLease(testdb.LeaseOptions{})
	key := newKey(t)

	post := func(l db.Lease) error {
		return store.WithTx(ctx, f.Pool, func(q *db.Queries) error {
			_, _, err := ledger.Post(ctx, q, ledger.Posting{
				LeaseID: l.ID, Date: testdb.MustDate(t, "2026-03-01"), Kind: billing.KindPayment, Amount: -100, Key: key,
			})
			return err
		})
	}
	if err := post(a); err != nil {
		t.Fatal(err)
	}
	if err := post(b); !errors.Is(err, ledger.ErrKeyConflict) {
		t.Fatalf("error = %v, want ErrKeyConflict", err)
	}
}

func TestRecordDoubleSubmitPostsOnce(t *testing.T) {
	f := testdb.New(t)
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	l := f.ActiveLease(testdb.LeaseOptions{})
	in := ledger.ManualEntry{
		LeaseID: l.ID,
		Kind:    billing.KindPayment,
		Amount:  50000,
		Date:    testdb.MustDate(t, "2026-03-10"),
		Memo:    "check 1001",
		Key:     newKey(t),
	}

	first, err := svc.Record(context.Background(), manager, in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Record(context.Background(), manager, in)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Errorf("double submit created entries %d and %d", first.ID, second.ID)
	}
	if first.AmountCents != -50000 || first.Kind != "payment" || !first.CreatedBy.Valid {
		t.Errorf("stored payment = %+v", first)
	}
	if n := len(f.Entries(l.ID)); n != 1 {
		t.Errorf("ledger has %d entries, want 1", n)
	}

	charge, err := svc.Record(context.Background(), manager, ledger.ManualEntry{
		LeaseID: l.ID, Kind: billing.KindOtherCharge, Amount: 2500, Date: testdb.MustDate(t, today), Key: newKey(t),
	})
	if err != nil || charge.AmountCents != 2500 {
		t.Fatalf("other charge = %+v, %v", charge, err)
	}
}

func TestRecordValidatesDateLeaseAndRole(t *testing.T) {
	f := testdb.New(t)
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	viewer := f.Actor(auth.RoleViewer)
	active := f.ActiveLease(testdb.LeaseOptions{Start: "2026-01-01"})
	lateStart := f.ActiveLease(testdb.LeaseOptions{Start: "2026-03-10"})
	draft := f.DraftLease(testdb.LeaseOptions{})
	missing, err := store.NewUUID()
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name  string
		actor auth.Actor
		entry ledger.ManualEntry
		want  error
	}{
		{"dated tomorrow", manager, ledger.ManualEntry{LeaseID: active.ID, Kind: billing.KindPayment, Amount: 100, Date: testdb.MustDate(t, "2026-03-16")}, ledger.ErrEntryDateOutOfRange},
		{"dated 61 days ago", manager, ledger.ManualEntry{LeaseID: active.ID, Kind: billing.KindPayment, Amount: 100, Date: testdb.MustDate(t, "2026-01-13")}, ledger.ErrEntryDateOutOfRange},
		{"dated 60 days ago", manager, ledger.ManualEntry{LeaseID: active.ID, Kind: billing.KindPayment, Amount: 100, Date: testdb.MustDate(t, "2026-01-14")}, nil},
		{"before the lease starts", manager, ledger.ManualEntry{LeaseID: lateStart.ID, Kind: billing.KindCredit, Amount: 100, Date: testdb.MustDate(t, "2026-03-09")}, ledger.ErrEntryBeforeLeaseStart},
		{"on the lease start", manager, ledger.ManualEntry{LeaseID: lateStart.ID, Kind: billing.KindCredit, Amount: 100, Date: testdb.MustDate(t, "2026-03-10")}, nil},
		{"draft lease", manager, ledger.ManualEntry{LeaseID: draft.ID, Kind: billing.KindPayment, Amount: 100, Date: testdb.MustDate(t, today)}, ledger.ErrLeaseNotPostable},
		{"unknown lease", manager, ledger.ManualEntry{LeaseID: missing, Kind: billing.KindPayment, Amount: 100, Date: testdb.MustDate(t, today)}, ledger.ErrLeaseNotFound},
		{"rent is not a manual kind", manager, ledger.ManualEntry{LeaseID: active.ID, Kind: billing.KindRent, Amount: 100, Date: testdb.MustDate(t, today)}, ledger.ErrInvalidKind},
		{"viewer", viewer, ledger.ManualEntry{LeaseID: active.ID, Kind: billing.KindPayment, Amount: 100, Date: testdb.MustDate(t, today)}, ledger.ErrForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.entry.Key = newKey(t)
			_, err := svc.Record(context.Background(), tt.actor, tt.entry)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestReverseRestoresBalanceAndIsRefusedTwice(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	l := f.ActiveLease(testdb.LeaseOptions{})
	f.Insert(l.ID, billing.KindRent, "2026-03-01", 100000, "2026-03")
	pay, err := svc.Record(ctx, manager, ledger.ManualEntry{
		LeaseID: l.ID, Kind: billing.KindPayment, Amount: 100000, Date: testdb.MustDate(t, "2026-03-02"), Key: newKey(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	asOf := testdb.MustDate(t, today)
	if b := balance(t, svc, l, asOf); b != 0 {
		t.Fatalf("balance before reversal = %d", b)
	}

	rev, err := svc.Reverse(ctx, manager, pay.ID, "bounced check")
	if err != nil {
		t.Fatal(err)
	}
	if rev.Kind != "reversal" || rev.AmountCents != 100000 || rev.ReversesEntryID.Int64 != pay.ID || store.ToDate(rev.EntryDate) != asOf {
		t.Errorf("reversal = %+v", rev)
	}
	if b := balance(t, svc, l, asOf); b != 100000 {
		t.Errorf("balance after reversal = %d, want 100000", b)
	}

	if _, err := svc.Reverse(ctx, manager, pay.ID, "again"); !errors.Is(err, ledger.ErrAlreadyReversed) {
		t.Errorf("second reversal error = %v, want ErrAlreadyReversed", err)
	}
	if _, err := svc.Reverse(ctx, manager, rev.ID, "undo"); !errors.Is(err, ledger.ErrReversalNotReversible) {
		t.Errorf("reversing a reversal error = %v, want ErrReversalNotReversible", err)
	}
	if _, err := svc.Reverse(ctx, manager, 999999, "missing"); !errors.Is(err, ledger.ErrEntryNotFound) {
		t.Errorf("missing entry error = %v, want ErrEntryNotFound", err)
	}
}

func TestReverseWindowAppliesToManagersOnly(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	admin := f.Actor(auth.RoleAdmin)
	viewer := f.Actor(auth.RoleViewer)
	l := f.ActiveLease(testdb.LeaseOptions{})
	old := f.Insert(l.ID, billing.KindOtherCharge, "2026-01-13", 2500, "")
	recent := f.Insert(l.ID, billing.KindOtherCharge, "2026-01-14", 2500, "")

	if _, err := svc.Reverse(ctx, viewer, recent.ID, "x"); !errors.Is(err, ledger.ErrForbidden) {
		t.Errorf("viewer error = %v, want ErrForbidden", err)
	}
	if _, err := svc.Reverse(ctx, manager, old.ID, "x"); !errors.Is(err, ledger.ErrReversalWindow) {
		t.Errorf("manager on a 61-day-old entry: error = %v, want ErrReversalWindow", err)
	}
	if _, err := svc.Reverse(ctx, manager, recent.ID, "x"); err != nil {
		t.Errorf("manager on a 60-day-old entry: %v", err)
	}
	if _, err := svc.Reverse(ctx, admin, old.ID, "x"); err != nil {
		t.Errorf("admin on a 61-day-old entry: %v", err)
	}
}

func TestConcurrentReversalsPostOnce(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	l := f.ActiveLease(testdb.LeaseOptions{})
	target := f.Insert(l.ID, billing.KindPayment, "2026-03-02", -100000, "")

	const workers = 5
	errs := make(chan error, workers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := svc.Reverse(ctx, manager, target.ID, "double click")
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	succeeded := 0
	for err := range errs {
		switch {
		case err == nil:
			succeeded++
		case !errors.Is(err, ledger.ErrAlreadyReversed):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if succeeded != 1 {
		t.Errorf("%d reversals succeeded, want 1", succeeded)
	}
	reversals := 0
	for _, e := range f.Entries(l.ID) {
		if e.Kind == "reversal" {
			reversals++
		}
	}
	if reversals != 1 {
		t.Errorf("ledger has %d reversals, want 1", reversals)
	}
}

func TestLedgerRejectsUpdateAndDelete(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	l := f.ActiveLease(testdb.LeaseOptions{})
	e := f.Insert(l.ID, billing.KindRent, "2026-01-01", 100000, "2026-01")

	if _, err := f.Pool.Exec(ctx, "UPDATE ledger_entries SET amount_cents = 1 WHERE id = $1", e.ID); err == nil {
		t.Error("UPDATE succeeded")
	}
	if _, err := f.Pool.Exec(ctx, "DELETE FROM ledger_entries WHERE id = $1", e.ID); err == nil {
		t.Error("DELETE succeeded")
	}
	got, err := f.Q.GetLedgerEntry(ctx, e.ID)
	if err != nil || got.AmountCents != 100000 {
		t.Errorf("entry after attempts = %+v, %v", got, err)
	}
}

func TestDatabaseRejectsInvalidReversals(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	l := f.ActiveLease(testdb.LeaseOptions{})
	pay := f.Insert(l.ID, billing.KindPayment, "2026-03-02", -5000, "")

	insert := func(key string, amount int64, reverses int64) error {
		_, err := f.Q.InsertLedgerEntry(ctx, db.InsertLedgerEntryParams{
			LeaseID:         l.ID,
			EntryDate:       store.Date(testdb.MustDate(t, today)),
			Kind:            "reversal",
			AmountCents:     amount,
			ReversesEntryID: store.Int8(reverses),
			IdempotencyKey:  key,
		})
		return err
	}
	if err := insert("bad-sign", -5000, pay.ID); err == nil {
		t.Error("reversal with the target's sign was accepted")
	}
	if err := insert("first", 5000, pay.ID); err != nil {
		t.Fatalf("valid reversal: %v", err)
	}
	err := insert("second", 5000, pay.ID)
	if !store.IsUniqueViolation(err, "ledger_entries_reverses_entry_id_key") {
		t.Errorf("second reversal error = %v, want unique violation", err)
	}
	first, err := f.Q.GetLedgerEntryByKey(ctx, "first")
	if err != nil {
		t.Fatal(err)
	}
	if err := insert("of-reversal", -5000, first.ID); err == nil {
		t.Error("reversal of a reversal was accepted")
	}
}

func TestCurrentBalanceFollowsPostings(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	manager := f.Actor(auth.RoleManager)
	l := f.ActiveLease(testdb.LeaseOptions{})

	err := store.WithTx(ctx, f.Pool, func(q *db.Queries) error {
		_, err := ledger.PostRent(ctx, q, l, testdb.MustDate(t, today))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	pay, err := svc.Record(ctx, manager, ledger.ManualEntry{
		LeaseID: l.ID, Kind: billing.KindPayment, Amount: 120000, Date: testdb.MustDate(t, "2026-03-05"), Key: newKey(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := svc.CurrentBalance(ctx, l.ID); err != nil || got != 180000 {
		t.Fatalf("balance after payment = %d, %v", got, err)
	}

	if _, err := svc.Reverse(ctx, manager, pay.ID, "returned"); err != nil {
		t.Fatal(err)
	}
	got, err := svc.CurrentBalance(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := balance(t, svc, l, testdb.MustDate(t, today)); got != want || got != 300000 {
		t.Errorf("current balance = %d, ledger balance = %d, want 300000", got, want)
	}

	empty := f.ActiveLease(testdb.LeaseOptions{})
	if got, err := svc.CurrentBalance(ctx, empty.ID); err != nil || got != 0 {
		t.Errorf("lease without entries: %d, %v", got, err)
	}
}

func TestStatementRunningAndOpeningBalances(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)
	l := f.ActiveLease(testdb.LeaseOptions{})

	// Inserted out of date order so that ids and dates disagree.
	f.Insert(l.ID, billing.KindRent, "2026-03-01", 100000, "2026-03")
	f.Insert(l.ID, billing.KindRent, "2026-01-01", 100000, "2026-01")
	f.Insert(l.ID, billing.KindPayment, "2026-01-05", -60000, "")
	f.Insert(l.ID, billing.KindRent, "2026-02-01", 100000, "2026-02")
	f.Insert(l.ID, billing.KindOtherCharge, "2026-02-01", 2500, "")
	f.Insert(l.ID, billing.KindPayment, "2026-02-03", -100000, "")

	full, err := svc.Statement(ctx, l.ID, testdb.MustDate(t, "2026-01-01"), testdb.MustDate(t, "2026-03-31"))
	if err != nil {
		t.Fatal(err)
	}
	wantRunning := []money.Cents{100000, 40000, 140000, 142500, 42500, 142500}
	if len(full.Lines) != len(wantRunning) {
		t.Fatalf("got %d lines, want %d", len(full.Lines), len(wantRunning))
	}
	for i, want := range wantRunning {
		if full.Lines[i].Balance != want {
			t.Errorf("line %d (%s %s) balance = %d, want %d", i, full.Lines[i].Date, full.Lines[i].Kind, full.Lines[i].Balance, want)
		}
	}
	if full.Lines[2].Kind != billing.KindRent || full.Lines[3].Kind != billing.KindOtherCharge {
		t.Errorf("same-day entries not ordered by id: %s then %s", full.Lines[2].Kind, full.Lines[3].Kind)
	}
	if full.Opening != 0 || full.Closing != 142500 {
		t.Errorf("full range opening %d closing %d", full.Opening, full.Closing)
	}

	feb, err := svc.Statement(ctx, l.ID, testdb.MustDate(t, "2026-02-01"), testdb.MustDate(t, "2026-02-28"))
	if err != nil {
		t.Fatal(err)
	}
	if feb.Opening != 40000 || feb.Closing != 42500 || len(feb.Lines) != 3 || feb.Lines[0].Balance != 140000 {
		t.Errorf("February statement = opening %d closing %d lines %d", feb.Opening, feb.Closing, len(feb.Lines))
	}

	mar, err := svc.Statement(ctx, l.ID, testdb.MustDate(t, "2026-03-01"), testdb.MustDate(t, "2026-03-31"))
	if err != nil {
		t.Fatal(err)
	}
	if mar.Opening != feb.Closing || mar.Closing != 142500 {
		t.Errorf("March opening %d does not continue February closing %d", mar.Opening, feb.Closing)
	}

	quiet, err := svc.Statement(ctx, l.ID, testdb.MustDate(t, "2026-03-02"), testdb.MustDate(t, "2026-03-10"))
	if err != nil {
		t.Fatal(err)
	}
	if len(quiet.Lines) != 0 || quiet.Opening != 142500 || quiet.Closing != 142500 {
		t.Errorf("range without entries = %+v", quiet)
	}

	if _, err := svc.Statement(ctx, l.ID, testdb.MustDate(t, "2026-03-10"), testdb.MustDate(t, "2026-03-01")); !errors.Is(err, ledger.ErrInvalidRange) {
		t.Errorf("reversed range error = %v", err)
	}
}

func TestReportsReconcileWithBalances(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	svc := newService(t, f)

	owing := f.ActiveLease(testdb.LeaseOptions{})
	f.Insert(owing.ID, billing.KindRent, "2026-01-01", 100000, "2026-01")
	f.Insert(owing.ID, billing.KindRent, "2026-02-01", 100000, "2026-02")
	f.Insert(owing.ID, billing.KindPayment, "2026-02-02", -150000, "")
	f.Insert(owing.ID, billing.KindRent, "2026-03-01", 100000, "2026-03")

	ahead := f.ActiveLease(testdb.LeaseOptions{})
	f.Insert(ahead.ID, billing.KindRent, "2026-03-01", 100000, "2026-03")
	f.Insert(ahead.ID, billing.KindPayment, "2026-03-01", -130000, "")

	asOf := testdb.MustDate(t, today)
	report, err := svc.Aging(ctx, asOf)
	if err != nil {
		t.Fatal(err)
	}
	if report.Balances != 150000-30000 || report.Totals.Total()-report.Credits != report.Balances {
		t.Errorf("aging totals %+v credits %d balances %d", report.Totals, report.Credits, report.Balances)
	}
	if report.Totals.From31To60 != 50000 || report.Totals.Current != 100000 || report.Credits != 30000 {
		t.Errorf("aging buckets = %+v credits %d", report.Totals, report.Credits)
	}

	roll, err := svc.RentRoll(ctx, asOf)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range roll {
		switch r.ID {
		case owing.ID:
			if r.Balance != 150000 || r.OldestUnpaid == nil || r.OldestUnpaid.String() != "2026-02-01" || r.DaysPastDue != 42 {
				t.Errorf("owing lease row = %+v", r)
			}
		case ahead.ID:
			if r.Balance != -30000 || r.OldestUnpaid != nil || r.DaysPastDue != 0 {
				t.Errorf("credit lease row = %+v", r)
			}
		}
	}
}
