-- +goose Up
CREATE INDEX courier_earnings_delivery_idx ON courier_earnings (delivery_id);

-- +goose Down
DROP INDEX courier_earnings_delivery_idx;
