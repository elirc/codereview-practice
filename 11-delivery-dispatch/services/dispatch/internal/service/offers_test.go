package service_test

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	dt "deliverydispatch/services/dispatch/internal/dispatchtest"
	"deliverydispatch/services/dispatch/internal/store/db"
)

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("err = %v, want code %s", err, code)
	}
}

func runOffers(t *testing.T, e *dt.Env) {
	t.Helper()
	if _, err := e.Svc.RunOffers(context.Background(), e.Clock.Now()); err != nil {
		t.Fatal(err)
	}
}

func pendingOffer(t *testing.T, e *dt.Env, deliveryID uuid.UUID) db.Offer {
	t.Helper()
	o, err := e.Svc.Queries().GetPendingOfferForDelivery(context.Background(), deliveryID)
	if err != nil {
		t.Fatalf("no pending offer for %s: %v", deliveryID, err)
	}
	return o
}

func TestCandidateFreshnessAndRadius(t *testing.T) {
	tests := []struct {
		name     string
		age      time.Duration
		distance float64
		offered  bool
	}{
		{"fresh and near", 119 * time.Second, 1000, true},
		{"position 121 s old", 121 * time.Second, 1000, false},
		{"position exactly 120 s old", 120 * time.Second, 1000, false},
		{"4,990 m away", 0, 4990, true},
		{"5,010 m away", 0, 5010, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := dt.New(t)
			c := uuid.New()
			e.CourierStatus(c, "available", "lagos-yaba", "bike", 2)
			e.CourierAt(c, dt.East(dt.Pickup, tt.distance), e.Clock.Now().Add(-tt.age), 1)
			d := e.ConfirmOrder("lagos-yaba")
			runOffers(t, e)
			got := e.Delivery(d)
			if (got.Status == "offered") != tt.offered {
				t.Fatalf("status = %s, offered want %v", got.Status, tt.offered)
			}
			if !tt.offered && (got.OffersMade != 0 || !got.NextOfferAt.Equal(e.Clock.Now().Add(dt.Config.OfferRetry))) {
				t.Fatalf("no-candidate pass changed attempts or retry time: %+v", got)
			}
		})
	}
}

func TestNearestCandidateWinsAndTiesGoToLowestID(t *testing.T) {
	e := dt.New(t)
	far := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 1500))
	ids := []uuid.UUID{uuid.New(), uuid.New()}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		e.CourierStatus(id, "available", "lagos-yaba", "bike", 2)
		e.CourierAt(id, dt.East(dt.Pickup, 300), e.Clock.Now(), 1)
	}
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	if o := pendingOffer(t, e, d); o.CourierID != ids[0] {
		t.Fatalf("offered to %s, want nearest lowest id %s (far courier %s)", o.CourierID, ids[0], far)
	}
}

func TestCouriersWithPendingOfferOrActiveDeliveryAreSkipped(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	first := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	if o := pendingOffer(t, e, first); o.CourierID != c {
		t.Fatal("first delivery not offered to the courier")
	}

	second := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	if got := e.Delivery(second); got.Status != "searching" || got.OffersMade != 0 {
		t.Fatalf("courier with a pending offer was offered again: %+v", got)
	}

	if _, err := e.Svc.AcceptOffer(dt.AsCourier(c), pendingOffer(t, e, first).ID); err != nil {
		t.Fatal(err)
	}
	e.Clock.Advance(dt.Config.OfferRetry)
	runOffers(t, e)
	if got := e.Delivery(second); got.Status != "searching" {
		t.Fatalf("courier in reserving was offered: %+v", got)
	}
}

func TestTwoDeliveriesOneCourierGetOneOffer(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	a := e.ConfirmOrder("lagos-yaba")
	b := e.ConfirmOrder("lagos-yaba")

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = e.Svc.RunOffers(context.Background(), e.Clock.Now())
		}()
	}
	wg.Wait()
	if n := e.Count(`SELECT count(*) FROM offers WHERE courier_id = $1 AND status = 'pending'`, c); n != 1 {
		t.Fatalf("pending offers for the courier = %d, want 1", n)
	}
	offered := 0
	for _, id := range []uuid.UUID{a, b} {
		if e.Delivery(id).Status == "offered" {
			offered++
		}
	}
	if offered != 1 {
		t.Fatalf("offered deliveries = %d, want 1", offered)
	}
}

