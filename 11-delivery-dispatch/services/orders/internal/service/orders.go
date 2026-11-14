package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

// OrderDetail is an order with its status history.
type OrderDetail struct {
	Order   db.Order
	History []db.OrderStatusHistory
}

// PlaceOrder turns the caller's quote into an order. It returns the order and
// whether it was created by this call; a repeated call with the same client
// order key and quote returns the existing order.
func (s *Service) PlaceOrder(ctx context.Context, quoteID uuid.UUID, clientOrderKey string) (db.Order, bool, error) {
	p, err := auth.Require(ctx, auth.RoleCustomer)
	if err != nil {
		return db.Order{}, false, err
	}
	var out db.Order
	var created bool
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.LockCustomer(ctx, pgxtx.AdvisoryKey(p.Subject)); err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		existing, err := q.GetOrderByClientKey(ctx, db.GetOrderByClientKeyParams{CustomerID: p.Subject, ClientOrderKey: clientOrderKey})
		if err == nil {
			if existing.QuoteID != quoteID {
				return apperr.Unprocessable("idempotency_key_reused", "This client_order_key was already used for a different quote.")
			}
			out = existing
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load order by key: %w", err)
		}

		quote, err := q.GetQuoteForUpdate(ctx, quoteID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && quote.CustomerID != p.Subject) {
			return apperr.NotFound()
		}
		if err != nil {
			return fmt.Errorf("load quote: %w", err)
		}
		now := s.clock.Now()
		if !domain.QuoteUsable(quote.ExpiresAt, now) {
			return apperr.Unprocessable("quote_expired", "The quote has expired; request a new one.")
		}
		orderID := s.ids.NewID()
		marked, err := q.MarkQuoteUsed(ctx, db.MarkQuoteUsedParams{OrderID: orderID, ID: quote.ID})
		if err != nil {
			return fmt.Errorf("mark quote used: %w", err)
		}
		if marked == 0 {
			return apperr.Conflict("quote_already_used", "The quote has already been used for an order.")
		}
		active, err := q.CountActiveOrders(ctx, p.Subject)
		if err != nil {
			return fmt.Errorf("count active orders: %w", err)
		}
		if active >= s.cfg.MaxActiveOrders {
			return apperr.Unprocessable("too_many_active_orders", "You already have the maximum number of active orders.").
				WithDetails(map[string]any{"max_active_orders": s.cfg.MaxActiveOrders})
		}
		restaurant, err := q.GetRestaurant(ctx, quote.RestaurantID)
		if err != nil {
			return fmt.Errorf("load restaurant: %w", err)
		}
		o, err := q.InsertOrder(ctx, db.InsertOrderParams{
			ID:               orderID,
			CustomerID:       p.Subject,
			RestaurantID:     restaurant.ID,
			ZoneID:           restaurant.ZoneID,
			QuoteID:          quote.ID,
			ClientOrderKey:   clientOrderKey,
			Items:            quote.Items,
			SubtotalMinor:    quote.SubtotalMinor,
			DeliveryFeeMinor: quote.DeliveryFeeMinor,
			SurgeBps:         quote.SurgeBps,
			TotalMinor:       quote.TotalMinor,
			PickupLon:        restaurant.Lon,
			PickupLat:        restaurant.Lat,
			DropoffLon:       quote.DropoffLon,
			DropoffLat:       quote.DropoffLat,
			ConfirmDeadline:  now.Add(s.cfg.ConfirmTimeout),
			CreatedAt:        now,
		})
		if err != nil {
			return fmt.Errorf("insert order: %w", err)
		}
		if err := q.InsertOrderHistory(ctx, db.InsertOrderHistoryParams{
			OrderID: o.ID, Version: o.Version, Status: o.Status, At: now, Cause: "placed",
		}); err != nil {
			return fmt.Errorf("insert order history: %w", err)
		}
		out = o
		created = true
		return nil
	})
	if err != nil {
		return db.Order{}, false, err
	}
	return out, created, nil
}

// canSee reports whether p may read o.
func canSee(p auth.Principal, o db.Order) bool {
	switch p.Role {
	case auth.RoleOps:
		return true
	case auth.RoleCustomer:
		return o.CustomerID == p.Subject
	case auth.RoleRestaurant:
		return p.RestaurantID.Valid && o.RestaurantID == p.RestaurantID.UUID
	default:
		return false
	}
}

