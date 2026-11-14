package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/couriers/internal/service"
)

type earningResponse struct {
	ID          string    `json:"id"`
	DeliveryID  string    `json:"delivery_id"`
	Kind        string    `json:"kind"`
	AmountMinor int64     `json:"amount_minor"`
	CreatedAt   time.Time `json:"created_at"`
}

type earningsResponse struct {
	CourierID  string            `json:"courier_id"`
	TotalMinor int64             `json:"total_minor"`
	Currency   string            `json:"currency"`
	Earnings   []earningResponse `json:"earnings"`
}

func (h *Handler) earningsJSON(e service.Earnings) earningsResponse {
	out := earningsResponse{
		CourierID:  e.CourierID.String(),
		TotalMinor: e.TotalMinor,
		Currency:   h.svc.Currency(),
		Earnings:   make([]earningResponse, 0, len(e.Items)),
	}
	for _, x := range e.Items {
		out.Earnings = append(out.Earnings, earningResponse{
			ID:          x.ID.String(),
			DeliveryID:  x.DeliveryID.String(),
			Kind:        x.Kind,
			AmountMinor: x.AmountMinor,
			CreatedAt:   x.CreatedAt.UTC(),
		})
	}
	return out
}

func (h *Handler) myEarnings(w http.ResponseWriter, r *http.Request) error {
	e, err := h.svc.MyEarnings(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, h.earningsJSON(e))
	return nil
}

func (h *Handler) courierEarnings(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	e, err := h.svc.CourierEarnings(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, h.earningsJSON(e))
	return nil
}
