package jobs_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"rentalmanager/internal/auth"
	"rentalmanager/internal/billing"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/jobs"
	"rentalmanager/internal/lease"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/money"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
	"rentalmanager/internal/testdb"
)

const today = "2026-03-15"

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func runnerAt(f *testdb.Fixture, clock calendar.Clock) *jobs.Runner {
	return jobs.NewRunner(f.Pool, clock, testdb.Chicago, quiet)
}

func run(t *testing.T, r *jobs.Runner, job, asOf string) jobs.Result {
	t.Helper()
	res, err := r.Run(context.Background(), job, testdb.MustDate(t, asOf))
	if err != nil {
		t.Fatalf("%s as of %s: %v", job, asOf, err)
	}
	return res
}

type entry struct {
	kind   string
	date   string
	amount int64
}

func entriesOf(f *testdb.Fixture, l db.Lease, kind string) []entry {
	var out []entry
	for _, e := range f.Entries(l.ID) {
		if kind == "" || e.Kind == kind {
			out = append(out, entry{e.Kind, store.ToDate(e.EntryDate).String(), e.AmountCents})
		}
	}
	return out
}

func assertEntries(t *testing.T, got []entry, want ...entry) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d entries %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestPostRentCatchesUpAndRerunPostsNothing(t *testing.T) {
	f := testdb.New(t)
	r := runnerAt(f, testdb.ClockAt(t, today))
	l := f.ActiveLease(testdb.LeaseOptions{Start: "2026-01-01", Rent: 100000, DueDay: 1})
	late := f.ActiveLease(testdb.LeaseOptions{Start: "2026-01-31", Rent: 155000, DueDay: 1})

	res := run(t, r, jobs.PostRent, today)
	if res.Status != jobs.StatusOK || res.EntriesPosted != 6 || res.LeasesProcessed != 2 {
		t.Fatalf("first run = %+v", res)
	}
	assertEntries(t, entriesOf(f, l, ""),
		entry{"rent", "2026-01-01", 100000},
		entry{"rent", "2026-02-01", 100000},
		entry{"rent", "2026-03-01", 100000})
	assertEntries(t, entriesOf(f, late, ""),
		entry{"rent", "2026-01-31", 5000},
		entry{"rent", "2026-02-01", 155000},
		entry{"rent", "2026-03-01", 155000})

	again := run(t, r, jobs.PostRent, today)
	if again.Status != jobs.StatusOK || again.EntriesPosted != 0 {
		t.Errorf("second run = %+v", again)
	}
	if n := len(f.Entries(l.ID)); n != 3 {
		t.Errorf("ledger has %d entries after rerun, want 3", n)
	}
}

func TestRunProcessesEveryBillableLease(t *testing.T) {
	f := testdb.New(t)
	r := runnerAt(f, testdb.ClockAt(t, today))
	var leases []db.Lease
	for i := 0; i < 9; i++ {
		leases = append(leases, f.ActiveLease(testdb.LeaseOptions{Start: "2026-02-01"}))
	}
	draft := f.DraftLease(testdb.LeaseOptions{Start: "2026-02-01"})

	res := run(t, r, jobs.PostRent, today)
	if res.Status != jobs.StatusOK || res.LeasesProcessed != 9 || res.EntriesPosted != 18 {
		t.Fatalf("run = %+v", res)
	}
	for _, l := range leases {
		assertEntries(t, entriesOf(f, l, ""),
			entry{"rent", "2026-02-01", 100000},
			entry{"rent", "2026-03-01", 100000})
	}
	if n := len(f.Entries(draft.ID)); n != 0 {
		t.Errorf("draft lease has %d entries", n)
	}
}

func TestPostRentUsesBusinessDateNearMidnight(t *testing.T) {
	f := testdb.New(t)
	// 03:00 UTC on 1 March is still 28 February in Chicago.
	r := runnerAt(f, calendar.FixedClock{T: time.Date(2026, time.March, 1, 3, 0, 0, 0, time.UTC)})
	l := f.ActiveLease(testdb.LeaseOptions{Start: "2026-02-01"})

	if got := r.Today().String(); got != "2026-02-28" {
		t.Fatalf("Today = %s", got)
	}
	run(t, r, jobs.PostRent, r.Today().String())
	assertEntries(t, entriesOf(f, l, ""), entry{"rent", "2026-02-01", 100000})

	if _, err := r.Run(context.Background(), jobs.PostRent, testdb.MustDate(t, "2026-03-01")); !errors.Is(err, jobs.ErrAsOfInFuture) {
		t.Errorf("as-of tomorrow error = %v, want ErrAsOfInFuture", err)
	}
	if _, err := r.Run(context.Background(), "send-reminders", r.Today()); !errors.Is(err, jobs.ErrUnknownJob) {
		t.Errorf("unknown job error = %v, want ErrUnknownJob", err)
	}
}

