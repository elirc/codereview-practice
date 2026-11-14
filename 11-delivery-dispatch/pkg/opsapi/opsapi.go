// Package opsapi serves the ops endpoints every service exposes: dead
// letters, dead-letter replay and outbox statistics.
package opsapi

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/pkg/inbox"
	"deliverydispatch/pkg/outbox"
)

// Handler serves the ops endpoints of one service.
type Handler struct {
	pool       *pgxpool.Pool
	processors map[string]*inbox.Processor
	logger     *slog.Logger
}

// New returns a Handler that replays dead letters through the given processors.
func New(pool *pgxpool.Pool, processors []*inbox.Processor, logger *slog.Logger) *Handler {
	byName := make(map[string]*inbox.Processor, len(processors))
	for _, p := range processors {
		byName[p.Consumer()] = p
	}
	return &Handler{pool: pool, processors: byName, logger: logger}
}

// Mount registers the ops routes on an authenticated router.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/ops/dead-letters", httpx.Wrap(h.logger, h.listDeadLetters))
	r.Post("/ops/dead-letters/{id}/replay", httpx.Wrap(h.logger, h.replay))
	r.Get("/ops/outbox/stats", httpx.Wrap(h.logger, h.outboxStats))
}

func (h *Handler) listDeadLetters(w http.ResponseWriter, r *http.Request) error {
	if _, err := auth.Require(r.Context(), auth.RoleOps); err != nil {
		return err
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			return apperr.Validation([]apperr.FieldError{{Path: "limit", Message: "must be an integer between 1 and 200"}})
		}
		limit = n
	}
	letters, err := inbox.ListDeadLetters(r.Context(), h.pool, limit)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"dead_letters": letters})
	return nil
}

func (h *Handler) replay(w http.ResponseWriter, r *http.Request) error {
	if _, err := auth.Require(r.Context(), auth.RoleOps); err != nil {
		return err
	}
	id, err := httpx.ParseUUID("id", chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	consumer, err := inbox.ConsumerOf(r.Context(), h.pool, id)
	if err != nil {
		return err
	}
	p, ok := h.processors[consumer]
	if !ok {
		return apperr.NotFound()
	}
	if err := p.Replay(r.Context(), id); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": id.String(), "consumer": consumer, "replayed": true})
	return nil
}

func (h *Handler) outboxStats(w http.ResponseWriter, r *http.Request) error {
	if _, err := auth.Require(r.Context(), auth.RoleOps); err != nil {
		return err
	}
	s, err := outbox.ReadStats(r.Context(), h.pool)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, s)
	return nil
}
