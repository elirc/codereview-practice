// Package httpapi exposes the couriers service over HTTP.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/couriers/internal/domain"
	"deliverydispatch/services/couriers/internal/service"
	"deliverydispatch/services/couriers/internal/store/db"
)

// Handler serves the couriers endpoints.
type Handler struct {
	svc    *service.Service
	logger *slog.Logger
}

// New returns a Handler for svc.
func New(svc *service.Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// Mount registers the authenticated couriers routes on r.
func (h *Handler) Mount(r chi.Router) {
	r.Post("/couriers", h.wrap(h.createCourier))
	r.Get("/couriers/me", h.wrap(h.me))
	r.Post("/couriers/me/shift/start", h.wrap(h.startShift))
	r.Post("/couriers/me/shift/end", h.wrap(h.endShift))
	r.Post("/couriers/me/location", h.wrap(h.reportLocation))
	r.Get("/couriers/me/earnings", h.wrap(h.myEarnings))
	r.Get("/couriers/me/earnings/{delivery_id}", h.wrap(h.myDeliveryEarnings))
	r.Get("/couriers/{id}/earnings", h.wrap(h.courierEarnings))
	r.Get("/couriers/{id}", h.wrap(h.byID(h.svc.GetCourier)))
	r.Post("/couriers/{id}/suspend", h.wrap(h.byID(h.svc.Suspend)))
	r.Post("/couriers/{id}/reinstate", h.wrap(h.byID(h.svc.Reinstate)))
}

func (h *Handler) wrap(fn httpx.HandlerFunc) http.HandlerFunc {
	return httpx.Wrap(h.logger, fn)
}

type positionResponse struct {
	Lon        float64   `json:"lon"`
	Lat        float64   `json:"lat"`
	RecordedAt time.Time `json:"recorded_at"`
}

type courierResponse struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	Vehicle          string            `json:"vehicle"`
	Status           string            `json:"status"`
	Suspended        bool              `json:"suspended"`
	ZoneID           *string           `json:"zone_id"`
	ActiveDeliveryID *string           `json:"active_delivery_id"`
	StatusVersion    int64             `json:"status_version"`
	Position         *positionResponse `json:"position"`
}

func courierJSON(c db.Courier) courierResponse {
	resp := courierResponse{
		ID:            c.ID.String(),
		Name:          c.Name,
		Vehicle:       c.Vehicle,
		Status:        service.Status(c),
		Suspended:     c.Suspended,
		ZoneID:        c.ShiftZoneID,
		StatusVersion: c.StatusVersion,
	}
	if c.ActiveDeliveryID.Valid {
		id := c.ActiveDeliveryID.UUID.String()
		resp.ActiveDeliveryID = &id
	}
	if c.Lon != nil && c.Lat != nil && c.PositionAt != nil {
		resp.Position = &positionResponse{Lon: *c.Lon, Lat: *c.Lat, RecordedAt: c.PositionAt.UTC()}
	}
	return resp
}

type createCourierRequest struct {
	Name    string `json:"name"`
	Vehicle string `json:"vehicle"`
}

func (h *Handler) createCourier(w http.ResponseWriter, r *http.Request) error {
	var body createCourierRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	var f apperr.Fields
	name := strings.TrimSpace(body.Name)
	f.Check(name != "" && len(name) <= 200, "name", "must be 1 to 200 characters")
	f.Check(domain.ValidVehicle(body.Vehicle), "vehicle", "must be bike, scooter or car")
	if err := f.Err(); err != nil {
		return err
	}
	c, err := h.svc.CreateCourier(r.Context(), name, body.Vehicle)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, courierJSON(c))
	return nil
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) error {
	c, err := h.svc.Me(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, courierJSON(c))
	return nil
}

type startShiftRequest struct {
	ZoneID string `json:"zone_id"`
}

func (h *Handler) startShift(w http.ResponseWriter, r *http.Request) error {
	var body startShiftRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	zone := strings.TrimSpace(body.ZoneID)
	if zone == "" || len(zone) > 64 {
		return apperr.Validation([]apperr.FieldError{{Path: "zone_id", Message: "must be 1 to 64 characters"}})
	}
	c, err := h.svc.StartShift(r.Context(), zone)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, courierJSON(c))
	return nil
}

func (h *Handler) endShift(w http.ResponseWriter, r *http.Request) error {
	c, err := h.svc.EndShift(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, courierJSON(c))
	return nil
}

func (h *Handler) byID(fn func(context.Context, uuid.UUID) (db.Courier, error)) httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		c, err := fn(r.Context(), id)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, courierJSON(c))
		return nil
	}
}