func TestPostRentStopsAtEndMonthForEndedLeases(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	clock := testdb.ClockAt(t, today)
	r := runnerAt(f, clock)
	l := f.ActiveLease(testdb.LeaseOptions{Start: "2026-01-01", Rent: 112000, DueDay: 15})
	bounded := f.ActiveLease(testdb.LeaseOptions{Start: "2026-01-01", End: "2026-01-31", Rent: 100000})

	leases := lease.NewService(f.Pool, clock, testdb.Chicago)
	if _, err := leases.End(ctx, f.Actor(auth.RoleManager), l.ID, lease.EndRequest{EndDate: testdb.MustDate(t, "2026-02-10")}); err != nil {
		t.Fatal(err)
	}

	run(t, r, jobs.PostRent, today)
	assertEntries(t, entriesOf(f, l, ""),
		entry{"rent", "2026-01-15", 112000},
		entry{"rent", "2026-02-15", 40000})
	assertEntries(t, entriesOf(f, bounded, ""), entry{"rent", "2026-01-01", 100000})
}

func TestAssessLateFeesEndToEnd(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	clock := testdb.ClockAt(t, today)
	r := runnerAt(f, clock)
	entries := ledger.NewService(f.Pool, clock, testdb.Chicago)
	manager := f.Actor(auth.RoleManager)
	pay := func(l db.Lease, on string, amount money.Cents) db.LedgerEntry {
		t.Helper()
		key, err := store.NewUUID()
		if err != nil {
			t.Fatal(err)
		}
		e, err := entries.Record(ctx, manager, ledger.ManualEntry{
			LeaseID: l.ID, Kind: billing.KindPayment, Amount: amount, Date: testdb.MustDate(t, on), Key: store.FormatUUID(key),
		})
		if err != nil {
			t.Fatalf("payment: %v", err)
		}
		return e
	}

	flat := testdb.LeaseOptions{Start: "2026-02-01", FeeKind: billing.FeeFlat, FlatFee: 5000, GraceDays: 5}
	unpaid := f.ActiveLease(flat)
	onTime := f.ActiveLease(flat)
	dayLate := f.ActiveLease(flat)
	noFees := f.ActiveLease(testdb.LeaseOptions{Start: "2026-02-01"})
	percent := f.ActiveLease(testdb.LeaseOptions{Start: "2026-02-01", FeeKind: billing.FeePercent, FeeBPS: 500, GraceDays: 5})
	reversed := f.ActiveLease(testdb.LeaseOptions{Start: "2026-03-01", FeeKind: billing.FeeFlat, FlatFee: 5000, GraceDays: 0})

	run(t, r, jobs.PostRent, today)
	pay(onTime, "2026-02-06", 100000)
	pay(onTime, "2026-03-06", 100000)
	pay(dayLate, "2026-02-06", 100000)
	pay(dayLate, "2026-03-07", 100000)
	pay(percent, "2026-02-03", 20000)
	pay(percent, "2026-03-02", 100000)
	onTimePayment := pay(reversed, "2026-03-01", 100000)

	first := run(t, r, jobs.AssessLateFees, today)
	if first.Status != jobs.StatusOK {
		t.Fatalf("first assessment = %+v", first)
	}
	assertEntries(t, entriesOf(f, unpaid, "late_fee"),
		entry{"late_fee", "2026-02-07", 5000},
		entry{"late_fee", "2026-03-07", 5000})
	assertEntries(t, entriesOf(f, onTime, "late_fee"))
	assertEntries(t, entriesOf(f, dayLate, "late_fee"), entry{"late_fee", "2026-03-07", 5000})
	assertEntries(t, entriesOf(f, noFees, "late_fee"))
	// February: 5% of the 800.00 left unpaid. March: the payment first
	// clears February's remainder and its fee, leaving 840.00 of March unpaid.
	assertEntries(t, entriesOf(f, percent, "late_fee"),
		entry{"late_fee", "2026-02-07", 4000},
		entry{"late_fee", "2026-03-07", 4200})
	assertEntries(t, entriesOf(f, reversed, "late_fee"))

	again := run(t, r, jobs.AssessLateFees, today)
	if again.EntriesPosted != 0 {
		t.Errorf("rerun posted %d entries", again.EntriesPosted)
	}

	if _, err := entries.Reverse(ctx, manager, onTimePayment.ID, "returned payment"); err != nil {
		t.Fatal(err)
	}
	fee := entriesOf(f, unpaid, "late_fee")
	feeRows := f.Entries(unpaid.ID)
	for _, e := range feeRows {
		if e.Kind == "late_fee" {
			if _, err := entries.Reverse(ctx, manager, e.ID, "waived"); err != nil {
				t.Fatal(err)
			}
			break
		}
	}

	third := run(t, r, jobs.AssessLateFees, today)
	if third.EntriesPosted != 1 {
		t.Errorf("third run posted %d entries, want 1", third.EntriesPosted)
	}
	assertEntries(t, entriesOf(f, reversed, "late_fee"), entry{"late_fee", "2026-03-02", 5000})
	assertEntries(t, entriesOf(f, unpaid, "late_fee"), fee...)
}

