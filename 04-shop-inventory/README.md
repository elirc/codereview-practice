# Shop Inventory and Orders

Back office and order API for a small single-currency shop. It manages products and stock,
takes storefront orders that reserve stock, confirms payments from a signed payment-provider
webhook, and issues full or partial refunds. There is no storefront UI; Django admin is
available for read-only inspection.

## Setup

Requirements: Python 3.12, Docker (for Postgres 16 and Redis 7).

```sh
cd 04-shop-inventory
cp .env.example .env                 # dev defaults; change secrets outside development
docker compose up -d                 # Postgres on localhost:5454, Redis on localhost:6384
python -m venv .venv
. .venv/bin/activate                 # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pip freeze --exclude-editable > requirements.lock   # optional: pin the full dependency tree
python manage.py migrate
python manage.py seed
```

Direct dependencies are pinned exactly in `pyproject.toml`; no lockfile is committed. Run the
`pip freeze` line above to produce one for a deployment.

All configuration is read from environment variables (see `.env.example`) and validated at
start-up in `config/settings.py`.

| Variable | Purpose |
|---|---|
| `DJANGO_SECRET_KEY` | Django secret key (required, 16+ characters) |
| `DJANGO_DEBUG` | `true` for development |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated host names |
| `LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING` or `ERROR` |
| `DATABASE_URL` | Postgres URL |
| `CELERY_BROKER_URL` | Redis URL used as the Celery broker |
| `SHOP_CURRENCY` | ISO-4217 code for all prices (default `USD`) |
| `RESERVATION_MINUTES` | How long checkout holds stock (default 30) |
| `CLERK_REFUND_LIMIT_MINOR` | Largest single refund a clerk may issue (default 5000) |
| `PAYMENT_PROVIDER` | Provider implementation; only `fake` exists |
| `PAYMENT_WEBHOOK_SECRET` | Current webhook signing secret (required) |
| `PAYMENT_WEBHOOK_SECRET_PREVIOUS` | Previous secret, accepted during rotation (optional) |

## Run

```sh
python manage.py runserver                       # API on http://localhost:8000
celery -A config worker --loglevel=INFO          # processes webhook events and refunds
celery -A config beat --loglevel=INFO            # expiry every minute, stale requeue every 5 min
```

To exercise the payment flow locally, place an order and then post a signed provider event:

```sh
python manage.py simulate_webhook payment.succeeded SO-000001
python manage.py simulate_webhook refund.succeeded SO-000002 --refund-reference <refund id> --amount 650
```

`simulate_webhook` only runs with `DJANGO_DEBUG=true`.

## Test

Tests need the Postgres from `docker compose`; pytest-django creates a separate test database.
Redis is not needed: tests record published tasks instead of sending them.

```sh
pytest                                   # unit and integration tests
ruff check . && ruff format --check .    # lint and formatting
python manage.py makemigrations --check --dry-run
```

## Architecture

```
config/            settings (env validation, logging), urls, Celery app and beat schedule
core/              error envelope and exception handler, idempotency, roles, clock, task publishing,
                   read-only admin base, seed command
catalog/           Product model, product endpoints
inventory/         StockItem and StockMovement ledger, receive/adjust, stock endpoints
orders/            Order and OrderLine, checkout, transitions, expiry task, order endpoints
payments/          Refund, RefundLine, WebhookEvent; provider interface and fake; signature checks;
  services/        webhook intake, event processing, refund rules and submission
  management/      simulate_webhook command
tests/unit/        pure functions: signatures, refund rules, request hashing, backoff, errors
tests/integration/ HTTP and service tests against Postgres, including threaded concurrency tests
```

Request flow: DRF view validates the body with a serializer, checks the role permission, and
calls a service function in the app's services module. Services own transactions and row locks
and raise `DomainError` subclasses, which `core.errors.exception_handler` turns into the JSON
error envelope. Checkout and refund creation run through `core.idempotency`.

Job flow: services publish tasks by name after commit (`core.jobs`). The webhook endpoint stores
the event and publishes `payments.process_webhook_event`; refund creation publishes
`payments.submit_refund`. Beat runs `orders.expire_reservations` and
`payments.requeue_stale_events`. Tasks are thin wrappers that pass the current time to services.

Logs are JSON via structlog; django-structlog binds a request id (inbound `X-Request-Id` is
honoured) that also appears in error responses as `requestId`.

## Where the hard parts live

| Topic | Files |
|---|---|
| Stock row locking and the movement ledger | `inventory/services.py`, `inventory/models.py` |
| Checkout reservation | `orders/services.py`, `orders/serializers.py` |
| Request idempotency | `core/idempotency.py`, `orders/views.py`, `payments/views.py` |
| Order transitions and expiry | `orders/services.py`, `orders/tasks.py` |
| Webhook signature verification | `payments/signature.py` |
| Webhook intake and duplicate delivery | `payments/services/webhooks.py` |
| Event processing, ordering and retries | `payments/services/events.py`, `payments/tasks.py` |
| Refund rules, submission and restock | `payments/services/refunds.py`, `payments/services/events.py` |
| Database constraints | `*/models.py`, `*/migrations/` |
| Error envelope | `core/errors.py`, `core/views.py` |
| Concurrency tests | `tests/integration/test_concurrency.py`, `tests/helpers.py` |

## Seed accounts

`python manage.py seed` creates these users (and demo products, stock and orders):

| Username | Password | Role |
|---|---|---|
| `manager` | `manager-pass-123` | manager |
| `clerk` | `clerk-pass-123` | clerk |
| `admin` | `admin-pass-123` | superuser, for the read-only Django admin |

Get an API token with `POST /api/auth/token/` and `{"username": "...", "password": "..."}`, then
send `Authorization: Token <token>`.
