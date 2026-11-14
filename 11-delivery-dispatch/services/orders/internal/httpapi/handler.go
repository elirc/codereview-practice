// Package httpapi exposes the orders service over HTTP.
package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/orders/internal/service"
)

// Handler serves the orders endpoints.
type Handler struct {
	svc      *service.Service
	logger   *slog.Logger
	currency string
}

// New returns a Handler for svc.
func New(svc *service.Service, currency string, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger, currency: currency}
}

// Mount registers the authenticated orders routes on r.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/restaurants", h.wrap(h.listRestaurants))
	r.Post("/quotes", h.wrap(h.createQuote))
	r.Post("/orders", h.wrap(h.placeOrder))
	r.Get("/orders", h.wrap(h.listOrders))
	r.Get("/orders/{id}", h.wrap(h.getOrder))
	r.Post("/orders/{id}/confirm", h.wrap(h.confirmOrder))
	r.Post("/orders/{id}/reject", h.wrap(h.rejectOrder))
	r.Post("/orders/{id}/cancel", h.wrap(h.cancelOrder))
}

func (h *Handler) wrap(fn httpx.HandlerFunc) http.HandlerFunc {
	return httpx.Wrap(h.logger, fn)
}
