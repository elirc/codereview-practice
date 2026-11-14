// Package httpapi exposes the dispatch service over HTTP.
package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/dispatch/internal/service"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// Handler serves the dispatch endpoints.
type Handler struct {
	svc    *service.Service
	logger *slog.Logger
}

// New returns a Handler for svc.
func New(svc *service.Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Mount registers the authenticated dispatch routes on r.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/deliveries/{id}", h.wrap(h.getDelivery))
}

func (h *Handler) wrap(fn httpx.HandlerFunc) http.HandlerFunc {
	return httpx.Wrap(h.logger, fn)
}

type deliveryResponse struct {
	ID                 string         `json:"id"`
	ZoneID             string         `json:"zone_id"`
	Status             string         `json:"status"`
	Pickup             envelope.Point `json:"pickup"`
	Dropoff            envelope.Point `json:"dropoff"`
	ReadyAt            time.Time      `json:"ready_at"`
	DeliveryFeeMinor   int64          `json:"delivery_fee_minor"`
	SurgeBps           int32          `json:"surge_bps"`
	CourierID          *string        `json:"courier_id"`
	OffersMade         int32          `json:"offers_made"`
	SearchDeadline     time.Time      `json:"search_deadline"`
	ReserveDeadline    *time.Time     `json:"reserve_deadline"`
	EtaMinutes         *int32         `json:"eta_minutes"`
	CourierWasAssigned bool           `json:"courier_was_assigned"`
	CourierPayoutMinor *int64         `json:"courier_payout_minor"`
	PickedUpAt         *time.Time     `json:"picked_up_at"`
	DeliveredAt        *time.Time     `json:"delivered_at"`
	Version            int64          `json:"version"`
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func deliveryJSON(d db.Delivery) deliveryResponse {
	resp := deliveryResponse{
		ID:                 d.ID.String(),
		ZoneID:             d.ZoneID,
		Status:             d.Status,
		Pickup:             envelope.Point{Lon: d.PickupLon, Lat: d.PickupLat},
		Dropoff:            envelope.Point{Lon: d.DropoffLon, Lat: d.DropoffLat},
		ReadyAt:            d.ReadyAt.UTC(),
		DeliveryFeeMinor:   d.DeliveryFeeMinor,
		SurgeBps:           d.SurgeBps,
		OffersMade:         d.OffersMade,
		SearchDeadline:     d.SearchDeadline.UTC(),
		ReserveDeadline:    utcPtr(d.ReserveDeadline),
		EtaMinutes:         d.EtaMinutes,
		CourierWasAssigned: d.CourierWasAssigned,
		CourierPayoutMinor: d.CourierPayoutMinor,
		PickedUpAt:         utcPtr(d.PickedUpAt),
		DeliveredAt:        utcPtr(d.DeliveredAt),
		Version:            d.Version,
	}
	if d.CourierID.Valid {
		c := d.CourierID.UUID.String()
		resp.CourierID = &c
	}
	return resp
}

func (h *Handler) getDelivery(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	d, err := h.svc.GetDelivery(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, deliveryJSON(d))
	return nil
}
