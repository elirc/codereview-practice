package main

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib"

	"rentalmanager/migrations"
)

func runMigrate(ctx context.Context, a *app, args []string) error {
	command := "up"
	if len(args) > 0 {
		command = args[0]
	}
	if len(args) > 1 {
		return fmt.Errorf("migrate takes at most one argument, got %d", len(args))
	}

	db, err := sql.Open("pgx", a.cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			a.log.Warn("closing migration connection", "error", err)
		}
	}()

	return migrations.Run(ctx, db, command, a.log)
}
