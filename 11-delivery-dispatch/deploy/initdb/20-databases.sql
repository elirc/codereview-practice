-- Runs once, as the postgres superuser, when the data directory is first created.
-- Each service gets its own role and database; PostGIS is installed where a
-- service stores courier positions.

CREATE ROLE dd_orders LOGIN PASSWORD 'dd_orders';
CREATE ROLE dd_dispatch LOGIN PASSWORD 'dd_dispatch';
CREATE ROLE dd_couriers LOGIN PASSWORD 'dd_couriers';

CREATE DATABASE dd_orders OWNER dd_orders;
CREATE DATABASE dd_dispatch OWNER dd_dispatch;
CREATE DATABASE dd_couriers OWNER dd_couriers;

\connect dd_dispatch
CREATE EXTENSION IF NOT EXISTS postgis;

\connect dd_couriers
CREATE EXTENSION IF NOT EXISTS postgis;
