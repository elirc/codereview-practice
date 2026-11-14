// Package jobs runs the billing jobs (rent posting and late-fee
// assessment) one lease per transaction, with a single runner per job
// across all processes.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"rentalmanager/internal/apperr"
	"rentalmanager/internal/calendar"
	"rentalmanager/internal/ledger"
	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

// Job names.
const (
	PostRent       = "post-rent"
	AssessLateFees = "assess-late-fees"
)

// Names lists the jobs in the order the worker runs them.
var Names = []string{PostRent, AssessLateFees}

// Run statuses.
const (
	StatusRunning = "running"
	StatusOK      = "ok"
	StatusPartial = "partial"
	StatusFailed  = "failed"
)

// Errors returned by Run.
var (
	ErrUnknownJob   = apperr.NotFound("job_not_found", "There is no job with that name.")
	ErrAsOfInFuture = apperr.Rule("as_of_in_future", "The as-of date cannot be later than today.")
)

// leaseTimeout bounds the work on one lease, which continues after the run
// is cancelled so that the lease's transaction completes.
const leaseTimeout = 30 * time.Second

type definition struct {
	lockKey int64
	process func(ctx context.Context, q *db.Queries, l db.Lease, asOf calendar.Date) (int, error)
}

var definitions = map[string]definition{
	PostRent:       {lockKey: 7_001_001, process: ledger.PostRent},
	AssessLateFees: {lockKey: 7_001_002, process: ledger.AssessLateFees},
}

// LockKey returns the advisory lock key that guards job.
func LockKey(job string) (int64, bool) {
	def, ok := definitions[job]
	return def.lockKey, ok
}

// LeaseError records a failure while processing one lease.
type LeaseError struct {
	LeaseID string `json:"lease_id"`
	Error   string `json:"error"`
}

// DecodeErrors parses the errors column of a job run.
func DecodeErrors(raw []byte) ([]LeaseError, error) {
	var errs []LeaseError
	if err := json.Unmarshal(raw, &errs); err != nil {
		return nil, fmt.Errorf("decoding job run errors: %w", err)
	}
	return errs, nil
}

// Result summarises one run. Skipped means another runner held the lock.
type Result struct {
	RunID           pgtype.UUID
	Job             string
	AsOf            calendar.Date
	Skipped         bool
	Status          string
	LeasesProcessed int
	EntriesPosted   int
	Errors          []LeaseError
}

// Runner executes jobs.
type Runner struct {
	pool  *pgxpool.Pool
	clock calendar.Clock
	loc   *time.Location
	log   *slog.Logger
}

// NewRunner returns a runner; "today" is the clock's date in loc.
func NewRunner(pool *pgxpool.Pool, clock calendar.Clock, loc *time.Location, log *slog.Logger) *Runner {
	return &Runner{pool: pool, clock: clock, loc: loc, log: log}
}

// Today returns the current business date.
func (r *Runner) Today() calendar.Date {
	return calendar.Today(r.clock, r.loc)
}

// Recent returns the latest job runs, newest first.
func (r *Runner) Recent(ctx context.Context, limit int32) ([]db.JobRun, error) {
	runs, err := db.New(r.pool).ListJobRuns(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("listing job runs: %w", err)
	}
	return runs, nil
}

// Run executes job as of asOf. If another process is running the same job
// the run is skipped and Result.Skipped is set.
func (r *Runner) Run(ctx context.Context, job string, asOf calendar.Date) (Result, error) {
	def, ok := definitions[job]
	if !ok {
		return Result{}, ErrUnknownJob
	}
	if asOf.After(r.Today()) {
		return Result{}, ErrAsOfInFuture
	}

	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("acquiring lock connection: %w", err)
	}
	defer conn.Release()

	lockQ := db.New(conn)
	acquired, err := lockQ.TryAdvisoryLock(ctx, def.lockKey)
	if err != nil {
		return Result{}, fmt.Errorf("taking %s lock: %w", job, err)
	}
	if !acquired {
		r.log.Info("job skipped, another run holds the lock", "job", job, "as_of", asOf.String())
		return Result{Job: job, AsOf: asOf, Skipped: true}, nil
	}
	defer func() {
		unlockCtx := context.WithoutCancel(ctx)
		released, err := lockQ.AdvisoryUnlock(unlockCtx, def.lockKey)
		if err == nil && released {
			return
		}
		// The lock is held by the session, so close the connection.
		r.log.Error("releasing job lock", "job", job, "released", released, "error", err)
		if cerr := conn.Conn().Close(unlockCtx); cerr != nil {
			r.log.Error("closing lock connection", "job", job, "error", cerr)
		}
	}()

	return r.execute(ctx, job, def, asOf)
}

