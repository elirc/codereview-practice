// Package store owns database access: the sqlc-generated queries in package
// db, the connection pool, transactions and conversions between domain and
// pgtype values.
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"rentalmanager/internal/store/db"
)

// Open connects a pool to databaseURL and verifies the connection.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connecting to database: %w", err)
	}
	return pool, nil
}

// WithTx runs fn inside a transaction. The transaction commits when fn
// returns nil and rolls back when fn returns an error or panics.
func WithTx(ctx context.Context, pool *pgxpool.Pool, fn func(q *db.Queries) error) error {
	return runTx(ctx, pool, pgx.TxOptions{}, fn)
}

// WithSnapshot runs read-only fn in a repeatable-read transaction so that
// every query sees the same snapshot.
func WithSnapshot(ctx context.Context, pool *pgxpool.Pool, fn func(q *db.Queries) error) error {
	return runTx(ctx, pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, fn)
}

func runTx(ctx context.Context, pool *pgxpool.Pool, opts pgx.TxOptions, fn func(q *db.Queries) error) (err error) {
	tx, err := pool.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	// Rollback must still reach the server when ctx has been cancelled.
	rbCtx := context.WithoutCancel(ctx)
	defer func() {
		if p := recover(); p != nil {
			// The panic is re-raised; a rollback failure here would only hide it.
			_ = tx.Rollback(rbCtx)
			panic(p)
		}
		if err != nil {
			if rbErr := tx.Rollback(rbCtx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
				err = errors.Join(err, fmt.Errorf("rollback: %w", rbErr))
			}
		}
	}()

	if err = fn(db.New(tx)); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// Postgres SQLSTATE codes for integrity violations.
const (
	codeForeignKeyViolation = "23503"
	codeUniqueViolation     = "23505"
	codeExclusionViolation  = "23P01"
)

// IsNotFound reports whether err means a query returned no rows.
func IsNotFound(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// IsUniqueViolation reports whether err is a unique violation of constraint
// (any constraint when constraint is empty).
func IsUniqueViolation(err error, constraint string) bool {
	return isViolation(err, codeUniqueViolation, constraint)
}

// IsExclusionViolation reports whether err is an exclusion constraint
// violation of constraint.
func IsExclusionViolation(err error, constraint string) bool {
	return isViolation(err, codeExclusionViolation, constraint)
}

// IsForeignKeyViolation reports whether err is a foreign key violation of
// constraint.
func IsForeignKeyViolation(err error, constraint string) bool {
	return isViolation(err, codeForeignKeyViolation, constraint)
}

func isViolation(err error, code, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		return false
	}
	return constraint == "" || pgErr.ConstraintName == constraint
}