func TestAcceptDeclineAndExpiry(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	o := pendingOffer(t, e, d)

	_, err := e.Svc.AcceptOffer(dt.AsCourier(uuid.New()), o.ID)
	wantCode(t, err, "not_found")

	if _, err := e.Svc.DeclineOffer(dt.AsCourier(c), o.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.Delivery(d); got.Status != "searching" || !got.NextOfferAt.Equal(e.Clock.Now()) {
		t.Fatalf("after decline: %+v", got)
	}
	_, err = e.Svc.AcceptOffer(dt.AsCourier(c), o.ID)
	wantCode(t, err, "offer_not_pending")

	runOffers(t, e)
	if got := e.Delivery(d); got.Status != "searching" {
		t.Fatalf("courier who declined was offered again: %+v", got)
	}

	other := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 400))
	e.Clock.Advance(dt.Config.OfferRetry)
	runOffers(t, e)
	o2 := pendingOffer(t, e, d)
	if o2.CourierID != other {
		t.Fatal("second courier not offered")
	}
	e.Clock.Set(o2.ExpiresAt)
	_, err = e.Svc.AcceptOffer(dt.AsCourier(other), o2.ID)
	wantCode(t, err, "offer_expired")

	n, err := e.Svc.ExpireOffers(context.Background(), e.Clock.Now())
	if err != nil || n != 1 {
		t.Fatalf("expired %d, %v", n, err)
	}
	if got := e.Delivery(d); got.Status != "searching" || got.OffersMade != 2 {
		t.Fatalf("after expiry: %+v", got)
	}
}

func TestAcceptJustBeforeExpiryAndDoubleTap(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	o := pendingOffer(t, e, d)
	e.Clock.Set(o.ExpiresAt.Add(-time.Millisecond))

	first, err := e.Svc.AcceptOffer(dt.AsCourier(c), o.ID)
	if err != nil || first.Status != "reserving" || !first.CourierID.Valid || first.CourierID.UUID != c {
		t.Fatalf("accept = %+v, %v", first, err)
	}
	second, err := e.Svc.AcceptOffer(dt.AsCourier(c), o.ID)
	if err != nil || second.ID != first.ID {
		t.Fatalf("second accept = %+v, %v", second, err)
	}
	if evs := e.Outbox("delivery.courier_requested"); len(evs) != 1 || evs[0].Sequence != 1 {
		t.Fatalf("courier_requested events = %+v", evs)
	}
}

func TestAcceptAndExpirySweeperRace(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	o := pendingOffer(t, e, d)
	e.Clock.Set(o.ExpiresAt.Add(-time.Millisecond))

	var wg sync.WaitGroup
	var acceptErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, acceptErr = e.Svc.AcceptOffer(dt.AsCourier(c), o.ID)
	}()
	go func() {
		defer wg.Done()
		_, _ = e.Svc.ExpireOffers(context.Background(), o.ExpiresAt)
	}()
	wg.Wait()

	got := e.Delivery(d)
	switch got.Status {
	case "reserving":
		if acceptErr != nil {
			t.Fatalf("reserving but accept failed: %v", acceptErr)
		}
	case "searching":
		if acceptErr == nil {
			t.Fatal("searching but accept succeeded")
		}
	default:
		t.Fatalf("status = %s", got.Status)
	}
}

func TestCourierGoingOfflineCancelsPendingOffer(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	o := pendingOffer(t, e, d)
	e.Clock.Advance(3 * time.Second)

	e.CourierStatus(c, "offline", "", "bike", 3)
	got := e.Delivery(d)
	if got.Status != "searching" || !got.NextOfferAt.Equal(e.Clock.Now()) {
		t.Fatalf("delivery after courier went offline: %+v", got)
	}
	_, err := e.Svc.AcceptOffer(dt.AsCourier(c), o.ID)
	wantCode(t, err, "offer_not_pending")
}

func TestSearchFailsAfterFiveOffersOrTenMinutes(t *testing.T) {
	e := dt.New(t)
	d := e.ConfirmOrder("lagos-yaba")
	for i := 0; i < 5; i++ {
		c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
		runOffers(t, e)
		o := pendingOffer(t, e, d)
		if _, err := e.Svc.DeclineOffer(dt.AsCourier(c), o.ID); err != nil {
			t.Fatal(err)
		}
	}
	runOffers(t, e)
	got := e.Delivery(d)
	if got.Status != "failed" || got.OffersMade != 5 {
		t.Fatalf("after five offers: %+v", got)
	}
	failed := e.Outbox("delivery.failed")
	if len(failed) != 1 || failed[0].Sequence != got.Version {
		t.Fatalf("failed events = %+v", failed)
	}

	slow := e.ConfirmOrder("lagos-yaba")
	e.Clock.Advance(dt.Config.SearchTimeout)
	runOffers(t, e)
	if got := e.Delivery(slow); got.Status != "failed" || got.OffersMade != 0 {
		t.Fatalf("after ten minutes: %+v", got)
	}
}

func TestCurrentOfferVisibleUntilExpiry(t *testing.T) {
	e := dt.New(t)
	c := e.AvailableCourier("lagos-yaba", dt.East(dt.Pickup, 200))
	d := e.ConfirmOrder("lagos-yaba")
	runOffers(t, e)
	od, err := e.Svc.CurrentOffer(dt.AsCourier(c))
	if err != nil || od.Delivery.ID != d {
		t.Fatalf("current offer = %+v, %v", od, err)
	}
	e.Clock.Set(od.Offer.ExpiresAt)
	_, err = e.Svc.CurrentOffer(dt.AsCourier(c))
	wantCode(t, err, "not_found")
	_, err = e.Svc.CurrentOffer(dt.AsOps())
	wantCode(t, err, "forbidden")
}
