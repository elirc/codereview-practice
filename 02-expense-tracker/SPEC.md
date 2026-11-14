# 02 — Team Expense Tracker

## 1. Purpose

Employees submit expense reports with receipts in any supported currency; reports move through an approval chain and are reimbursed in the organisation's base currency. Every state change is audited. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Backend | Python 3.12, FastAPI 0.115.6, Pydantic 2.10.3, pydantic-settings 2.7.0, uvicorn 0.34.0 |
| DB | PostgreSQL 16 (compose host port 5452), SQLAlchemy 2.0.36 (2.0-style typed `Mapped[...]` models, **synchronous** `Session`), psycopg 3.2.3, Alembic 1.14.0 |
| Auth | argon2-cffi 23.1.0. Opaque session token in `HttpOnly` cookie `et_session`; SHA-256 stored in `sessions`. Mutations require header `X-Requested-With: fetch` (CSRF) |
| Uploads | python-multipart 0.0.20; `ReceiptStorage` interface with `LocalDiskStorage` (dir from env) |
| Logging | structlog 24.4.0 |
| Tests | pytest 8.3.4, httpx 0.28.1 (`TestClient`), real Postgres |
| Lint | Ruff 0.8.4 (lint + format), mypy 1.13.0 |
| Frontend | React 18.3.1, Vite 6.0.5, TypeScript 5.7, @tanstack/react-query 5.62.8, react-router-dom 6.28.1, zod 3.24.1, Vitest 2.1.8 |

Layout: `backend/app/{api,domain,services,models,schemas,core}`, `backend/alembic`, `backend/tests`, `frontend/src`. `domain/` is pure (money, conversion, approval chain construction, state machine) and has no SQLAlchemy imports.

Single organisation per deployment. Base currency from env `BASE_CURRENCY` (default `USD`).

## 3. Roles and permissions

Roles: `employee`, `manager`, `finance`, `admin`. Every user has a role, an optional `manager_id`, and an `approval_limit_minor` in base currency (0 for employees).

| Action | employee | manager | finance | admin |
|---|---|---|---|---|
| Create/edit/delete own draft report, upload receipts | yes | yes | yes | yes |
| Submit / withdraw / reopen own report | yes | yes | yes | yes |
| View a report | own | own + where they are or were a step approver | all | all |
| Decide a manager step | no | only if they are that step's named approver | same rule | same rule |
| Decide the finance step | no | no | yes, with the restrictions in 5.5 | no |
| Mark reimbursed | no | no | yes, not own report | no |
| Manage exchange rates | no | no | yes | yes |
| Manage users (role, manager, limit) | no | no | no | yes |
| Read audit log | own reports | reports they can view | all | all |

`admin` has no approval power by virtue of the role. Reports the caller may not view return `404 not_found`.

## 4. Domain model

