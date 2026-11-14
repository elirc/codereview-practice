# Payments Ledger

A double-entry ledger and wallet service for a marketplace: customer wallets and merchant accounts in USD, EUR, GBP, JPY and KWD, transfers, authorisation holds and captures, FX conversion at quoted rates, end-of-day merchant settlement and reconciliation against bank statement files. Every committed change is published to Kafka through a transactional outbox. It is an HTTP API only; there is no UI.

## Setup

Requirements: JDK 21, Gradle 8.11.1 and Docker.

```sh
cp .env.example .env          # adjust if needed; every variable has a dev default
docker compose up -d          # Postgres on 5461, Kafka (KRaft) on 6392
gradle wrapper --gradle-version 8.11.1   # optional: generate a local wrapper
gradle bootRun --args='--spring.profiles.active=migrate'
gradle bootRun --args='--spring.profiles.active=seed'
```

No wrapper JAR or lock file is committed; `gradle` resolves the pinned plugins and the Spring Boot BOM on first build.

Configuration is read from environment variables (see `.env.example`): `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_POOL_SIZE`, `KAFKA_BOOTSTRAP_SERVERS`, `PORT`, `FX_RATE_MAX_AGE_SECONDS`, `FX_QUOTE_TTL_SECONDS`, `DEFAULT_DAILY_OUT_MINOR`, `MIN_PAYOUT_MINOR`, `OUTBOX_RETENTION_HOURS`, `EXPECTATION_OVERDUE_DAYS`. The per-currency settings take `USD=…,EUR=…,GBP=…,JPY=…,KWD=…` in minor units. Invalid values stop the process at start-up.

## Run

All processes come from the same jar and are selected by Spring profile.

| Process | Command | What it does |
|---|---|---|
| API | `gradle bootRun --args='--spring.profiles.active=api'` | HTTP API on port 8090 (`/v1/...`, `/actuator/health`); never connects to Kafka |
| Worker | `gradle bootRun --args='--spring.profiles.active=worker'` | Outbox relay (200 ms), hold expiry (30 s), reconcile (10 s), settlement trigger (00:15 UTC), idempotency and outbox purges (hourly) |
| Migrate | `gradle bootRun --args='--spring.profiles.active=migrate'` | Applies Flyway migrations and exits |
| Seed | `gradle bootRun --args='--spring.profiles.active=seed'` | Inserts the development dataset and exits; safe to repeat |

With a built jar: `java -jar build/libs/payments-ledger.jar --spring.profiles.active=api`. API and worker can each run as several instances.

`POST /v1/settlements` runs synchronously and commits merchant by merchant. Repeating it with the same `Idempotency-Key` while the first call is still running answers `409 invalid_state`; wait for the first call and repeat with the same key to get its stored answer, rather than switching to a new key.

Every request needs `Authorization: Bearer <key>`; every `POST` needs an `Idempotency-Key` header of 8–128 visible ASCII characters. Example:

```sh
curl -s localhost:8090/v1/transfers \
  -H 'Authorization: Bearer lk_dev_service_2b4d6f8a0c1e3a5b7d9f1e3c5a7b9d0f' \
  -H 'Idempotency-Key: demo-transfer-0001' -H 'Content-Type: application/json' \
  -d '{"fromAccountId":"…","toAccountId":"…","amountMinor":1250,"currency":"USD"}'
```

## Test

```sh
gradle ktlintCheck
gradle test
```

Unit tests need nothing else. Integration tests start Postgres 16 (and, for one test, Kafka 3.9) with Testcontainers, so Docker must be running. Time is controlled through a `MutableClock` bean; scheduled loops are off outside the `worker` profile and tests call each job's `runOnce(now)` directly.

## Architecture

```
src/main/kotlin/ledger/
  LedgerApplication.kt     entry point; the profile picks the process
  api/                     controllers, request DTOs, API-key interceptor, error advice, idempotent request helper
  config/                  settings, Tx transaction helper, JDBC helpers, request ids, worker Kafka wiring
  domain/                  pure code: currencies and money, entry rules, fees, FX math, payouts, statement parser, errors
  ledger/                  accounts, balance locking, LedgerService.post, entries and reversals, trial balance
  transfers/  holds/  fx/  limits/      money movement services
  idempotency/             key store, canonical JSON fingerprints
  settlement/              bank expectations, end-of-day settlement
  reconciliation/          statement import, line matching and resolution, report
  outbox/                  outbox writer, event envelope, relay, Kafka publisher, stats
  jobs/                    periodic jobs and the worker schedule
  seed/                    development dataset
src/main/resources/db/migration/   Flyway SQL (V1–V8)
```

