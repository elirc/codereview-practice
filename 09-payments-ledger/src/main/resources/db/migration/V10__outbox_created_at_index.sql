-- The outbox purge selects rows by creation time, which never changes after insert.
DROP INDEX outbox_published_at_idx;

CREATE INDEX outbox_created_at_idx ON outbox (created_at);