- **users**: `id`, `email` (unique, lower-case), `password_hash`, `full_name`, `role`, `manager_id?`, `approval_limit_minor` (bigint ≥ 0), `active`. The manager graph must be acyclic; setting a manager that would create a cycle is `422 manager_cycle`. A manager must be able to decide steps: `manager_id` may not point at a user whose role is `employee`, and a user who has direct reports may not be changed to role `employee`; both are `422 manager_role_required`.
- **currencies**: `code` (PK, ISO-4217), `exponent` (0, 2 or 3). Seeded: USD 2, EUR 2, GBP 2, CAD 2, JPY 0, KWD 3.
- **exchange_rates**: `id`, `from_currency`, `effective_date`, `rate` `NUMERIC(20,10)` (> 0) meaning *one major unit of `from_currency` equals `rate` major units of base*, `created_by`. Unique `(from_currency, effective_date)`. Rates are immutable once referenced by a submitted line; otherwise editable.
- **reports**: `id`, `owner_id`, `title` (1–120), `status`, `round` (int, starts 0), `version` (int), `total_base_minor?` (set at submit), `submitted_at?`, `decided_at?`, timestamps.
- **expense_lines**: `id`, `report_id`, `expense_date` (date), `category` (`travel`, `meals`, `lodging`, `supplies`, `other`), `description` (1–300), `amount_minor` (bigint > 0), `currency`, `receipt_id?`, `rate_used?` (`NUMERIC(20,10)`), `rate_effective_date?`, `base_amount_minor?`.
- **receipts**: `id`, `owner_id`, `storage_key`, `original_filename`, `content_type`, `size_bytes`, `sha256`. A receipt attaches to at most one line (unique on `expense_lines.receipt_id`).
- **approval_steps**: `id`, `report_id`, `round`, `position` (1-based), `kind` (`manager` | `finance`), `approver_id?` (null for finance), `status` (`pending` | `approved` | `rejected` | `skipped`), `decided_by?`, `decided_at?`, `comment?`. Unique `(report_id, round, position)`.
- **reimbursements**: `id`, `report_id` (unique), `amount_base_minor`, `currency` (base), `payment_reference` (1–64), `paid_by`, `paid_at`.
- **audit_events**: `id` (bigserial), `at`, `actor_id`, `request_id`, `entity_type`, `entity_id`, `action`, `before` (jsonb, nullable), `after` (jsonb, nullable). A database trigger raises on `UPDATE` or `DELETE`.

## 5. Domain rules

### 5.1 Money

- Amounts are integer minor units with a currency code, in the database, the API and the frontend. The API never accepts or returns decimals for amounts; the frontend parses user input to minor units using the currency's exponent with string arithmetic and rejects more fractional digits than the exponent allows.
- `Money` is a frozen value type; adding or comparing different currencies raises.
- Python `float` is never used for amounts or rates. Rates are `Decimal`; JSON carries rates as strings.

### 5.2 Conversion

For a line with `amount_minor` in currency `C` (exponent `e_c`) and base currency `B` (exponent `e_b`):

- If `C == B`: `base_amount_minor = amount_minor`, `rate_used = 1`, `rate_effective_date = expense_date`.
- Otherwise the rate is the row for `C` with the greatest `effective_date <= expense_date`. If none exists, submission fails with `422 missing_exchange_rate` listing the line ids. Future-dated rates are never used.
- `base_amount_minor = round_half_even(Decimal(amount_minor) * rate * 10^(e_b - e_c))`, computed with `decimal` under a local context of precision 40, quantised with `ROUND_HALF_EVEN` to an integer.
- Conversion is per line. `total_base_minor` is the sum of the lines' `base_amount_minor`; it is not a conversion of a summed foreign amount.
- `rate_used`, `rate_effective_date` and `base_amount_minor` are written at submit and frozen. They are cleared when the report returns to `draft` and recomputed on the next submit.
- Drafts show an estimated base amount computed the same way on read (not stored); `null` when no rate exists.

### 5.3 State machine

States: `draft`, `submitted`, `approved`, `rejected`, `reimbursed`.

| From | To | Trigger | Who |
|---|---|---|---|
| `draft` | `submitted` | submit | owner |
| `submitted` | `draft` | withdraw | owner, only while no step of the current round has been decided |
| `submitted` | `submitted` | approve a non-final step | step approver |
| `submitted` | `approved` | approve the final step | step approver |
| `submitted` | `rejected` | reject any step (comment required, 1–1000 chars) | step approver |
| `rejected` | `draft` | reopen | owner |
| `approved` | `reimbursed` | mark reimbursed | finance |

No other transition exists. `reimbursed` is terminal. Lines, title and receipts are editable only in `draft`. A report can be deleted only in `draft` and only if `round = 0` (never submitted).

The transition table lives in one place in `domain/` and every service calls it; an illegal transition raises a domain error mapped to `409 invalid_state`.

### 5.4 Submission

Preconditions (each a `422` with its own code): at least one line (`empty_report`); every line whose estimated base amount is ≥ 2500 base minor units has a receipt (`receipt_required`); all rates available (`missing_exchange_rate`); an approval chain can be built (`no_eligible_approver`).

