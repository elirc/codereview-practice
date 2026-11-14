// Package pgxtx holds small helpers for pgx transactions and errors.
package pgxtx

import (
	"context"
	"encoding/binary"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Beginner starts transactions; *pgxpool.Pool and pgx.Tx satisfy it.
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// WithTx runs fn in a transaction, committing when fn returns nil and rolling
// back otherwise.
func WithTx(ctx context.Context, db Beginner, fn func(tx pgx.Tx) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// IsUniqueViolation reports whether err is a unique violation, optionally of a
// specific constraint or index.
func IsUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return constraint == "" || pgErr.ConstraintName == constraint
}

// AdvisoryKey derives a bigint advisory-lock key from id.
func AdvisoryKey(id uuid.UUID) int64 {
	return int64(binary.BigEndian.Uint64(id[:8]))
}
