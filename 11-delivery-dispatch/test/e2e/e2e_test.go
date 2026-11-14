// Package e2e wires orders, dispatch and couriers in one process against real
// databases and NATS JetStream and steps them deterministically: relays and
// consumers are driven by the test rather than by background loops.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go/jetstream"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/pkg/logging"
	"deliverydispatch/pkg/natsx"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/pkg/pgtest"
	couriersapp "deliverydispatch/services/couriers/app"
	couriersmig "deliverydispatch/services/couriers/migrations"
	dispatchapp "deliverydispatch/services/dispatch/app"
	dispatchmig "deliverydispatch/services/dispatch/migrations"
	ordersapp "deliverydispatch/services/orders/app"
	ordersmig "deliverydispatch/services/orders/migrations"
)

const secret = "e2e-secret-e2e-secret-e2e-secret-e2e"

var t0 = time.Date(2026, 3, 2, 18, 0, 0, 0, time.UTC)

type node struct {
	pool       *pgxpool.Pool
	relay      *outbox.Relay
	processors map[natsx.Stream]*inbox.Processor
	server     *httptest.Server
}

type system struct {
	t          *testing.T
	js         jetstream.JetStream
	clock      *clock.Manual
	orders     node
	dispatch   node
	couriers   node
	offerPass  func(context.Context, time.Time) (int, error)
	restaurant uuid.UUID
}

func env(lookup map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := lookup[k]
		return v, ok
	}
}

func newSystem(t *testing.T) *system {
	t.Helper()
	natsURL := os.Getenv("TEST_NATS_URL")
	if natsURL == "" {
		t.Skip("TEST_NATS_URL is not set")
	}
	ordersPool := pgtest.NewPool(t, pgtest.EnvOrders, ordersmig.FS)
	dispatchPool := pgtest.NewPool(t, pgtest.EnvDispatch, dispatchmig.FS)
	couriersPool := pgtest.NewPool(t, pgtest.EnvCouriers, couriersmig.FS)

	logger := logging.Discard()
	nc, js, err := natsx.Connect(natsURL, "e2e", logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	ctx := context.Background()
	for _, s := range []natsx.Stream{natsx.StreamOrders, natsx.StreamDispatch, natsx.StreamCouriers} {
		if err := js.DeleteStream(ctx, s.Name); err != nil && !errors.Is(err, jetstream.ErrStreamNotFound) {
			t.Fatal(err)
		}
	}
	if err := natsx.EnsureStreams(ctx, js, natsx.StreamOrders, natsx.StreamDispatch, natsx.StreamCouriers); err != nil {
		t.Fatal(err)
	}

	common := map[string]string{
		"AUTH_JWT_SECRET":       secret,
		"APP_CURRENCY":          "USD",
		"LOOPS_ENABLED":         "false",
		"ORDERS_DATABASE_URL":   "unused",
		"DISPATCH_DATABASE_URL": "unused",
		"COURIERS_DATABASE_URL": "unused",
	}
	clk := clock.NewManual(t0)
	ids := idgen.Random{}

	oc, err := ordersapp.LoadConfig(env(common))
	if err != nil {
		t.Fatal(err)
	}
	dc, err := dispatchapp.LoadConfig(env(common))
	if err != nil {
		t.Fatal(err)
	}
	cc, err := couriersapp.LoadConfig(env(common))
	if err != nil {
		t.Fatal(err)
	}
	oa := ordersapp.New(oc, ordersapp.Deps{Pool: ordersPool, JS: js, Clock: clk, IDs: ids, Logger: logger})
	da := dispatchapp.New(dc, dispatchapp.Deps{Pool: dispatchPool, JS: js, Clock: clk, IDs: ids, Logger: logger})
	ca := couriersapp.New(cc, couriersapp.Deps{Pool: couriersPool, JS: js, Clock: clk, IDs: ids, Logger: logger})

	s := &system{
		t:         t,
		js:        js,
		clock:     clk,
		orders:    node{pool: ordersPool, relay: oa.Relay, processors: oa.Processors(), server: httptest.NewServer(oa.Router)},
		dispatch:  node{pool: dispatchPool, relay: da.Relay, processors: da.Processors(), server: httptest.NewServer(da.Router)},
		couriers:  node{pool: couriersPool, relay: ca.Relay, processors: ca.Processors(), server: httptest.NewServer(ca.Router)},
		offerPass: da.Service.RunOffers,
	}
	t.Cleanup(s.orders.server.Close)
	t.Cleanup(s.dispatch.server.Close)
	t.Cleanup(s.couriers.server.Close)

	s.restaurant = uuid.New()
	s.exec(ordersPool, `INSERT INTO restaurants (id, name, zone_id, lon, lat, prep_minutes, active, created_at)
		VALUES ($1, 'Iya Basira Kitchen', 'lagos-yaba', 3.3792, 6.5244, 15, true, $2)`, s.restaurant, t0)
	return s
}

func (s *system) exec(pool *pgxpool.Pool, sql string, args ...any) {
	s.t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		s.t.Fatal(err)
	}
}

