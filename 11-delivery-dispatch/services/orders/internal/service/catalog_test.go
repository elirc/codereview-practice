package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("err = %v, want code %s", err, code)
	}
}

func TestCreateQuotePricesFromDistanceAndSurge(t *testing.T) {
	e := newEnv(t)
	customer := uuid.New()

	q := e.quote(t, customer)
	if q.DistanceM < 2340 || q.DistanceM > 2350 {
		t.Fatalf("distance = %d m", q.DistanceM)
	}
	wantFee := domain.DeliveryFee(testConfig.Fees, int64(q.DistanceM), 10000)
	if q.SurgeBps != 10000 || q.DeliveryFeeMinor != wantFee || q.TotalMinor != 3000+wantFee {
		t.Fatalf("quote = %+v", q)
	}
	if !q.ExpiresAt.Equal(t0.Add(testConfig.QuoteTTL)) {
		t.Fatalf("expires_at = %v", q.ExpiresAt)
	}
	if q.EtaMinutes != int32(domain.QuoteETAMinutes(15, int64(q.DistanceM))) {
		t.Fatalf("eta = %d", q.EtaMinutes)
	}

	if _, err := e.svc.q.ApplyZoneSurge(context.Background(), db.ApplyZoneSurgeParams{
		ZoneID: e.restaurant.ZoneID, MultiplierBps: 12500, Version: 1, UpdatedAt: t0,
	}); err != nil {
		t.Fatal(err)
	}
	surged := e.quote(t, customer)
	if surged.SurgeBps != 12500 || surged.DeliveryFeeMinor != domain.DeliveryFee(testConfig.Fees, int64(surged.DistanceM), 12500) {
		t.Fatalf("surged quote = %+v", surged)
	}
}

func TestCreateQuoteRejections(t *testing.T) {
	e := newEnv(t)
	customer := as(auth.RoleCustomer, uuid.New())

	far := e.nearbyQuote()
	far.DropoffLon = e.restaurant.Lon + 0.2
	_, err := e.svc.CreateQuote(customer, far)
	wantCode(t, err, "out_of_range")

	missing := e.nearbyQuote()
	missing.RestaurantID = uuid.New()
	_, err = e.svc.CreateQuote(customer, missing)
	wantCode(t, err, "not_found")

	if _, err := e.pool.Exec(context.Background(), `UPDATE restaurants SET active = false`); err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.CreateQuote(customer, e.nearbyQuote())
	wantCode(t, err, "restaurant_inactive")

	for _, role := range []auth.Role{auth.RoleRestaurant, auth.RoleCourier, auth.RoleOps} {
		_, err := e.svc.CreateQuote(as(role, uuid.New()), e.nearbyQuote())
		wantCode(t, err, "forbidden")
	}
}

func TestListRestaurantsShowsActiveOnly(t *testing.T) {
	e := newEnv(t)
	if err := e.svc.q.UpsertRestaurant(context.Background(), db.UpsertRestaurantParams{
		ID: uuid.New(), Name: "Closed Kitchen", ZoneID: "lagos-yaba", Lon: 3.38, Lat: 6.52, PrepMinutes: 10, Active: false, CreatedAt: t0,
	}); err != nil {
		t.Fatal(err)
	}
	rs, err := e.svc.ListRestaurants(as(auth.RoleCustomer, uuid.New()))
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 1 || rs[0].ID != e.restaurant.ID {
		t.Fatalf("restaurants = %+v", rs)
	}
	_, err = e.svc.ListRestaurants(as(auth.RoleCourier, uuid.New()))
	wantCode(t, err, "forbidden")
}
