package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"time"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/jobs"
	"rentalmanager/internal/store"
)

const workerInterval = 15 * time.Minute

func runWorker(ctx context.Context, a *app, args []string) error {
	if len(args) > 0 {
		return errors.New("worker takes no arguments")
	}
	pool, err := store.Open(ctx, a.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	runner := jobs.NewRunner(pool, calendar.SystemClock{}, a.cfg.Location, a.log)
	a.log.Info("worker started", "interval", workerInterval.String(), "timezone", a.cfg.Location.String())
	err = runner.Work(ctx, workerInterval)
	a.log.Info("worker stopped")
	return err
}

func runJob(ctx context.Context, a *app, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: rentmgr run-job <name> [--as-of YYYY-MM-DD]")
	}
	name := args[0]
	fs := flag.NewFlagSet("run-job", flag.ContinueOnError)
	fs.SetOutput(a.out)
	asOfFlag := fs.String("as-of", "", "business date to run as, YYYY-MM-DD (default today)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}

	pool, err := store.Open(ctx, a.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	runner := jobs.NewRunner(pool, calendar.SystemClock{}, a.cfg.Location, a.log)
	asOf := runner.Today()
	if *asOfFlag != "" {
		asOf, err = calendar.Parse(*asOfFlag)
		if err != nil {
			return fmt.Errorf("--as-of %w", err)
		}
	}

	res, err := runner.Run(ctx, name, asOf)
	if err != nil {
		return err
	}
	if res.Skipped {
		fmt.Fprintf(a.out, "%s skipped: another run holds the lock\n", name)
		return nil
	}
	fmt.Fprintf(a.out, "%s as of %s: %s, %d leases, %d entries posted, %d lease errors\n",
		name, asOf, res.Status, res.LeasesProcessed, res.EntriesPosted, len(res.Errors))
	if res.Status != jobs.StatusOK {
		return fmt.Errorf("%s finished with status %s", name, res.Status)
	}
	return nil
}
