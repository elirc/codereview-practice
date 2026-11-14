package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/httpx"
)

type surgeResponse struct {
	ZoneID        string    `json:"zone_id"`
	MultiplierBps int32     `json:"multiplier_bps"`
	Version       int64     `json:"version"`
	ComputedAt    time.Time `json:"computed_at"`
}

func (h *Handler) zoneSurge(w http.ResponseWriter, r *http.Request) error {
	zone := strings.TrimSpace(chi.URLParam(r, "zone_id"))
	if zone == "" || len(zone) > 64 {
		return apperr.Validation([]apperr.FieldError{{Path: "zone_id", Message: "must be 1 to 64 characters"}})
	}
	z, err := h.svc.ZoneSurge(r.Context(), zone)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, surgeResponse{
		ZoneID:        z.ZoneID,
		MultiplierBps: z.MultiplierBps,
		Version:       z.Version,
		ComputedAt:    z.ComputedAt.UTC(),
	})
	return nil
}
