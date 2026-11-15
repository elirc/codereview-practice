-- +goose Up
CREATE INDEX courier_view_available_position_gix ON courier_view
    USING gist ((ST_SetSRID(ST_MakePoint(lon, lat), 4326)))
    WHERE status = 'available';

-- +goose Down
DROP INDEX courier_view_available_position_gix;