Request flow: `RequestIdFilter` → `ApiKeyInterceptor` (resolves the caller) → controller validates the body → `IdempotentRequests` opens the transaction and records the key → service checks the role and performs the work through `LedgerService.post` → domain events go to the `outbox` table in the same transaction → `ApiExceptionHandler` renders any error envelope. The worker's relay later publishes outbox rows to Kafka.

Ownership of tables and topics:

| Process | Writes | Publishes |
|---|---|---|
| API | all ledger tables, `outbox` (insert only) | nothing |
| Worker | holds, balances, journal (expiry, reconciliation, settlement), `outbox.published_at`, purges | `ledger.entries`, `ledger.accounts`, `ledger.settlement` |
| Migrate | schema and system accounts | nothing |

| Topic | Event types | Record key |
|---|---|---|
| `ledger.entries` | `entry.posted` | entry id |
| `ledger.accounts` | `account.balance_changed`, `account.status_changed`, `hold.authorized`, `hold.captured`, `hold.released`, `hold.expired` | account id |
| `ledger.settlement` | `payout.created`, `payout.matched`, `payout.returned`, `settlement.batch_completed`, `reconciliation.discrepancy_found` | account, batch or statement id |

Each record carries the JSON envelope (`id`, `type`, `schemaVersion`, `occurredAt`, `aggregateType`, `aggregateId`, `sequence`, `requestId`, `data`) and the headers `eventId` and `eventType`.

## Where the hard parts live

| Topic | Files |
|---|---|
| Posting and balance updates | `src/main/kotlin/ledger/ledger/LedgerService.kt`, `src/main/kotlin/ledger/ledger/BalanceStore.kt` |
| Journal invariants in the database | `src/main/resources/db/migration/V1__ledger_core.sql` |
| Request idempotency | `src/main/kotlin/ledger/idempotency/IdempotencyService.kt`, `src/main/kotlin/ledger/idempotency/CanonicalJson.kt`, `src/main/kotlin/ledger/api/IdempotentRequests.kt` |
| Daily outbound limits | `src/main/kotlin/ledger/limits/LimitService.kt`, `src/main/kotlin/ledger/transfers/TransferService.kt` |
| Holds, captures and expiry | `src/main/kotlin/ledger/holds/HoldService.kt`, `src/main/kotlin/ledger/jobs/HoldExpiryJob.kt` |
| FX quotes and conversion | `src/main/kotlin/ledger/domain/FxMath.kt`, `src/main/kotlin/ledger/fx/FxService.kt` |
| Reversals and account lifecycle | `src/main/kotlin/ledger/ledger/EntryService.kt`, `src/main/kotlin/ledger/ledger/AccountService.kt` |
| Settlement | `src/main/kotlin/ledger/settlement/SettlementService.kt`, `src/main/kotlin/ledger/domain/Payouts.kt` |
| Statement import | `src/main/kotlin/ledger/domain/StatementParser.kt`, `src/main/kotlin/ledger/reconciliation/StatementService.kt` |
| Reconciliation | `src/main/kotlin/ledger/reconciliation/ReconciliationService.kt`, `src/main/kotlin/ledger/jobs/ReconcileJob.kt` |
| Outbox relay | `src/main/kotlin/ledger/outbox/OutboxRelay.kt`, `src/main/kotlin/ledger/outbox/OutboxWriter.kt` |
| Trial balance | `src/main/kotlin/ledger/ledger/TrialBalanceService.kt` |
| Error envelope | `src/main/kotlin/ledger/api/ApiExceptionHandler.kt`, `src/main/kotlin/ledger/domain/DomainException.kt` |

## Seed accounts

API keys created by the seed profile (development only):

| Role | Key |
|---|---|
| operator | `lk_dev_operator_9f3c1e7a5b2d4f608e1a3c5b7d9f0e2a` |
| service | `lk_dev_service_2b4d6f8a0c1e3a5b7d9f1e3c5a7b9d0f` |
| auditor | `lk_dev_auditor_7e9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e` |
| merchant (owner `5a0b0000-0000-4000-8000-000000000003`) | `lk_dev_merchant_4c6e8a0b2d4f6a8c0e2b4d6f8a0c2e4b` |

Owners: Alice `a11ce000-0000-4000-8000-000000000001` (USD and EUR wallets), Bob `b0b00000-0000-4000-8000-000000000002` (USD and JPY wallets, USD daily limit 3,000.00), and the shop `5a0b0000-0000-4000-8000-000000000003` (USD merchant at 250 bps, EUR merchant at 150 bps). The seed funds the wallets, publishes USD→EUR, USD→JPY and EUR→USD rates, posts two transfers and leaves one active hold. `GET /v1/accounts?ownerId=…` lists an owner's accounts and their deposit references.
