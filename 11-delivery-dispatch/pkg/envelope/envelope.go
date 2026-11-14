// Package envelope defines the JSON event envelope carried on every subject.
package envelope

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
)

// Envelope is the wrapper around every event's data.
type Envelope struct {
	ID            uuid.UUID       `json:"id"`
	Type          string          `json:"type"`
	SchemaVersion int             `json:"schema_version"`
	OccurredAt    time.Time       `json:"occurred_at"`
	AggregateType string          `json:"aggregate_type"`
	AggregateID   string          `json:"aggregate_id"`
	Sequence      int64           `json:"sequence"`
	RequestID     string          `json:"request_id"`
	Data          json.RawMessage `json:"data"`
}

// Point is a coordinate pair as it appears in event data.
type Point struct {
	Lon float64 `json:"lon"`
	Lat float64 `json:"lat"`
}

// ErrInvalid wraps every validation failure returned by Decode and Validate.
var ErrInvalid = errors.New("invalid envelope")

var typePattern = regexp.MustCompile(`^[a-z][a-z_]*\.[a-z][a-z_]*$`)

// New builds an envelope with schema version 1 around data.
func New(id uuid.UUID, eventType, aggregateType, aggregateID string, sequence int64, occurredAt time.Time, requestID string, data any) (Envelope, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return Envelope{}, fmt.Errorf("marshal %s data: %w", eventType, err)
	}
	e := Envelope{
		ID:            id,
		Type:          eventType,
		SchemaVersion: 1,
		OccurredAt:    occurredAt.UTC(),
		AggregateType: aggregateType,
		AggregateID:   aggregateID,
		Sequence:      sequence,
		RequestID:     requestID,
		Data:          raw,
	}
	if err := e.Validate(); err != nil {
		return Envelope{}, err
	}
	return e, nil
}

// Decode parses and validates an envelope. Unknown top-level fields are ignored.
func Decode(raw []byte) (Envelope, error) {
	var e Envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		return Envelope{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if err := e.Validate(); err != nil {
		return Envelope{}, err
	}
	return e, nil
}

// Validate checks the envelope's required fields.
func (e Envelope) Validate() error {
	switch {
	case e.ID == uuid.Nil:
		return fmt.Errorf("%w: id is required", ErrInvalid)
	case !typePattern.MatchString(e.Type):
		return fmt.Errorf("%w: type %q is not noun.past_participle", ErrInvalid, e.Type)
	case e.SchemaVersion < 1:
		return fmt.Errorf("%w: schema_version must be at least 1", ErrInvalid)
	case e.OccurredAt.IsZero():
		return fmt.Errorf("%w: occurred_at is required", ErrInvalid)
	case e.AggregateType == "":
		return fmt.Errorf("%w: aggregate_type is required", ErrInvalid)
	case e.AggregateID == "":
		return fmt.Errorf("%w: aggregate_id is required", ErrInvalid)
	case e.Sequence < 1:
		return fmt.Errorf("%w: sequence must be at least 1", ErrInvalid)
	}
	trimmed := bytes.TrimSpace(e.Data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: data must be a JSON object", ErrInvalid)
	}
	return nil
}

// Marshal returns the envelope's JSON encoding.
func (e Envelope) Marshal() ([]byte, error) {
	return json.Marshal(e)
}

// DecodeData unmarshals the envelope's data into dst, ignoring unknown fields.
func (e Envelope) DecodeData(dst any) error {
	if err := json.Unmarshal(e.Data, dst); err != nil {
		return fmt.Errorf("decode %s data: %w", e.Type, err)
	}
	return nil
}

// AggregateUUID returns the aggregate id parsed as a UUID.
func (e Envelope) AggregateUUID() (uuid.UUID, error) {
	id, err := uuid.Parse(e.AggregateID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("%w: aggregate_id %q is not a UUID", ErrInvalid, e.AggregateID)
	}
	return id, nil
}
