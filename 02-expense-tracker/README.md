# Team Expense Tracker

Employees file expense reports with receipts in any supported currency. Each submission is converted per line into the organisation's base currency at the rate in force on the expense date, routed through a manager chain sized by approval limits and a finance step, and finally reimbursed. Every state change is written to an append-only audit log.

## Setup

Requirements: Python 3.12, Node 20+, Docker (for Postgres 16).

```sh
# Postgres on host port 5452, with databases `expense` and `expense_test`
docker compose up -d

# Backend
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp ../.env.example .env
alembic upgrade head
python -m app.seed

# Frontend (creates package-lock.json on first install)
cd ../frontend
npm install
```

No lockfiles are committed; `pip install` resolves the pinned versions in `pyproject.toml` and `npm install` writes `package-lock.json`.

## Run

```sh
# API on http://localhost:8002 (from backend/)
uvicorn app.main:create_app --factory --port 8002 --reload

# Web app on http://localhost:5172, proxying /api to the API (from frontend/)
npm run dev
```

There is no worker or scheduler; all work happens inside the request.

## Test

```sh
# Backend (from backend/); integration tests use TEST_DATABASE_URL and migrate it themselves
ruff check . && ruff format --check .
mypy
pytest

# Frontend (from frontend/)
npm run lint && npm run format:check && npm run typecheck
npm test
```

## Architecture

```
backend/
  app/
    main.py          application factory: settings, engine, clock, storage, middleware, routers
    core/            config, JSON logging, request-id middleware, error envelope, DB session, clock, hashing
    domain/          pure rules: Money, conversion, report state machine, approval chain, receipt policy
    models/          SQLAlchemy 2.0 typed models
    schemas/         Pydantic request/response models (unknown fields rejected)
    services/        units of work: reports, rates, receipts, workflow, users, approvals, audit
    api/             FastAPI routers, dependencies, multipart reader
    seed.py          idempotent demo data
  alembic/versions/  0001 schema and audit trigger, 0002 currency seed
  tests/unit/        domain and helper tests (no database)
  tests/integration/ HTTP + Postgres suites
frontend/src/
  api/               fetch client, zod schemas, query hooks
  auth/              session context
  lib/money.ts       string-based minor-unit parsing and formatting
  components/, pages/
```

Request flow: `RequestContextMiddleware` assigns the request id → the `/api` router checks the CSRF header on mutations → dependencies open a session, resolve the `et_session` cookie to a user and build a `ServiceContext` (actor, clock reading, request id, base currency) → the handler validates input with Pydantic and calls one service function → the service locks what it changes, applies domain rules, writes audit events and commits → the handler returns the refreshed view. Domain errors are mapped to the error envelope in `app/core/errors.py`.

## Where the hard parts live

| Topic | Files |
|---|---|
| Money and conversion rounding | `backend/app/domain/money.py`, `backend/app/domain/conversion.py`, `frontend/src/lib/money.ts` |
| Rate selection and freezing at submit | `backend/app/services/conversions.py`, `backend/app/services/workflow.py` |
| Rate edit lock | `backend/app/services/rates.py` |
| Report state machine | `backend/app/domain/state_machine.py` |
| Approval chain construction | `backend/app/domain/approval_chain.py` |
| Decision authorisation and capabilities | `backend/app/services/permissions.py`, `backend/app/services/workflow.py` |
| Concurrency and optimistic versions | `backend/app/services/access.py`, `backend/app/services/workflow.py` |
| Visibility of reports and audit events | `backend/app/services/access.py`, `backend/app/services/audit_log.py` |
| Pending approvals query | `backend/app/services/approvals.py` |
| Manager graph changes | `backend/app/services/users.py` |
| Receipt upload limits and type detection | `backend/app/api/multipart.py`, `backend/app/services/receipt_files.py`, `backend/app/services/receipts.py` |
| Audit log and immutability | `backend/app/services/audit.py`, `backend/alembic/versions/0001_initial_schema.py` |
| Sessions and CSRF | `backend/app/services/auth.py`, `backend/app/api/deps.py` |

## Seed accounts

All seeded users share the password `expense-demo-1`.

| Email | Role | Reports to | Approval limit |
|---|---|---|---|
| admin@example.com | admin | — | 0 |
| finance@example.com | finance | — | 0 |
| finance2@example.com | finance | — | 0 |
| director@example.com | manager | — | USD 10,000.00 |
| manager@example.com | manager | director | USD 500.00 |
| employee@example.com | employee | manager | 0 |
| employee2@example.com | employee | manager | 0 |

The seed adds rates for EUR, GBP, CAD, JPY and KWD from 2025-01-01, and reports in every state: a draft, one awaiting the manager, one awaiting finance, one approved and awaiting reimbursement, and one rejected.