func (s *system) scalar(pool *pgxpool.Pool, sql string, args ...any) any {
	s.t.Helper()
	var v any
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		s.t.Fatalf("%s: %v", sql, err)
	}
	return v
}

// pump publishes every outbox row and consumes every available message until
// nothing moves.
func (s *system) pump() {
	s.t.Helper()
	ctx := context.Background()
	logger := logging.Discard()
	for round := 0; round < 30; round++ {
		moved := 0
		for _, n := range []node{s.orders, s.dispatch, s.couriers} {
			published, err := n.relay.RunOnce(ctx, s.clock.Now())
			if err != nil {
				s.t.Fatal(err)
			}
			moved += published
		}
		for _, n := range []node{s.orders, s.dispatch, s.couriers} {
			for stream, p := range n.processors {
				handled, err := natsx.Drain(ctx, s.js, stream, p, logger)
				if err != nil {
					s.t.Fatal(err)
				}
				moved += handled
			}
		}
		if moved == 0 {
			return
		}
	}
	s.t.Fatal("system did not settle")
}

func token(t *testing.T, p auth.Principal) string {
	t.Helper()
	raw, err := auth.Mint([]byte(secret), p, t0.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// call sends a JSON request and decodes the JSON response into a map.
func (s *system) call(base, method, path, tok string, body any) (int, map[string]any) {
	s.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			s.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, base+path, rd)
	if err != nil {
		s.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	if res.StatusCode != http.StatusNoContent {
		_ = json.NewDecoder(res.Body).Decode(&out)
	}
	return res.StatusCode, out
}

func (s *system) must(want int, base, method, path, tok string, body any) map[string]any {
	s.t.Helper()
	status, out := s.call(base, method, path, tok, body)
	if status != want {
		s.t.Fatalf("%s %s = %d %v, want %d", method, path, status, out, want)
	}
	return out
}

type actors struct {
	customer, restaurant, ops string
}

func (s *system) actors() actors {
	return actors{
		customer:   token(s.t, auth.Principal{Subject: uuid.New(), Role: auth.RoleCustomer}),
		restaurant: token(s.t, auth.Principal{Subject: uuid.New(), Role: auth.RoleRestaurant, RestaurantID: uuid.NullUUID{UUID: s.restaurant, Valid: true}}),
		ops:        token(s.t, auth.Principal{Subject: uuid.New(), Role: auth.RoleOps}),
	}
}

// onShiftCourier creates a courier 800 m from the restaurant and returns their token and id.
func (s *system) onShiftCourier(a actors) (string, string) {
	s.t.Helper()
	c := s.must(http.StatusCreated, s.couriers.server.URL, "POST", "/couriers", a.ops, map[string]any{"name": "Tunde", "vehicle": "bike"})
	id := c["id"].(string)
	tok := token(s.t, auth.Principal{Subject: uuid.MustParse(id), Role: auth.RoleCourier})
	s.must(http.StatusOK, s.couriers.server.URL, "POST", "/couriers/me/shift/start", tok, map[string]any{"zone_id": "lagos-yaba"})
	s.must(http.StatusNoContent, s.couriers.server.URL, "POST", "/couriers/me/location", tok, map[string]any{
		"lon": 3.3864, "lat": 6.5244, "recorded_at": s.clock.Now(),
	})
	return tok, id
}

// confirmedOrder places and confirms an order and returns its id.
func (s *system) confirmedOrder(a actors) string {
	s.t.Helper()
	q := s.must(http.StatusCreated, s.orders.server.URL, "POST", "/quotes", a.customer, map[string]any{
		"restaurant_id": s.restaurant.String(),
		"items":         []map[string]any{{"name": "Amala", "quantity": 2, "unit_price_minor": 1500}},
		"dropoff":       map[string]any{"lon": 3.3973, "lat": 6.5244},
	})
	o := s.must(http.StatusCreated, s.orders.server.URL, "POST", "/orders", a.customer, map[string]any{
		"quote_id": q["id"], "client_order_key": "e2e-" + uuid.NewString()[:8],
	})
	id := o["id"].(string)
	s.must(http.StatusOK, s.orders.server.URL, "POST", "/orders/"+id+"/confirm", a.restaurant, nil)
	return id
}

func (s *system) runOffers() {
	s.t.Helper()
	if _, err := s.offerPass(context.Background(), s.clock.Now()); err != nil {
		s.t.Fatal(err)
	}
}

func (s *system) orderStatus(a actors, id string) map[string]any {
	return s.must(http.StatusOK, s.orders.server.URL, "GET", "/orders/"+id, a.ops, nil)
}

// assignedOrder takes an order through offer, acceptance and reservation.
func (s *system) assignedOrder(a actors) (orderID, courierTok, courierID string) {
	s.t.Helper()
	courierTok, courierID = s.onShiftCourier(a)
	s.pump()
	orderID = s.confirmedOrder(a)
	s.pump()
	s.runOffers()
	offer := s.must(http.StatusOK, s.dispatch.server.URL, "GET", "/offers/current", courierTok, nil)
	s.must(http.StatusOK, s.dispatch.server.URL, "POST", "/offers/"+offer["id"].(string)+"/accept", courierTok, nil)
	s.pump()
	if st := s.orderStatus(a, orderID)["status"]; st != "courier_assigned" {
		s.t.Fatalf("order status = %v, want courier_assigned", st)
	}
	return orderID, courierTok, courierID
}

func TestHappyPathToDelivered(t *testing.T) {
	s := newSystem(t)
	a := s.actors()
	orderID, courierTok, courierID := s.assignedOrder(a)

	s.must(http.StatusOK, s.dispatch.server.URL, "POST", "/deliveries/"+orderID+"/pickup", courierTok, nil)
	s.pump()
	if st := s.orderStatus(a, orderID)["status"]; st != "picked_up" {
		t.Fatalf("order status = %v", st)
	}
	d := s.must(http.StatusOK, s.dispatch.server.URL, "POST", "/deliveries/"+orderID+"/deliver", courierTok, nil)
	s.pump()

	o := s.orderStatus(a, orderID)
	if o["status"] != "delivered" || o["courier_id"] != courierID {
		t.Fatalf("order = %v", o)
	}
	earnings := s.must(http.StatusOK, s.couriers.server.URL, "GET", "/couriers/me/earnings", courierTok, nil)
	if earnings["total_minor"] != d["courier_payout_minor"] {
		t.Fatalf("earnings %v, payout %v", earnings["total_minor"], d["courier_payout_minor"])
	}
	me := s.must(http.StatusOK, s.couriers.server.URL, "GET", "/couriers/me", courierTok, nil)
	if me["status"] != "available" {
		t.Fatalf("courier = %v", me)
	}
}

func TestNoCourierCancelsOrder(t *testing.T) {
	s := newSystem(t)
	a := s.actors()
	orderID := s.confirmedOrder(a)
	s.pump()
	s.runOffers()
	s.clock.Advance(10 * time.Minute)
	s.runOffers()
	s.pump()

	o := s.orderStatus(a, orderID)
	if o["status"] != "cancelled" || o["cancel_reason"] != "no_courier" || o["refund_minor"] != o["total_minor"] {
		t.Fatalf("order = %v", o)
	}
}

func TestCancelWhileAssigned(t *testing.T) {
	s := newSystem(t)
	a := s.actors()
	orderID, courierTok, _ := s.assignedOrder(a)

	s.must(http.StatusAccepted, s.orders.server.URL, "POST", "/orders/"+orderID+"/cancel", a.customer, map[string]any{"reason": "running late"})
	s.must(http.StatusAccepted, s.orders.server.URL, "POST", "/orders/"+orderID+"/cancel", a.customer, nil)
	s.pump()

	o := s.orderStatus(a, orderID)
	if o["status"] != "cancelled" || o["cancel_reason"] != "customer" || o["cancellation_fee_minor"] != float64(500) {
		t.Fatalf("order = %v", o)
	}
	earnings := s.must(http.StatusOK, s.couriers.server.URL, "GET", "/couriers/me/earnings", courierTok, nil)
	if earnings["total_minor"] != float64(400) {
		t.Fatalf("compensation = %v", earnings)
	}
	if me := s.must(http.StatusOK, s.couriers.server.URL, "GET", "/couriers/me", courierTok, nil); me["status"] != "available" {
		t.Fatalf("courier = %v", me)
	}
	s.must(http.StatusConflict, s.dispatch.server.URL, "POST", "/deliveries/"+orderID+"/pickup", courierTok, nil)
}

func TestCourierOffShiftBeforeReservation(t *testing.T) {
	s := newSystem(t)
	a := s.actors()
	courierTok, _ := s.onShiftCourier(a)
	s.pump()
	orderID := s.confirmedOrder(a)
	s.pump()
	s.runOffers()
	offer := s.must(http.StatusOK, s.dispatch.server.URL, "GET", "/offers/current", courierTok, nil)

	s.must(http.StatusOK, s.couriers.server.URL, "POST", "/couriers/me/shift/end", courierTok, nil)
	s.must(http.StatusOK, s.dispatch.server.URL, "POST", "/offers/"+offer["id"].(string)+"/accept", courierTok, nil)
	s.pump()

	if st := s.scalar(s.dispatch.pool, `SELECT status FROM deliveries WHERE id = $1`, uuid.MustParse(orderID)); st != "searching" {
		t.Fatalf("delivery status = %v, want searching", st)
	}
	if st := s.orderStatus(a, orderID)["status"]; st != "confirmed" {
		t.Fatalf("order status = %v, want confirmed", st)
	}
	if n := s.scalar(s.orders.pool, `SELECT count(*) FROM inbox WHERE consumer = 'orders-on-DISPATCH'`); n != int64(0) {
		t.Fatalf("orders consumed %v delivery events, want none", n)
	}
}

func TestDuplicateDeliveryThroughNATSHasOneEffect(t *testing.T) {
	s := newSystem(t)
	a := s.actors()
	orderID, _, _ := s.assignedOrder(a)
	before := s.orderStatus(a, orderID)["version"]

	var payload []byte
	if err := s.dispatch.pool.QueryRow(context.Background(),
		`SELECT payload FROM outbox WHERE payload->>'type' = 'delivery.assigned' AND payload->>'aggregate_id' = $1`, orderID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := s.js.Publish(context.Background(), "dispatch.delivery.assigned", payload); err != nil {
			t.Fatal(err)
		}
	}
	s.exec(s.dispatch.pool, `UPDATE outbox SET published_at = NULL`)
	s.pump()

	if after := s.orderStatus(a, orderID)["version"]; after != before {
		t.Fatalf("order version %v -> %v after duplicates", before, after)
	}
	if n := s.scalar(s.orders.pool, `SELECT count(*) FROM dead_letters`); n != int64(0) {
		t.Fatalf("dead letters = %v", n)
	}
}

func TestOpsEndpoints(t *testing.T) {
	s := newSystem(t)
	a := s.actors()
	stats := s.must(http.StatusOK, s.orders.server.URL, "GET", "/ops/outbox/stats", a.ops, nil)
	if _, ok := stats["unpublished"]; !ok {
		t.Fatalf("stats = %v", stats)
	}
	s.must(http.StatusOK, s.dispatch.server.URL, "GET", "/ops/dead-letters", a.ops, nil)
	s.must(http.StatusForbidden, s.couriers.server.URL, "GET", "/ops/dead-letters", a.customer, nil)
	s.must(http.StatusNotFound, s.couriers.server.URL, "POST", "/ops/dead-letters/"+uuid.NewString()+"/replay", a.ops, nil)
	if status, _ := s.call(s.orders.server.URL, "GET", "/orders", "not-a-token", nil); status != http.StatusUnauthorized {
		t.Fatalf("bad token status = %d", status)
	}
}
