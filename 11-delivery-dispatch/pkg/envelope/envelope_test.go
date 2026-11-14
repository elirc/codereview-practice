package envelope

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func validJSON() string {
	return `{
		"id": "6f1c1f0e-8a52-4c0e-9d7e-2b1b8f6f3a10",
		"type": "delivery.assigned",
		"schema_version": 1,
		"occurred_at": "2026-03-01T12:00:00Z",
		"aggregate_type": "delivery",
		"aggregate_id": "9b8f1d8e-3b4e-4f8f-a4b4-1f6d2c3b4a59",
		"sequence": 3,
		"request_id": "req-1",
		"data": {"delivery_id": "9b8f1d8e-3b4e-4f8f-a4b4-1f6d2c3b4a59"},
		"producer_hint": "ignored"
	}`
}

func TestDecodeAcceptsValidEnvelopeAndIgnoresUnknownFields(t *testing.T) {
	e, err := Decode([]byte(validJSON()))
	if err != nil {
		t.Fatal(err)
	}
	if e.Type != "delivery.assigned" || e.Sequence != 3 || e.SchemaVersion != 1 {
		t.Fatalf("decoded %+v", e)
	}
	if !e.OccurredAt.Equal(time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("occurred_at = %v", e.OccurredAt)
	}
}

func TestDecodeRejectsInvalidEnvelopes(t *testing.T) {
	tests := map[string][2]string{
		"not json":            {`{`, `{`},
		"nil id":              {`"6f1c1f0e-8a52-4c0e-9d7e-2b1b8f6f3a10"`, `"00000000-0000-0000-0000-000000000000"`},
		"bad type":            {`"delivery.assigned"`, `"DeliveryAssigned"`},
		"zero schema version": {`"schema_version": 1`, `"schema_version": 0`},
		"missing occurred_at": {`"occurred_at": "2026-03-01T12:00:00Z",`, ``},
		"empty aggregate":     {`"aggregate_type": "delivery"`, `"aggregate_type": ""`},
		"zero sequence":       {`"sequence": 3`, `"sequence": 0`},
		"data not an object":  {`"data": {"delivery_id": "9b8f1d8e-3b4e-4f8f-a4b4-1f6d2c3b4a59"}`, `"data": [1]`},
	}
	for name, repl := range tests {
		t.Run(name, func(t *testing.T) {
			raw := strings.Replace(validJSON(), repl[0], repl[1], 1)
			if name == "not json" {
				raw = "{"
			}
			_, err := Decode([]byte(raw))
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestNewRoundTrips(t *testing.T) {
	id := uuid.New()
	at := time.Date(2026, 3, 1, 12, 0, 0, 0, time.FixedZone("WAT", 3600))
	e, err := New(id, "surge.updated", "zone", "lagos-ikeja", 2, at, "req-9", map[string]any{"zone_id": "lagos-ikeja", "multiplier_bps": 12500})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := e.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"occurred_at":"2026-03-01T11:00:00Z"`) {
		t.Fatalf("occurred_at not normalised to UTC: %s", raw)
	}
	back, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		MultiplierBps int `json:"multiplier_bps"`
	}
	if err := back.DecodeData(&data); err != nil || data.MultiplierBps != 12500 {
		t.Fatalf("data = %+v, err = %v", data, err)
	}
	if _, err := back.AggregateUUID(); err == nil {
		t.Fatal("zone ids are not UUIDs")
	}
}
