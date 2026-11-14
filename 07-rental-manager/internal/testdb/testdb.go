// Package testdb gives integration tests a migrated, empty Postgres database
// and small fixture builders. Tests using it are skipped when
// TEST_DATABASE_URL is unset; packages must run with -p 1 because they
// share one database.
package testdb

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"

	"rentalmanager/internal/calendar"
	"rentalmanager/internal/store"
	"rentalmanager/migrations"
)

var (
	migrateOnce sync.Once
	migrateErr  error
)

const truncateAll = `TRUNCATE ledger_entries, lease_tenants, leases, units, properties, tenants,
	job_runs, sessions, users RESTART IDENTITY CASCADE`

// Open returns a pool connected to TEST_DATABASE_URL with every table
// emptied. The pool is closed when the test ends.
func Open(t testing.TB) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()

	migrateOnce.Do(func() { migrateErr = migrate(ctx, url) })
	if migrateErr != nil {
		t.Fatalf("migrating test database: %v", migrateErr)
	}

	pool, err := store.Open(ctx, url)
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, truncateAll); err != nil {
		t.Fatalf("truncating test database: %v", err)
	}
	return pool
}

func migrate(ctx context.Context, url string) error {
	conn, err := sql.Open("pgx", url)
	if err != nil {
		return err
	}
	runErr := migrations.Run(ctx, conn, "up", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := conn.Close(); err != nil && runErr == nil {
		return err
	}
	return runErr
}

// Chicago is the business zone used by integration tests.
var Chicago = mustLoadLocation("America/Chicago")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("loading %s: %v", name, err))
	}
	return loc
}

// ClockAt returns a clock fixed at noon in Chicago on date (YYYY-MM-DD).
func ClockAt(t testing.TB, date string) calendar.FixedClock {
	t.Helper()
	d := MustDate(t, date)
	return calendar.FixedClock{T: time.Date(d.Year, d.Month, d.Day, 12, 0, 0, 0, Chicago)}
}

// MustDate parses a YYYY-MM-DD date or fails the test.
func MustDate(t testing.TB, s string) calendar.Date {
	t.Helper()
	d, err := calendar.Parse(s)
	if err != nil {
		t.Fatalf("parsing date %q: %v", s, err)
	}
	return d
}
