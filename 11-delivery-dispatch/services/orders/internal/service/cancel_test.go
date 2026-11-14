package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/orders/internal/domain"
)

func (e *env) apply(t *testing.T, orderID uuid.UUID, ev domain.DeliveryEvent) {
	t.Helper()
	if err := pgxtx.WithTx(context.Background(), e.pool, func(tx pgx.Tx) error {
		return e.svc.ApplyDeliveryEvent(context.Background(), tx, orderID, ev)
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCancelPlacedOrderAtOnce(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	o := e.place(t, customer)
	res, err := e.svc.Cancel(as(auth.RoleCustomer, customer), o.ID, nil)
	if err != nil || res.Pending || res.Order.Status != domain.StatusCancelled || res.Order.RefundMinor != o.TotalMinor {
		t.Fatalf("cancel = %+v, %v", res, err)
	}
	if got := e.outboxTypes(t); len(got) != 1 || got[0] != EventOrderCancelled {
		t.Fatalf("outbox = %v", got)
	}
	_, err = e.svc.Cancel(as(auth.RoleCustomer, customer), o.ID, nil)
	wantCode(t, err, "not_cancellable")
}

func TestCancelConfirmedOrderAsksDispatchOnce(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	o := e.confirmed(t, customer)
	note := "changed my mind"

	res, err := e.svc.Cancel(as(auth.RoleCustomer, customer), o.ID, &note)
	if err != nil || !res.Pending || res.Order.CancelRequest != domain.CancelRequestPending || res.Order.Status != domain.StatusConfirmed {
		t.Fatalf("cancel = %+v, %v", res, err)
	}
	again, err := e.svc.Cancel(as(auth.RoleCustomer, customer), o.ID, nil)
	if err != nil || !again.Pending {
		t.Fatalf("second cancel = %+v, %v", again, err)
	}
	types := e.outboxTypes(t)
	if len(types) != 2 || types[1] != EventOrderCancelRequested {
		t.Fatalf("outbox = %v", types)
	}
	_, err = e.svc.Cancel(as(auth.RoleCustomer, uuid.New()), o.ID, nil)
	wantCode(t, err, "not_found")
}

func TestDeliveryCancelledSettlesFee(t *testing.T) {
	tests := []struct {
		name     string
		ctx      func(e *env, customer uuid.UUID) context.Context
		assigned bool
		wantFee  int64
		reason   string
	}{
		{"customer, searching", func(_ *env, c uuid.UUID) context.Context { return as(auth.RoleCustomer, c) }, false, 0, "customer"},
		{"customer, assigned", func(_ *env, c uuid.UUID) context.Context { return as(auth.RoleCustomer, c) }, true, 500, "customer"},
		{"restaurant, assigned", func(e *env, _ uuid.UUID) context.Context { return asRestaurant(e.restaurant.ID) }, true, 0, "restaurant"},
		{"ops, assigned", func(*env, uuid.UUID) context.Context { return asOps() }, true, 0, "ops"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			customer := uuid.New()
			o := e.confirmed(t, customer)
			if _, err := e.svc.Cancel(tt.ctx(e, customer), o.ID, nil); err != nil {
				t.Fatal(err)
			}
			e.apply(t, o.ID, domain.DeliveryEvent{Type: domain.EventDeliveryCancelled, Sequence: 3, CourierWasAssigned: tt.assigned})
			d, err := e.svc.GetOrder(asOps(), o.ID)
			if err != nil {
				t.Fatal(err)
			}
			got := d.Order
			if got.Status != domain.StatusCancelled || got.CancellationFeeMinor != tt.wantFee ||
				got.RefundMinor != got.TotalMinor-tt.wantFee || deref(got.CancelReason) != tt.reason {
				t.Fatalf("order = %+v", got)
			}
		})
	}
}

func TestCancelRejectedByPickupLeavesOrderGoing(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	o := e.confirmed(t, customer)
	ctx := as(auth.RoleCustomer, customer)
	if _, err := e.svc.Cancel(ctx, o.ID, nil); err != nil {
		t.Fatal(err)
	}
	e.apply(t, o.ID, domain.DeliveryEvent{Type: domain.EventDeliveryCancelRejected, Sequence: 3, Reason: "picked_up"})
	d, _ := e.svc.GetOrder(ctx, o.ID)
	if d.Order.Status != domain.StatusPickedUp || d.Order.CancelRequest != domain.CancelRequestRejected {
		t.Fatalf("order = %+v", d.Order)
	}
	_, err := e.svc.Cancel(ctx, o.ID, nil)
	wantCode(t, err, "not_cancellable")
	e.apply(t, o.ID, domain.DeliveryEvent{Type: domain.EventDeliveryDelivered, Sequence: 4, CourierID: uuid.NullUUID{UUID: uuid.New(), Valid: true}})
	if d, _ := e.svc.GetOrder(ctx, o.ID); d.Order.Status != domain.StatusDelivered {
		t.Fatalf("order after delivery = %+v", d.Order)
	}
}

func TestCancelRetrySweeperResendsFiveTimesThenStops(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()
	o := e.confirmed(t, customer)
	if _, err := e.svc.Cancel(as(auth.RoleCustomer, customer), o.ID, nil); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	e.clock.Advance(testConfig.CancelRetry - time.Second)
	if n, _ := e.svc.RetryCancelRequests(ctx, e.clock.Now()); n != 0 {
		t.Fatalf("retried %d before the retry interval", n)
	}
	for i := 1; i <= MaxCancelRetries; i++ {
		e.clock.Advance(testConfig.CancelRetry)
		n, err := e.svc.RetryCancelRequests(ctx, e.clock.Now())
		if err != nil || n != 1 {
			t.Fatalf("retry %d: sent %d, %v", i, n, err)
		}
	}
	e.clock.Advance(testConfig.CancelRetry)
	if n, _ := e.svc.RetryCancelRequests(ctx, e.clock.Now()); n != 0 {
		t.Fatalf("sent %d after the retry limit", n)
	}
	e.clock.Advance(testConfig.CancelRetry)
	if n, _ := e.svc.RetryCancelRequests(ctx, e.clock.Now()); n != 0 {
		t.Fatalf("sent %d after flagging", n)
	}

	requests := 0
	for _, typ := range e.outboxTypes(t) {
		if typ == EventOrderCancelRequested {
			requests++
		}
	}
	if requests != 1+MaxCancelRetries {
		t.Fatalf("cancel requests sent = %d, want %d", requests, 1+MaxCancelRetries)
	}
	d, _ := e.svc.GetOrder(asOps(), o.ID)
	if d.Order.CancelRequest != domain.CancelRequestPending || d.Order.Status != domain.StatusConfirmed || d.Order.CancelRetryAt != nil {
		t.Fatalf("order left for ops = %+v", d.Order)
	}
}