func TestAssessLateFeesForEndedLeaseThroughEndMonth(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	clock := testdb.ClockAt(t, today)
	r := runnerAt(f, clock)
	l := f.ActiveLease(testdb.LeaseOptions{Start: "2026-01-01", FeeKind: billing.FeeFlat, FlatFee: 5000, GraceDays: 5})
	run(t, r, jobs.PostRent, "2026-02-01")

	leases := lease.NewService(f.Pool, clock, testdb.Chicago)
	if _, err := leases.End(ctx, f.Actor(auth.RoleManager), l.ID, lease.EndRequest{EndDate: testdb.MustDate(t, "2026-02-20")}); err != nil {
		t.Fatal(err)
	}
	run(t, r, jobs.PostRent, today)
	run(t, r, jobs.AssessLateFees, today)

	assertEntries(t, entriesOf(f, l, "late_fee"),
		entry{"late_fee", "2026-01-07", 5000},
		entry{"late_fee", "2026-02-07", 5000})
	if n := len(entriesOf(f, l, "rent")); n != 2 {
		t.Errorf("ended lease has %d rent entries, want 2", n)
	}
}

func TestRunIsSkippedWhileAnotherRunnerHoldsTheLock(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	r := runnerAt(f, testdb.ClockAt(t, today))
	l := f.ActiveLease(testdb.LeaseOptions{})

	key, ok := jobs.LockKey(jobs.PostRent)
	if !ok {
		t.Fatal("no lock key for post-rent")
	}
	holder, err := f.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	q := db.New(holder)
	if got, err := q.TryAdvisoryLock(ctx, key); err != nil || !got {
		t.Fatalf("taking the lock: %v %v", got, err)
	}

	res := run(t, r, jobs.PostRent, today)
	if !res.Skipped {
		t.Fatalf("run was not skipped: %+v", res)
	}
	if n := len(f.Entries(l.ID)); n != 0 {
		t.Fatalf("skipped run posted %d entries", n)
	}
	if runs, err := r.Recent(ctx, 10); err != nil || len(runs) != 0 {
		t.Fatalf("skipped run recorded job runs: %v %v", runs, err)
	}

	if released, err := q.AdvisoryUnlock(ctx, key); err != nil || !released {
		t.Fatalf("releasing the lock: %v %v", released, err)
	}
	if res := run(t, r, jobs.PostRent, today); res.Skipped || res.EntriesPosted != 3 {
		t.Fatalf("run after release = %+v", res)
	}
}

