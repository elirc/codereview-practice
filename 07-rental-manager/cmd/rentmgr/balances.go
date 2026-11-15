package main

import (
	"context"
	"errors"
	"fmt"

	"rentalmanager/internal/store"
	"rentalmanager/internal/store/db"
)

func runRebuildBalances(ctx context.Context, a *app, args []string) error {
	if len(args) > 0 {
		return errors.New("rebuild-balances takes no arguments")
	}
	pool, err := store.Open(ctx, a.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	q := db.New(tx)
	if err := q.DeleteLeaseSummaries(ctx); err != nil {
		return fmt.Errorf("clearing lease summaries: %w", err)
	}
	n, err := q.RebuildLeaseSummaries(ctx)
	if err != nil {
		return fmt.Errorf("rebuilding lease summaries: %w", err)
	}
	tx.Commit(ctx)
	fmt.Fprintf(a.out, "rebuilt balances for %d leases\n", n)
	return nil
}
