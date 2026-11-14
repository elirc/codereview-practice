package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/envelope"
	"deliverydispatch/pkg/geo"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/service"
	"deliverydispatch/services/orders/internal/store/db"
)

type restaurantResponse struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	ZoneID      string  `json:"zone_id"`
	Lon         float64 `json:"lon"`
	Lat         float64 `json:"lat"`
	PrepMinutes int32   `json:"prep_minutes"`
}

func (h *Handler) listRestaurants(w http.ResponseWriter, r *http.Request) error {
	rs, err := h.svc.ListRestaurants(r.Context())
	if err != nil {
		return err
	}
	out := make([]restaurantResponse, 0, len(rs))
	for _, x := range rs {
		out = append(out, restaurantResponse{
			ID:          x.ID.String(),
			Name:        x.Name,
			ZoneID:      x.ZoneID,
			Lon:         x.Lon,
			Lat:         x.Lat,
			PrepMinutes: x.PrepMinutes,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"restaurants": out})
	return nil
}

type quoteRequest struct {
	RestaurantID string          `json:"restaurant_id"`
	Items        []domain.Item   `json:"items"`
	Dropoff      *envelope.Point `json:"dropoff"`
}

func (q quoteRequest) validate() (service.QuoteRequest, error) {
	var f apperr.Fields
	rid, err := httpx.ParseUUID("restaurant_id", q.RestaurantID)
	if err != nil {
		f.Add("restaurant_id", "must be a UUID")
	}
	f.Check(len(q.Items) >= domain.MinItems && len(q.Items) <= domain.MaxItems, "items",
		fmt.Sprintf("must contain between %d and %d items", domain.MinItems, domain.MaxItems))
	for i, it := range q.Items {
		name := strings.TrimSpace(it.Name)
		f.Check(name != "" && len(name) <= 200, fmt.Sprintf("items[%d].name", i), "must be 1 to 200 characters")
		f.Check(it.Quantity >= domain.MinQuantity && it.Quantity <= domain.MaxQuantity, fmt.Sprintf("items[%d].quantity", i),
			fmt.Sprintf("must be between %d and %d", domain.MinQuantity, domain.MaxQuantity))
		f.Check(it.UnitPriceMinor > 0 && it.UnitPriceMinor <= domain.MaxUnitPriceMinor, fmt.Sprintf("items[%d].unit_price_minor", i),
			fmt.Sprintf("must be between 1 and %d", domain.MaxUnitPriceMinor))
	}
	if q.Dropoff == nil {
		f.Add("dropoff", "is required")
	} else {
		f.Check(geo.ValidLon(q.Dropoff.Lon), "dropoff.lon", "must be between -180 and 180")
		f.Check(geo.ValidLat(q.Dropoff.Lat), "dropoff.lat", "must be between -90 and 90")
	}
	if err := f.Err(); err != nil {
		return service.QuoteRequest{}, err
	}
	items := make([]domain.Item, len(q.Items))
	for i, it := range q.Items {
		items[i] = domain.Item{Name: strings.TrimSpace(it.Name), Quantity: it.Quantity, UnitPriceMinor: it.UnitPriceMinor}
	}
	return service.QuoteRequest{RestaurantID: rid, Items: items, DropoffLon: q.Dropoff.Lon, DropoffLat: q.Dropoff.Lat}, nil
}

type quoteResponse struct {
	ID               string          `json:"id"`
	RestaurantID     string          `json:"restaurant_id"`
	Items            json.RawMessage `json:"items"`
	SubtotalMinor    int64           `json:"subtotal_minor"`
	DistanceM        int32           `json:"distance_m"`
	DeliveryFeeMinor int64           `json:"delivery_fee_minor"`
	SurgeBps         int32           `json:"surge_bps"`
	TotalMinor       int64           `json:"total_minor"`
	Currency         string          `json:"currency"`
	EtaMinutes       int32           `json:"eta_minutes"`
	Dropoff          envelope.Point  `json:"dropoff"`
	ExpiresAt        time.Time       `json:"expires_at"`
	Used             bool            `json:"used"`
}

func (h *Handler) createQuote(w http.ResponseWriter, r *http.Request) error {
	var body quoteRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	req, err := body.validate()
	if err != nil {
		return err
	}
	q, err := h.svc.CreateQuote(r.Context(), req)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, h.quoteResponse(q))
	return nil
}

func (h *Handler) quoteResponse(q db.Quote) quoteResponse {
	return quoteResponse{
		ID:               q.ID.String(),
		RestaurantID:     q.RestaurantID.String(),
		Items:            json.RawMessage(q.Items),
		SubtotalMinor:    q.SubtotalMinor,
		DistanceM:        q.DistanceM,
		DeliveryFeeMinor: q.DeliveryFeeMinor,
		SurgeBps:         q.SurgeBps,
		TotalMinor:       q.TotalMinor,
		Currency:         h.currency,
		EtaMinutes:       q.EtaMinutes,
		Dropoff:          envelope.Point{Lon: q.DropoffLon, Lat: q.DropoffLat},
		ExpiresAt:        q.ExpiresAt.UTC(),
		Used:             q.UsedOrderID.Valid,
	}
}
