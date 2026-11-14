package service

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

func (e *env) place(t *testing.T, customer uuid.UUID) db.Order {
	t.Helper()
	q := e.quote(t, customer)
	o, created, err := e.svc.PlaceOrder(as(auth.RoleCustomer, customer), q.ID, "key-"+q.ID.String()[:8])
	if err != nil || !created {
		t.Fatalf("place order: created=%v err=%v", created, err)
	}
	return o
}

func (e *env) confirmed(t *testing.T, customer uuid.UUID) db.Order {
	t.Helper()
	o := e.place(t, customer)
	c, err := e.svc.Confirm(asRestaurant(e.restaurant.ID), o.ID)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	return c
}

func TestPlaceOrderCopiesQuoteAndIsIdempotentByKey(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	ctx := as(auth.RoleCustomer, customer)
	q := e.quote(t, customer)

	o, created, err := e.svc.PlaceOrder(ctx, q.ID, "checkout-0001")
	if err != nil || !created {
		t.Fatalf("first place: %v %v", created, err)
	}
	if o.Status != domain.StatusPlaced || o.TotalMinor != q.TotalMinor || o.DeliveryFeeMinor != q.DeliveryFeeMinor || o.Version != 1 {
		t.Fatalf("order = %+v", o)
	}
	if !o.ConfirmDeadline.Equal(t0.Add(testConfig.ConfirmTimeout)) {
		t.Fatalf("confirm_deadline = %v", o.ConfirmDeadline)
	}

	again, created, err := e.svc.PlaceOrder(ctx, q.ID, "checkout-0001")
	if err != nil || created || again.ID != o.ID {
		t.Fatalf("repeat place: id=%v created=%v err=%v", again.ID, created, err)
	}

	other := e.quote(t, customer)
	_, _, err = e.svc.PlaceOrder(ctx, other.ID, "checkout-0001")
	wantCode(t, err, "idempotency_key_reused")

	if got := e.outboxTypes(t); len(got) != 0 {
		t.Fatalf("placing an order emitted %v", got)
	}
}

