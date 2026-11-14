// Package pgtest gives integration tests an isolated, migrated Postgres schema.
package pgtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io/fs"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/migrate"
)

// Env var names for the three test databases.
const (
	EnvOrders   = "TEST_DATABASE_URL_ORDERS"
	EnvDispatch = "TEST_DATABASE_URL_DISPATCH"
	EnvCouriers = "TEST_DATABASE_URL_COURIERS"
)

// NewPool creates a fresh schema in the database named by envVar, applies
// migrations to it (when non-nil) and returns a pool whose search_path starts
// with that schema. The test is skipped when envVar is unset, and the schema
// is dropped when the test ends.
func NewPool(t testing.TB, envVar string, migrations fs.FS) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv(envVar)
	if dsn == "" {
		t.Skipf("%s is not set", envVar)
	}
	ctx := context.Background()

	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	schema := "t_" + hex.EncodeToString(b[:])

	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect %s: %v", envVar, err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		_ = admin.Close(ctx)
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		_ = admin.Close(context.Background())
	})

	searchPath := schema + ", public"
	if migrations != nil {
		cc, err := pgx.ParseConfig(dsn)
		if err != nil {
			t.Fatal(err)
		}
		cc.RuntimeParams["search_path"] = searchPath
		if err := migrate.RunConfig(ctx, cc, migrations, "up"); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = searchPath
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// MessagingSchema creates the outbox, inbox and dead_letters tables with the
// shape every service migration uses, for tests of the shared packages.
const MessagingSchema = `
CREATE TABLE outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE,
    subject text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    last_error text
);
CREATE TABLE inbox (
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);
CREATE TABLE dead_letters (
    id uuid PRIMARY KEY,
    consumer text NOT NULL,
    event_id uuid,
    subject text NOT NULL,
    payload bytea NOT NULL,
    error text NOT NULL,
    delivery_count integer NOT NULL,
    created_at timestamptz NOT NULL,
    replayed_at timestamptz
);`

// Exec runs sql on pool and fails the test on error.
func Exec(t testing.TB, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}
