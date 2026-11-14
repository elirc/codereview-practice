package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/pgtest"
	"deliverydispatch/services/couriers/internal/store/db"
	"deliverydispatch/services/couriers/migrations"
)

var t0 = time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)

type env struct {
	svc   *Service
	pool  *pgxpool.Pool
	clock *clock.Manual
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := pgtest.NewPool(t, pgtest.EnvCouriers, migrations.FS)
	clk := clock.NewManual(t0)
	return &env{svc: New(pool, "USD", clk, idgen.Random{}, logging.Discard()), pool: pool, clock: clk}
}

func asCourier(id uuid.UUID) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: id, Role: auth.RoleCourier})
}

func asOps() context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{Subject: uuid.New(), Role: auth.RoleOps})
}

func (e *env) courier(t *testing.T) db.Courier {
	t.Helper()
	c, err := e.svc.CreateCourier(asOps(), "Ada Bike", "bike")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (e *env) onShift(t *testing.T, zone string) db.Courier {
	t.Helper()
	c := e.courier(t)
	c, err := e.svc.StartShift(asCourier(c.ID), zone)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("err = %v, want code %s", err, code)
	}
}

// events returns the outbox envelopes in id order.
func (e *env) events(t *testing.T) []envelope.Envelope {
	t.Helper()
	rows, err := e.pool.Query(context.Background(), `SELECT payload FROM outbox ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []envelope.Envelope
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		env, err := envelope.Decode(raw)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, env)
	}
	return out
}

func (e *env) eventsOfType(t *testing.T, eventType string) []envelope.Envelope {
	t.Helper()
	var out []envelope.Envelope
	for _, ev := range e.events(t) {
		if ev.Type == eventType {
			out = append(out, ev)
		}
	}
	return out
}
