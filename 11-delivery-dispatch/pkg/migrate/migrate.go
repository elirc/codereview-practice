// Package migrate applies a service's embedded goose migrations.
package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

var mu sync.Mutex

// Run executes a goose command (up, down or status) against the database at dsn.
func Run(ctx context.Context, dsn string, migrations fs.FS, command string) error {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("parse database url: %w", err)
	}
	return RunConfig(ctx, cfg, migrations, command)
}

// RunConfig is Run for an already parsed connection config.
func RunConfig(ctx context.Context, cfg *pgx.ConnConfig, migrations fs.FS, command string) error {
	db := stdlib.OpenDB(*cfg)
	defer db.Close()
	return run(ctx, db, migrations, command)
}

func run(ctx context.Context, db *sql.DB, migrations fs.FS, command string) error {
	mu.Lock()
	defer mu.Unlock()
	goose.SetBaseFS(migrations)
	defer goose.SetBaseFS(nil)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	switch command {
	case "up":
		return goose.UpContext(ctx, db, ".")
	case "down":
		return goose.DownContext(ctx, db, ".")
	case "status":
		return goose.StatusContext(ctx, db, ".")
	default:
		return fmt.Errorf("unknown migrate command %q (want up, down or status)", command)
	}
}