On submit, in one transaction: freeze conversions, set `total_base_minor`, increment `round`, build steps for the new round, set `submitted_at`, bump `version`, write audit.

Chain construction (pure function of owner, user graph, total):

1. Start with the owner's manager `m1`. If the owner has no manager, there are no manager steps.
2. Add a `manager` step for `m`. If `m.approval_limit_minor >= total_base_minor`, stop. Otherwise continue with `m`'s manager; if there is none, stop (the top of the chain is sufficient regardless of limit).
3. Inactive users in the chain are skipped over (not added); the walk continues to their manager.
4. Append one `finance` step (role-based, `approver_id` null).
5. `no_eligible_approver` when there exists no active finance user other than the owner.

The steps of a round are fixed at submit. Later changes to managers, limits or roles do not alter an in-flight round, except as stated in 5.5.

### 5.5 Decisions

A decision targets the **current step**: the lowest `position` with status `pending` in the current round. Request carries `expected_version`.

Authorisation, evaluated in the service under a row lock on the report (`SELECT … FOR UPDATE`):

- Report must be `submitted` (`409 invalid_state`); `expected_version` must equal `reports.version` (`409 version_conflict`, details include the current version).
- The actor is never the report owner (`403 self_approval`), for any step kind, regardless of role.
- `manager` step: actor's id equals `approver_id`, the actor is active, and the actor's current role is not `employee` (the user-management rule in section 4 keeps employees out of chains; this check is the backstop). No one else, including admin.
- `finance` step: actor's current role is `finance`, actor is active, and the actor has not decided an earlier step in this round (`403 separation_of_duties`).
- Approve of the final step sets status `approved` and `decided_at`. Reject sets the step `rejected`, all later steps `skipped`, report `rejected`.
- Every decision bumps `version` and writes audit events for the step and the report.

If a named manager approver is deactivated while a step is pending, an admin may `POST /reports/{id}/steps/{step_id}/reassign` to the deactivated user's manager (or any active manager-role user if none); the new approver must not be the owner or an approver of another step in the round. This is audited.

### 5.6 Reimbursement

- Only `approved` reports. Actor is finance and not the owner (`403 self_approval`).
- Amount is `total_base_minor` in base currency; the client supplies only `payment_reference` and `expected_version`.
- One reimbursement per report (unique constraint). A repeated request for an already reimbursed report returns `409 invalid_state`.

### 5.7 Receipts

