package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

type historyResponse struct {
	Version int64     `json:"version"`
	Status  string    `json:"status"`
	At      time.Time `json:"at"`
	Cause   string    `json:"cause"`
}

type orderResponse struct {
	ID                   string            `json:"id"`
	CustomerID           string            `json:"customer_id"`
	RestaurantID         string            `json:"restaurant_id"`
	ZoneID               string            `json:"zone_id"`
	QuoteID              string            `json:"quote_id"`
	ClientOrderKey       string            `json:"client_order_key"`
	Status               string            `json:"status"`
	Items                json.RawMessage   `json:"items"`
	SubtotalMinor        int64             `json:"subtotal_minor"`
	DeliveryFeeMinor     int64             `json:"delivery_fee_minor"`
	SurgeBps             int32             `json:"surge_bps"`
	TotalMinor           int64             `json:"total_minor"`
	Currency             string            `json:"currency"`
	Pickup               envelope.Point    `json:"pickup"`
	Dropoff              envelope.Point    `json:"dropoff"`
	ConfirmDeadline      time.Time         `json:"confirm_deadline"`
	ReadyAt              *time.Time        `json:"ready_at"`
	CourierID            *string           `json:"courier_id"`
	EtaMinutes           *int32            `json:"eta_minutes"`
	CancelRequest        string            `json:"cancel_request"`
	CancelRequestedBy    *string           `json:"cancel_requested_by"`
	CancelReason         *string           `json:"cancel_reason"`
	CancellationFeeMinor int64             `json:"cancellation_fee_minor"`
	RefundMinor          int64             `json:"refund_minor"`
	Version              int64             `json:"version"`
	CreatedAt            time.Time         `json:"created_at"`
	UpdatedAt            time.Time         `json:"updated_at"`
	History              []historyResponse `json:"history,omitempty"`
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func (h *Handler) orderResponse(o db.Order, history []db.OrderStatusHistory) orderResponse {
	resp := orderResponse{
		ID:                   o.ID.String(),
		CustomerID:           o.CustomerID.String(),
		RestaurantID:         o.RestaurantID.String(),
		ZoneID:               o.ZoneID,
		QuoteID:              o.QuoteID.String(),
		ClientOrderKey:       o.ClientOrderKey,
		Status:               o.Status,
		Items:                json.RawMessage(o.Items),
		SubtotalMinor:        o.SubtotalMinor,
		DeliveryFeeMinor:     o.DeliveryFeeMinor,
		SurgeBps:             o.SurgeBps,
		TotalMinor:           o.TotalMinor,
		Currency:             h.currency,
		Pickup:               envelope.Point{Lon: o.PickupLon, Lat: o.PickupLat},
		Dropoff:              envelope.Point{Lon: o.DropoffLon, Lat: o.DropoffLat},
		ConfirmDeadline:      o.ConfirmDeadline.UTC(),
		ReadyAt:              utcPtr(o.ReadyAt),
		EtaMinutes:           o.EtaMinutes,
		CancelRequest:        o.CancelRequest,
		CancelRequestedBy:    o.CancelRequestedBy,
		CancelReason:         o.CancelReason,
		CancellationFeeMinor: o.CancellationFeeMinor,
		RefundMinor:          o.RefundMinor,
		Version:              o.Version,
		CreatedAt:            o.CreatedAt.UTC(),
		UpdatedAt:            o.UpdatedAt.UTC(),
	}
	if o.CourierID.Valid {
		c := o.CourierID.UUID.String()
		resp.CourierID = &c
	}
	for _, x := range history {
		resp.History = append(resp.History, historyResponse{Version: x.Version, Status: x.Status, At: x.At.UTC(), Cause: x.Cause})
	}
	return resp
}

type placeOrderRequest struct {
	QuoteID        string `json:"quote_id"`
	ClientOrderKey string `json:"client_order_key"`
}

func (h *Handler) placeOrder(w http.ResponseWriter, r *http.Request) error {
	var body placeOrderRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	var f apperr.Fields
	quoteID, err := uuid.Parse(body.QuoteID)
	f.Check(err == nil, "quote_id", "must be a UUID")
	key := strings.TrimSpace(body.ClientOrderKey)
	f.Check(len(key) >= 8 && len(key) <= 64 && key == body.ClientOrderKey, "client_order_key", "must be 8 to 64 characters without surrounding spaces")
	if err := f.Err(); err != nil {
		return err
	}
	o, created, err := h.svc.PlaceOrder(r.Context(), quoteID, key)
	if err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.WriteJSON(w, status, h.orderResponse(o, nil))
	return nil
}

func (h *Handler) getOrder(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	d, err := h.svc.GetOrder(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, h.orderResponse(d.Order, d.History))
	return nil
}

func (h *Handler) listOrders(w http.ResponseWriter, r *http.Request) error {
	var status *string
	if v := r.URL.Query().Get("status"); v != "" {
		if !domain.ValidStatus(v) {
			return apperr.Validation([]apperr.FieldError{{Path: "status", Message: "is not a known order status"}})
		}
		status = &v
	}
	orders, err := h.svc.ListOrders(r.Context(), status)
	if err != nil {
		return err
	}
	out := make([]orderResponse, 0, len(orders))
	for _, o := range orders {
		out = append(out, h.orderResponse(o, nil))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"orders": out})
	return nil
}

func (h *Handler) transition(w http.ResponseWriter, r *http.Request, fn func(context.Context, uuid.UUID) (db.Order, error)) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	o, err := fn(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, h.orderResponse(o, nil))
	return nil
}

func (h *Handler) confirmOrder(w http.ResponseWriter, r *http.Request) error {
	return h.transition(w, r, h.svc.Confirm)
}

func (h *Handler) rejectOrder(w http.ResponseWriter, r *http.Request) error {
	return h.transition(w, r, h.svc.Reject)
}

type cancelRequest struct {
	Reason *string `json:"reason"`
}

func (h *Handler) cancelOrder(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var body cancelRequest
	if _, err := httpx.DecodeOptionalJSON(w, r, &body); err != nil {
		return err
	}
	var note *string
	if body.Reason != nil {
		n := strings.TrimSpace(*body.Reason)
		if len(n) > 500 {
			return apperr.Validation([]apperr.FieldError{{Path: "reason", Message: "must be at most 500 characters"}})
		}
		if n != "" {
			note = &n
		}
	}
	res, err := h.svc.Cancel(r.Context(), id, note)
	if err != nil {
		return err
	}
	status := http.StatusOK
	if res.Pending {
		status = http.StatusAccepted
	}
	httpx.WriteJSON(w, status, h.orderResponse(res.Order, nil))
	return nil
}
