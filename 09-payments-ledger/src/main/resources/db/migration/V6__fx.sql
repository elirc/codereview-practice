CREATE TABLE fx_rates (
    id            uuid PRIMARY KEY,
    sell_currency text           NOT NULL,
    buy_currency  text           NOT NULL,
    mid_rate      numeric(20, 8) NOT NULL,
    spread_bps    integer        NOT NULL,
    published_at  timestamptz    NOT NULL,
    published_by  uuid           NOT NULL REFERENCES api_keys (id),
    CONSTRAINT fx_rates_currency_check CHECK (
        sell_currency IN ('USD', 'EUR', 'GBP', 'JPY', 'KWD') AND buy_currency IN ('USD', 'EUR', 'GBP', 'JPY', 'KWD')
    ),
    CONSTRAINT fx_rates_pair_check CHECK (sell_currency <> buy_currency),
    CONSTRAINT fx_rates_mid_rate_check CHECK (mid_rate > 0),
    CONSTRAINT fx_rates_spread_check CHECK (spread_bps >= 0 AND spread_bps < 10000)
);

CREATE INDEX fx_rates_pair_published_idx ON fx_rates (sell_currency, buy_currency, published_at DESC);

CREATE TABLE fx_quotes (
    id            uuid PRIMARY KEY,
    owner_id      uuid           NOT NULL,
    rate_id       uuid           NOT NULL REFERENCES fx_rates (id),
    sell_currency text           NOT NULL,
    buy_currency  text           NOT NULL,
    sell_minor    bigint         NOT NULL,
    buy_minor     bigint         NOT NULL,
    mid_buy_minor bigint         NOT NULL,
    mid_rate      numeric(20, 8) NOT NULL,
    customer_rate numeric(20, 8) NOT NULL,
    expires_at    timestamptz    NOT NULL,
    created_at    timestamptz    NOT NULL,
    used_entry_id uuid REFERENCES journal_entries (id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fx_quotes_used_entry_key UNIQUE (used_entry_id),
    CONSTRAINT fx_quotes_amounts_check CHECK (sell_minor > 0 AND buy_minor > 0 AND mid_buy_minor >= buy_minor)
);
