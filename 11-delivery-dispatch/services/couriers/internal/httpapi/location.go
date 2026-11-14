package httpapi

import (
	"net/http"
	"time"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/geo"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/couriers/internal/service"
)

type locationRequest struct {
	Lon        *float64   `json:"lon"`
	Lat        *float64   `json:"lat"`
	RecordedAt *time.Time `json:"recorded_at"`
}

func (h *Handler) reportLocation(w http.ResponseWriter, r *http.Request) error {
	var body locationRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	var f apperr.Fields
	f.Check(body.Lon != nil && geo.ValidLon(*body.Lon), "lon", "must be between -180 and 180")
	f.Check(body.Lat != nil && geo.ValidLat(*body.Lat), "lat", "must be between -90 and 90")
	f.Check(body.RecordedAt != nil, "recorded_at", "is required")
	if err := f.Err(); err != nil {
		return err
	}
	if err := h.svc.ReportLocation(r.Context(), service.Ping{Lon: *body.Lon, Lat: *body.Lat, RecordedAt: *body.RecordedAt}); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