// GetOrder returns an order the caller may see, with its history.
func (s *Service) GetOrder(ctx context.Context, id uuid.UUID) (OrderDetail, error) {
	p, err := auth.Require(ctx, auth.RoleCustomer, auth.RoleRestaurant, auth.RoleOps)
	if err != nil {
		return OrderDetail{}, err
	}
	o, err := s.q.GetOrder(ctx, id)
	if err != nil {
		return OrderDetail{}, notFoundIfNoRows(err)
	}
	if !canSee(p, o) {
		return OrderDetail{}, apperr.NotFound()
	}
	h, err := s.q.ListOrderHistory(ctx, id)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("load history: %w", err)
	}
	return OrderDetail{Order: o, History: h}, nil
}

// ListOrders returns the most recent orders the caller may see, optionally
// filtered by status.
func (s *Service) ListOrders(ctx context.Context, status *string) ([]db.Order, error) {
	p, err := auth.Require(ctx, auth.RoleCustomer, auth.RoleRestaurant, auth.RoleOps)
	if err != nil {
		return nil, err
	}
	var orders []db.Order
	switch p.Role {
	case auth.RoleCustomer:
		orders, err = s.q.ListOrdersForCustomer(ctx, db.ListOrdersForCustomerParams{CustomerID: p.Subject, Status: status})
	case auth.RoleRestaurant:
		orders, err = s.q.ListOrdersForRestaurant(ctx, db.ListOrdersForRestaurantParams{RestaurantID: p.RestaurantID.UUID, Status: status})
	default:
		orders, err = s.q.ListOrders(ctx, status)
	}
	if err != nil {
		return nil, fmt.Errorf("list orders: %w", err)
	}
	return orders, nil
}

// save writes the mutable fields of after over before, increments the
// version and records a history row. It returns the stored order.
func (s *Service) save(ctx context.Context, q *db.Queries, before, after db.Order, cause string, now time.Time) (db.Order, error) {
	n, err := q.UpdateOrder(ctx, db.UpdateOrderParams{
		Status:                after.Status,
		ReadyAt:               after.ReadyAt,
		CourierID:             after.CourierID,
		EtaMinutes:            after.EtaMinutes,
		DeliverySequence:      after.DeliverySequence,
		CancelRequest:         after.CancelRequest,
		CancelRequestedBy:     after.CancelRequestedBy,
		CancelRequestedAt:     after.CancelRequestedAt,
		CancelRequestAttempts: after.CancelRequestAttempts,
		CancelRetryAt:         after.CancelRetryAt,
		CancelNote:            after.CancelNote,
		CancelReason:          after.CancelReason,
		CancellationFeeMinor:  after.CancellationFeeMinor,
		RefundMinor:           after.RefundMinor,
		UpdatedAt:             now,
		ID:                    before.ID,
		ExpectedVersion:       before.Version,
		ExpectedStatus:        before.Status,
	})
	if err != nil {
		return db.Order{}, fmt.Errorf("update order: %w", err)
	}
	if n != 1 {
		return db.Order{}, apperr.Conflict("invalid_state", "The order changed while it was being updated.")
	}
	after.Version = before.Version + 1
	after.UpdatedAt = now
	if err := q.InsertOrderHistory(ctx, db.InsertOrderHistoryParams{
		OrderID: after.ID, Version: after.Version, Status: after.Status, At: now, Cause: cause,
	}); err != nil {
		return db.Order{}, fmt.Errorf("insert order history: %w", err)
	}
	return after, nil
}

// lockVisible loads and locks an order the caller may see.
func (s *Service) lockVisible(ctx context.Context, q *db.Queries, p auth.Principal, id uuid.UUID) (db.Order, error) {
	o, err := q.GetOrderForUpdate(ctx, id)
	if err != nil {
		return db.Order{}, notFoundIfNoRows(err)
	}
	if !canSee(p, o) {
		return db.Order{}, apperr.NotFound()
	}
	return o, nil
}

// cancelled returns o cancelled for reason with the given fee.
func cancelled(o db.Order, reason string, feeMinor int64) db.Order {
	r := reason
	o.Status = domain.StatusCancelled
	o.CancelReason = &r
	o.CancellationFeeMinor = feeMinor
	o.RefundMinor = o.TotalMinor - feeMinor
	o.CancelRetryAt = nil
	return o
}
