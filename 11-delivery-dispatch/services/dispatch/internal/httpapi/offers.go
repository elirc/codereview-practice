package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/dispatch/internal/store/db"
)

type offerResponse struct {
	ID         string         `json:"id"`
	DeliveryID string         `json:"delivery_id"`
	Status     string         `json:"status"`
	DistanceM  float64        `json:"distance_m"`
	ExpiresAt  time.Time      `json:"expires_at"`
	Pickup     envelope.Point `json:"pickup"`
	Dropoff    envelope.Point `json:"dropoff"`
	ReadyAt    time.Time      `json:"ready_at"`
}

func offerJSON(o db.Offer, d db.Delivery) offerResponse {
	return offerResponse{
		ID:         o.ID.String(),
		DeliveryID: o.DeliveryID.String(),
		Status:     o.Status,
		DistanceM:  o.DistanceM,
		ExpiresAt:  o.ExpiresAt.UTC(),
		Pickup:     envelope.Point{Lon: d.PickupLon, Lat: d.PickupLat},
		Dropoff:    envelope.Point{Lon: d.DropoffLon, Lat: d.DropoffLat},
		ReadyAt:    d.ReadyAt.UTC(),
	}
}

func (h *Handler) currentOffer(w http.ResponseWriter, r *http.Request) error {
	od, err := h.svc.CurrentOffer(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, offerJSON(od.Offer, od.Delivery))
	return nil
}

func (h *Handler) acceptOffer(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	d, err := h.svc.AcceptOffer(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, deliveryJSON(d))
	return nil
}

func (h *Handler) declineOffer(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	o, err := h.svc.DeclineOffer(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": o.ID.String(), "status": o.Status})
	return nil
}