func (r *Runner) execute(ctx context.Context, job string, def definition, asOf calendar.Date) (Result, error) {
	q := db.New(r.pool)
	started := r.clock.Now()

	stale, err := q.FailStaleJobRuns(ctx, db.FailStaleJobRunsParams{FinishedAt: store.Timestamptz(started), Job: job})
	if err != nil {
		return Result{}, fmt.Errorf("closing stale %s runs: %w", job, err)
	}
	if stale > 0 {
		r.log.Warn("marked stale job runs failed", "job", job, "count", stale)
	}
	previous, err := q.CountJobRuns(ctx, db.CountJobRunsParams{Job: job, AsOf: store.Date(asOf)})
	if err != nil {
		return Result{}, fmt.Errorf("counting %s runs: %w", job, err)
	}
	run, err := q.CreateJobRun(ctx, db.CreateJobRunParams{Job: job, AsOf: store.Date(asOf), StartedAt: store.Timestamptz(started)})
	if err != nil {
		return Result{}, fmt.Errorf("recording %s run: %w", job, err)
	}

	res := Result{RunID: run.ID, Job: job, AsOf: asOf}
	log := r.log.With("job", job, "job_run_id", store.FormatUUID(run.ID), "attempt", previous+1, "as_of", asOf.String())
	log.Info("job started")

	ids, err := q.ListBillableLeaseIDs(ctx)
	if err != nil {
		res.Status = StatusFailed
		res.Errors = []LeaseError{{Error: "listing leases failed"}}
		log.Error("job failed", "error", err)
		return res, errors.Join(fmt.Errorf("listing leases: %w", err), r.finish(ctx, q, &res))
	}

	interrupted := false
	for _, id := range ids {
		if ctx.Err() != nil {
			interrupted = true
			break
		}
		res.LeasesProcessed++
		n, err := r.processLease(ctx, def, id, asOf)
		if err != nil {
			leaseID := store.FormatUUID(id)
			res.Errors = append(res.Errors, LeaseError{LeaseID: leaseID, Error: err.Error()})
			log.Error("lease failed", "lease_id", leaseID, "error", err)
			continue
		}
		res.EntriesPosted += n
	}

	res.Status = StatusOK
	if interrupted || len(res.Errors) > 0 {
		res.Status = StatusPartial
	}
	if err := r.finish(ctx, q, &res); err != nil {
		log.Error("job failed", "error", err)
		return res, err
	}
	log.Info("job finished",
		"status", res.Status,
		"leases_processed", res.LeasesProcessed,
		"entries_posted", res.EntriesPosted,
		"lease_errors", len(res.Errors),
		"interrupted", interrupted)
	return res, nil
}

func (r *Runner) processLease(ctx context.Context, def definition, id pgtype.UUID, asOf calendar.Date) (int, error) {
	txCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), leaseTimeout)
	defer cancel()

	posted := 0
	err := store.WithTx(txCtx, r.pool, func(q *db.Queries) error {
		l, err := ledger.LockLease(txCtx, q, id)
		if err != nil {
			return err
		}
		posted, err = def.process(txCtx, q, l, asOf)
		return err
	})
	if err != nil {
		return 0, err
	}
	return posted, nil
}

func (r *Runner) finish(ctx context.Context, q *db.Queries, res *Result) error {
	errs := res.Errors
	if errs == nil {
		errs = []LeaseError{}
	}
	payload, err := json.Marshal(errs)
	if err != nil {
		return fmt.Errorf("encoding run errors: %w", err)
	}
	_, err = q.FinishJobRun(context.WithoutCancel(ctx), db.FinishJobRunParams{
		ID:              res.RunID,
		Status:          res.Status,
		FinishedAt:      store.Timestamptz(r.clock.Now()),
		LeasesProcessed: int32(res.LeasesProcessed),
		EntriesPosted:   int32(res.EntriesPosted),
		Errors:          payload,
	})
	if err != nil {
		return fmt.Errorf("finishing %s run: %w", res.Job, err)
	}
	return nil
}

// Tick runs, in order, each job that has no successful run for today.
func (r *Runner) Tick(ctx context.Context) error {
	today := r.Today()
	q := db.New(r.pool)
	var errs []error
	for _, job := range Names {
		if ctx.Err() != nil {
			break
		}
		done, err := q.HasSuccessfulJobRun(ctx, db.HasSuccessfulJobRunParams{Job: job, AsOf: store.Date(today)})
		if err != nil {
			errs = append(errs, fmt.Errorf("checking %s runs: %w", job, err))
			continue
		}
		if done {
			continue
		}
		if _, err := r.Run(ctx, job, today); err != nil {
			errs = append(errs, fmt.Errorf("running %s: %w", job, err))
		}
	}
	return errors.Join(errs...)
}

// Work calls Tick immediately and then every interval until ctx is done.
func (r *Runner) Work(ctx context.Context, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := r.Tick(ctx); err != nil && ctx.Err() == nil {
			r.log.Error("worker tick failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