func TestConcurrentPlacementsWithOneKeyCreateOneOrder(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	q := e.quote(t, customer)

	var wg sync.WaitGroup
	ids := make([]uuid.UUID, 6)
	errs := make([]error, 6)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			o, _, err := e.svc.PlaceOrder(as(auth.RoleCustomer, customer), q.ID, "same-key-123")
			ids[i], errs[i] = o.ID, err
		}(i)
	}
	wg.Wait()
	for i := range ids {
		if errs[i] != nil || ids[i] != ids[0] {
			t.Fatalf("attempt %d: id=%v err=%v (first %v)", i, ids[i], errs[i], ids[0])
		}
	}
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM orders`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("orders = %d, %v", n, err)
	}
}

func TestQuoteIsSingleUseAcrossKeys(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	q := e.quote(t, customer)

	var wg sync.WaitGroup
	results := make([]error, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, results[i] = e.svc.PlaceOrder(as(auth.RoleCustomer, customer), q.ID, fmt.Sprintf("distinct-key-%d", i))
		}(i)
	}
	wg.Wait()
	ok := 0
	for _, err := range results {
		if err == nil {
			ok++
			continue
		}
		wantCode(t, err, "quote_already_used")
	}
	if ok != 1 {
		t.Fatalf("successful placements = %d, want 1", ok)
	}

	_, _, err := e.svc.PlaceOrder(as(auth.RoleCustomer, uuid.New()), q.ID, "stranger-key-1")
	wantCode(t, err, "not_found")
}

func TestExpiredQuoteIsRefusedAndSurgeLaterDoesNotChangeOrder(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	ctx := as(auth.RoleCustomer, customer)

	q := e.quote(t, customer)
	if _, err := e.svc.q.ApplyZoneSurge(context.Background(), db.ApplyZoneSurgeParams{
		ZoneID: e.restaurant.ZoneID, MultiplierBps: 20000, Version: 1, UpdatedAt: t0,
	}); err != nil {
		t.Fatal(err)
	}
	o, _, err := e.svc.PlaceOrder(ctx, q.ID, "surge-key-01")
	if err != nil || o.DeliveryFeeMinor != q.DeliveryFeeMinor || o.SurgeBps != 10000 {
		t.Fatalf("order = %+v, err = %v", o, err)
	}

	late := e.quote(t, customer)
	e.clock.Advance(testConfig.QuoteTTL)
	_, _, err = e.svc.PlaceOrder(ctx, late.ID, "late-key-001")
	wantCode(t, err, "quote_expired")
}

func TestActiveOrderLimitHoldsUnderConcurrency(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	ctx := as(auth.RoleCustomer, customer)
	e.place(t, customer)
	e.place(t, customer)

	quotes := []db.Quote{e.quote(t, customer), e.quote(t, customer)}
	var wg sync.WaitGroup
	errs := make([]error, len(quotes))
	for i, q := range quotes {
		wg.Add(1)
		go func(i int, q db.Quote) {
			defer wg.Done()
			_, _, errs[i] = e.svc.PlaceOrder(ctx, q.ID, fmt.Sprintf("limit-key-%d", i))
		}(i, q)
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		if err == nil {
			ok++
			continue
		}
		wantCode(t, err, "too_many_active_orders")
	}
	if ok != 1 {
		t.Fatalf("placements over the limit: %d succeeded, want 1", ok)
	}

	orders, err := e.svc.ListOrders(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Reject(asOps(), orders[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.PlaceOrder(ctx, e.quote(t, customer).ID, "freed-slot-1"); err != nil {
		t.Fatalf("cancelled order did not free a slot: %v", err)
	}
}

func TestConfirmSetsReadyAtAndEmitsOrderConfirmed(t *testing.T) {
	e := newEnv(t)
	o := e.place(t, uuid.New())
	e.clock.Advance(time.Minute)

	c, err := e.svc.Confirm(asRestaurant(e.restaurant.ID), o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != domain.StatusConfirmed || c.Version != 2 || !c.ReadyAt.Equal(t0.Add(16*time.Minute)) {
		t.Fatalf("confirmed = %+v", c)
	}
	if got := e.outboxTypes(t); len(got) != 1 || got[0] != EventOrderConfirmed {
		t.Fatalf("outbox = %v", got)
	}
	_, err = e.svc.Confirm(asRestaurant(e.restaurant.ID), o.ID)
	wantCode(t, err, "invalid_state")
}

func TestConfirmAtDeadlineIsRefusedAndSweeperCancels(t *testing.T) {
	e := newEnv(t)
	o := e.place(t, uuid.New())

	e.clock.Set(o.ConfirmDeadline.Add(-time.Millisecond))
	early := e.place(t, uuid.New())
	e.clock.Set(o.ConfirmDeadline)
	_, err := e.svc.Confirm(asRestaurant(e.restaurant.ID), o.ID)
	wantCode(t, err, "confirm_window_closed")

	n, err := e.svc.SweepConfirmDeadlines(context.Background(), e.clock.Now())
	if err != nil || n != 1 {
		t.Fatalf("swept %d, %v", n, err)
	}
	d, err := e.svc.GetOrder(asOps(), o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Order.Status != domain.StatusCancelled || deref(d.Order.CancelReason) != domain.ReasonConfirmTimeout ||
		d.Order.RefundMinor != d.Order.TotalMinor || d.Order.CancellationFeeMinor != 0 {
		t.Fatalf("swept order = %+v", d.Order)
	}
	_, err = e.svc.Confirm(asRestaurant(e.restaurant.ID), o.ID)
	wantCode(t, err, "confirm_window_closed")

	if got, err := e.svc.GetOrder(asOps(), early.ID); err != nil || got.Order.Status != domain.StatusPlaced {
		t.Fatalf("order placed later was swept: %+v %v", got.Order, err)
	}
	if got := e.outboxTypes(t); len(got) != 1 || got[0] != EventOrderCancelled {
		t.Fatalf("outbox = %v", got)
	}
}

func TestConfirmAndSweeperRaceHasOneWinner(t *testing.T) {
	e := newEnv(t)
	o := e.place(t, uuid.New())
	e.clock.Set(o.ConfirmDeadline.Add(-time.Millisecond))

	var wg sync.WaitGroup
	var confirmErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, confirmErr = e.svc.Confirm(asRestaurant(e.restaurant.ID), o.ID)
	}()
	go func() {
		defer wg.Done()
		_, _ = e.svc.SweepConfirmDeadlines(context.Background(), o.ConfirmDeadline)
	}()
	wg.Wait()

	d, err := e.svc.GetOrder(asOps(), o.ID)
	if err != nil {
		t.Fatal(err)
	}
	switch d.Order.Status {
	case domain.StatusConfirmed:
		if confirmErr != nil {
			t.Fatalf("confirmed but confirm returned %v", confirmErr)
		}
	case domain.StatusCancelled:
		if confirmErr == nil {
			t.Fatal("cancelled but confirm reported success")
		}
	default:
		t.Fatalf("status = %s", d.Order.Status)
	}
	if got := e.outboxTypes(t); len(got) != 1 {
		t.Fatalf("outbox = %v, want exactly one event", got)
	}
}

func TestOrderVisibilityByRole(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	o := e.place(t, customer)

	visible := []context.Context{as(auth.RoleCustomer, customer), asRestaurant(e.restaurant.ID), asOps()}
	for _, ctx := range visible {
		if _, err := e.svc.GetOrder(ctx, o.ID); err != nil {
			t.Fatalf("expected visible: %v", err)
		}
	}
	_, err := e.svc.GetOrder(as(auth.RoleCustomer, uuid.New()), o.ID)
	wantCode(t, err, "not_found")
	_, err = e.svc.GetOrder(asRestaurant(uuid.New()), o.ID)
	wantCode(t, err, "not_found")
	_, err = e.svc.GetOrder(as(auth.RoleCourier, uuid.New()), o.ID)
	wantCode(t, err, "forbidden")
	_, err = e.svc.Confirm(asRestaurant(uuid.New()), o.ID)
	wantCode(t, err, "not_found")
	_, err = e.svc.Confirm(as(auth.RoleCustomer, customer), o.ID)
	wantCode(t, err, "forbidden")

	mine, err := e.svc.ListOrders(as(auth.RoleCustomer, uuid.New()), nil)
	if err != nil || len(mine) != 0 {
		t.Fatalf("stranger lists %d orders, %v", len(mine), err)
	}
	placed := domain.StatusPlaced
	forRestaurant, err := e.svc.ListOrders(asRestaurant(e.restaurant.ID), &placed)
	if err != nil || len(forRestaurant) != 1 {
		t.Fatalf("restaurant lists %d orders, %v", len(forRestaurant), err)
	}
}