- `multipart/form-data`, one file. Max 5 MiB, enforced while reading the stream (do not trust `Content-Length`); `413 file_too_large`.
- Allowed types: PDF, JPEG, PNG, determined from magic bytes (`%PDF-`, `FF D8 FF`, `89 50 4E 47 0D 0A 1A 0A`); the declared content type and extension are ignored. Other content → `415 unsupported_media_type`.
- Stored under a server-generated key `receipts/<uuid>.<ext>`; the original filename is kept as metadata only, truncated to 200 chars with path separators and control characters removed.
- Download requires permission to view the owning report (or to be the uploader while unattached); served with the stored content type, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`.
- A receipt can be attached only by its owner, only to a line of their own draft report.

### 5.8 Audit log

- Written in the same transaction as the change it records; if the transaction rolls back, no event exists.
- Actions: `report.created`, `report.updated`, `report.deleted`, `line.added`, `line.updated`, `line.removed`, `receipt.attached`, `report.submitted`, `report.withdrawn`, `step.approved`, `step.rejected`, `step.reassigned`, `report.reopened`, `report.reimbursed`, `rate.created`, `rate.updated`, `user.updated`.
- `before`/`after` hold the changed fields only. Never includes password hashes or session data.

## 6. API surface

Prefix `/api`. `snake_case` JSON. List endpoints use `limit` (default 50, max 200) and `offset`.

| Method & path | Notes |
|---|---|
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | |
| `GET /currencies` | |
| `GET /reports?status=&owner=me\|all` | `owner=all` returns only reports the caller may view |
| `POST /reports` | `{ title }` |
| `GET /reports/{id}` | Includes lines, steps of all rounds, reimbursement, `version`, `current_step_id`, `can` (object of booleans for the caller: `edit`, `submit`, `withdraw`, `decide`, `reopen`, `reimburse`) |
| `PATCH /reports/{id}`, `DELETE /reports/{id}` | Draft only; `expected_version` required on PATCH |
| `POST /reports/{id}/lines`, `PATCH /reports/{id}/lines/{line_id}`, `DELETE …` | Draft only; each bumps `version` |
| `POST /receipts` | Upload; returns receipt metadata |
| `GET /receipts/{id}/content` | |
| `POST /reports/{id}/submit`, `/withdraw`, `/reopen` | `{ expected_version }` |
| `POST /reports/{id}/steps/{step_id}/approve` | `{ expected_version, comment? }`; `409 not_current_step` if `step_id` is not the current step |
| `POST /reports/{id}/steps/{step_id}/reject` | `{ expected_version, comment }` |
| `POST /reports/{id}/steps/{step_id}/reassign` | admin; `{ approver_id }` |
| `POST /reports/{id}/reimburse` | `{ expected_version, payment_reference }` |
| `GET /approvals/pending` | Reports whose current step the caller could decide now (applies all 5.5 rules) |
| `GET /exchange-rates?from_currency=`, `POST /exchange-rates`, `PATCH /exchange-rates/{id}` | PATCH refused with `409 rate_in_use` once any frozen line references that `(currency, effective_date)` |
| `GET /users`, `PATCH /users/{id}` | admin |
| `GET /audit?entity_type=&entity_id=` | Filtered to what the caller may view |

Frontend pages: login; my reports; report editor (lines, receipt upload, estimated totals); report detail with step timeline and decision buttons driven by `can`; approvals inbox; finance queue (approved, awaiting reimbursement); exchange rates; users (admin); audit view on report detail. On `409 version_conflict` the UI refetches and tells the user the report changed.

## 7. Background jobs

None. All work is synchronous in the request. (No scheduler, no queue.)

## 8. Edge cases

1. JPY line (exponent 0) of 1,000 at rate 0.0067 to USD → 670 minor units (USD 6.70).
2. KWD line (exponent 3) of 1.500 KWD (1500 minor) at rate 3.25 → 488 minor units after half-even (487.5 → 488); a value ending in exactly .5 with an even integer part rounds down (e.g. 486.5 → 486).
3. Three lines of 0.333… equivalent each convert and round individually; the total is the sum of rounded values.
4. Rate lookup uses `expense_date`, not submit date; a rate added later with an earlier effective date does not change frozen lines.
5. Line dated before the earliest rate for its currency → `missing_exchange_rate`.
6. Receipt threshold compares the base-currency estimate: a 3,000 JPY line (about USD 20.10) needs no receipt at threshold USD 25.00; a 5,000 JPY line does.
7. Owner with no manager → chain is the finance step only.
8. Owner's manager has limit below total, manager's manager has no manager → two manager steps then finance.
9. Owner is a finance user: another finance user must do the finance step; if none, `no_eligible_approver` at submit.
10. A finance user who is also the owner's manager approves the manager step: they cannot also take the finance step.
11. Manager attempts to approve step 2 while step 1 is pending → `409 not_current_step`.
12. Admin attempts to approve any step → `403`.
13. Two approvers (or one double-click) decide the same step concurrently: one succeeds, the other gets `409` (version or state), and exactly one audit event exists for the step.
14. Owner withdraws while the first approver approves concurrently: exactly one wins; if the approval wins, withdraw returns `409`.
15. Editing a line with a stale `expected_version` → `409`; no partial write.
16. Reject without a comment → `400 validation_failed`.
17. Reopen after rejection clears frozen conversion fields and keeps old rounds' steps visible as history; resubmit creates round 2 with freshly built steps and fresh rates.
18. Manager changed after submission: the original approver still decides the in-flight round.
19. Role changed from `finance` to `employee` after submission: that user can no longer take the finance step.
20. Reimburse twice (retry) → second is `409`, one reimbursement row.
21. Finance user cannot reimburse their own approved report.
22. Upload of a `.png` whose bytes are a PDF is stored as PDF; an HTML file named `receipt.pdf` is rejected with `415`.
23. Upload of 5 MiB + 1 byte with a false small `Content-Length` is rejected.
24. Filename `../../etc/passwd` has no influence on the storage key.
25. Attaching another user's receipt, or a receipt already attached to another line → `404` / `409 receipt_in_use`.
26. Viewing or downloading the receipt of a report the caller cannot view → `404`.
27. A failed submit (e.g. missing rate) writes no audit event and leaves `round` unchanged.
28. Amount `0`, negative amounts, unknown currency codes and dates in the future (later than today UTC + 1 day) are rejected at the boundary.
29. Setting user A's manager to B when B's chain includes A → `422 manager_cycle`.
30. `UPDATE` or `DELETE` on `audit_events` fails at the database.
31. Setting a user's manager to someone whose role is `employee` → `422 manager_role_required`.
32. Changing a user who has direct reports to role `employee` → `422 manager_role_required`; the same change succeeds once their reports have been moved to another manager.

## 9. Non-goals

Multiple organisations, delegation/out-of-office, per-category policies, mileage, card feeds, OCR, payouts to banks, notifications, exporting to accounting systems, live FX feeds, background jobs.

## 10. Acceptance criteria

- A report can travel `draft → submitted → approved → reimbursed` and `submitted → rejected → draft → submitted` with correct steps, totals and audit trail.
- No request sequence lets a user approve or reimburse their own report, decide a step that is not theirs or not current, or decide twice.
- All stored and displayed amounts are integer minor units; conversions match 5.2 exactly.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (`domain/`):
- `Money` arithmetic and currency mismatch.
- Conversion across exponent pairs (0→2, 3→2, 2→0, 2→2), half-even ties both directions, per-line vs sum.
- Rate selection by date (exact, earlier, none, future ignored).
- Chain construction: no manager, limit satisfied at level 1, escalation to level 2 and 3, inactive manager skipped, owner is finance, no eligible finance.
- State machine: every legal transition accepted; every other (from, action) pair rejected (table-driven).
- Frontend: parse/format minor units for exponents 0, 2, 3, including rejection of excess decimals.

Integration (API + Postgres):
- Full happy path with audit events asserted in order.
- Each permission rule in 5.5 and 5.6, including self-approval for each role and separation of duties.
- Version conflict on edit, decide and reimburse; concurrent decision on one step (two threads/sessions).
- Withdraw vs approve race.
- Reopen/resubmit builds a new round and recomputes rates.
- Submission failures leave state and audit untouched.
- Receipt upload: type sniffing, size limit, filename sanitisation, download authorisation.
- Visibility: `404` for reports outside the caller's view; `/approvals/pending` content per user.
- Audit immutability trigger.
- Manager cycle rejection; employee-role manager and demotion-with-reports rejection; `rate_in_use`.

## 12. Commit plan

1. `chore`: backend scaffold (pyproject, settings, logging, error envelope, health route), compose, `.env.example`.
2. `feat`: models and initial Alembic migration (including audit trigger and currency seed data migration).
3. `feat`: auth, sessions, CSRF header check, user management.
4. `feat`: domain core — money, conversion, state machine, chain construction — with unit tests.
5. `feat`: reports and lines CRUD, exchange rates API, draft estimates.
6. `feat`: receipts upload/download and storage interface.
7. `feat`: submit / withdraw / reopen / decisions / reassign / reimburse services and endpoints, audit writer.
8. `test`: integration suites for workflow, permissions, concurrency.
9. `feat`: frontend scaffold, auth, API client, money utilities with tests.
10. `feat`: frontend report editor, detail and step timeline.
11. `feat`: frontend approvals inbox, finance queue, rates, users, audit view.
12. `docs`/`ci`: seed script, README, CI workflow.