func TestConcurrentRunsPostEachChargeOnce(t *testing.T) {
	f := testdb.New(t)
	r := runnerAt(f, testdb.ClockAt(t, today))
	l := f.ActiveLease(testdb.LeaseOptions{})
	other := f.ActiveLease(testdb.LeaseOptions{Start: "2026-02-15"})

	asOf := testdb.MustDate(t, today)
	const workers = 4
	results := make(chan error, workers)
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		go func() {
			<-start
			_, err := r.Run(context.Background(), jobs.PostRent, asOf)
			results <- err
		}()
	}
	close(start)
	for i := 0; i < workers; i++ {
		if err := <-results; err != nil {
			t.Errorf("run failed: %v", err)
		}
	}

	if n := len(f.Entries(l.ID)); n != 3 {
		t.Errorf("lease has %d entries, want 3", n)
	}
	if n := len(f.Entries(other.ID)); n != 2 {
		t.Errorf("second lease has %d entries, want 2", n)
	}
}

func TestOneFailingLeaseDoesNotStopTheRun(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	r := runnerAt(f, testdb.ClockAt(t, today))
	broken := f.ActiveLease(testdb.LeaseOptions{})
	healthy := f.ActiveLease(testdb.LeaseOptions{})

	failOn := store.FormatUUID(broken.ID)
	setup := []string{
		fmt.Sprintf(`CREATE FUNCTION test_reject_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.lease_id = '%s' THEN
        RAISE EXCEPTION 'simulated constraint failure';
    END IF;
    RETURN NEW;
END;
$$`, failOn),
		`CREATE TRIGGER test_reject_lease BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION test_reject_lease()`,
	}
	for _, stmt := range setup {
		if _, err := f.Pool.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	dropped := false
	drop := func() {
		if dropped {
			return
		}
		dropped = true
		for _, stmt := range []string{"DROP TRIGGER test_reject_lease ON ledger_entries", "DROP FUNCTION test_reject_lease()"} {
			if _, err := f.Pool.Exec(ctx, stmt); err != nil {
				t.Errorf("cleanup %q: %v", stmt, err)
			}
		}
	}
	t.Cleanup(drop)

	res := run(t, r, jobs.PostRent, today)
	if res.Status != jobs.StatusPartial || len(res.Errors) != 1 || res.Errors[0].LeaseID != failOn {
		t.Fatalf("run = %+v", res)
	}
	if !strings.Contains(res.Errors[0].Error, "simulated constraint failure") {
		t.Errorf("recorded error = %q", res.Errors[0].Error)
	}
	if n := len(f.Entries(healthy.ID)); n != 3 {
		t.Errorf("healthy lease has %d entries, want 3", n)
	}
	if n := len(f.Entries(broken.ID)); n != 0 {
		t.Errorf("failing lease has %d entries, want 0", n)
	}

	runs, err := r.Recent(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := jobs.DecodeErrors(runs[0].Errors)
	if err != nil || runs[0].Status != jobs.StatusPartial || len(stored) != 1 || stored[0].LeaseID != failOn {
		t.Errorf("stored run = %+v errors %v (%v)", runs[0], stored, err)
	}

	drop()
	if err := r.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(f.Entries(broken.ID)); n != 3 {
		t.Errorf("after the next tick the failing lease has %d entries, want 3", n)
	}
}

func TestTickRunsEachJobOncePerDayAndClosesStaleRuns(t *testing.T) {
	f := testdb.New(t)
	ctx := context.Background()
	clock := testdb.ClockAt(t, today)
	r := runnerAt(f, clock)
	f.ActiveLease(testdb.LeaseOptions{})

	stale, err := f.Q.CreateJobRun(ctx, db.CreateJobRunParams{
		Job:       jobs.PostRent,
		AsOf:      store.Date(testdb.MustDate(t, "2026-03-14")),
		StartedAt: store.Timestamptz(clock.Now().Add(-24 * time.Hour)),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := r.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.Tick(ctx); err != nil {
		t.Fatal(err)
	}

	runs, err := r.Recent(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, run := range runs {
		if run.ID == stale.ID {
			if run.Status != jobs.StatusFailed || !run.FinishedAt.Valid {
				t.Errorf("stale run = %+v", run)
			}
			continue
		}
		if run.Status != jobs.StatusOK {
			t.Errorf("run %s status %s", run.Job, run.Status)
		}
		counts[run.Job]++
	}
	if counts[jobs.PostRent] != 1 || counts[jobs.AssessLateFees] != 1 {
		t.Errorf("runs per job = %v, want one each", counts)
	}
}
