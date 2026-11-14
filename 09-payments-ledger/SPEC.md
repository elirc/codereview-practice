# 09 — Payments Ledger

## 1. Purpose

A double-entry ledger and wallet service for a marketplace platform. It keeps customer wallets and merchant accounts in several currencies, moves money with transfers, authorisation holds and captures, converts between currencies at snapshotted rates, pays merchants out in an end-of-day settlement, reconciles the ledger against imported bank statement files, and publishes every committed change to Kafka through an outbox. API only; there is no UI. Read `../CONVENTIONS.md` first, including section 12.

Conventions pointer: doc comments and comments say what a function does and returns. They never name the race, replay, duplicate or overdraft a piece of code is there for, and never describe the locking, ordering or deduplication design (CONVENTIONS §4 and §12.1).

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Language/runtime | Kotlin 2.1.0 on JDK 21 (toolchain 21). No coroutines; blocking code throughout |
| Build | Gradle 8.11.1 with Kotlin DSL (`build.gradle.kts`, `settings.gradle.kts`). Plugins: `org.springframework.boot` 3.4.1, `io.spring.dependency-management` 1.1.6, `org.jetbrains.kotlin.jvm` 2.1.0, `org.jetbrains.kotlin.plugin.spring` 2.1.0, `org.jlleitschuh.gradle.ktlint` 12.1.1. No wrapper jar is committed; CI uses `gradle/actions/setup-gradle@v4` with `gradle-version: 8.11.1` and calls `gradle` |
| Framework | Spring Boot 3.4.1: `spring-boot-starter-web`, `-jdbc`, `-validation`, `-actuator` (health only). Versions of everything below without an explicit number come from the Spring Boot BOM |
| DB access | PostgreSQL 16 (compose host port 5461). Plain SQL through Spring's `JdbcClient` and `NamedParameterJdbcTemplate`. No JPA, no jOOQ, no Spring Data repositories. Transactions are explicit through one `TransactionTemplate`-based helper `Tx.inTx { }` (default isolation READ COMMITTED); no `@Transactional` |
| Migrations | Flyway (`flyway-core`, `flyway-database-postgresql`); SQL files `src/main/resources/db/migration/V<n>__<name>.sql`. Run by the `migrate` profile only (`spring.flyway.enabled=false` elsewhere) |
| Messaging | `spring-kafka` producer only (`KafkaTemplate<String, String>`), Kafka 3.9 in KRaft mode (`apache/kafka:3.9.0`, compose host port 6392). Producer: `acks=all`, `enable.idempotence=true`, `max.in.flight.requests.per.connection=5`. Topics are created by `NewTopic` beans (6 partitions each) |
| JSON | Jackson with `jackson-module-kotlin`. `FAIL_ON_UNKNOWN_PROPERTIES` on, `ACCEPT_FLOAT_AS_INT` off (a fractional or exponent number in an integer field is a `400`), `WRITE_DATES_AS_TIMESTAMPS` off |
| CSV | `org.apache.commons:commons-csv` 1.12.0 |
| Logging | Spring Boot structured logging (`logging.structured.format.console=logstash`); request id filter puts `requestId` in MDC |
| Tests | JUnit 5 via `spring-boot-starter-test`, `kotlin-test-junit5`, `spring-boot-testcontainers`, Testcontainers `postgresql` and `kafka` (`@ServiceConnection`). Integration tests use `@SpringBootTest` + `MockMvc`; concurrency tests use an executor and a `CountDownLatch`. A `MutableClock` test bean replaces the `Clock` bean |
| Auth | API keys (CONVENTIONS §12.8) checked by a `HandlerInterceptor`; no Spring Security |

Processes (same jar, chosen by profile): `api` (HTTP), `worker` (outbox relay and all scheduled jobs; `@EnableScheduling` is active only here), `migrate` (Flyway then exit), `seed`. API port 8090.

Package layout under `ledger`: `api` (controllers, DTOs, advice, auth interceptor), `domain` (pure: `Money`, `Currency`, allocation and FX arithmetic, statement parsing, entry validation), `ledger` (posting service, balances), `holds`, `transfers`, `fx`, `limits`, `idempotency`, `settlement`, `reconciliation`, `outbox`, `jobs`, `config`.

Currencies supported, with minor-unit exponents fixed in code: `USD` 2, `EUR` 2, `GBP` 2, `JPY` 0, `KWD` 3. Amounts are `Long` minor units in Kotlin, `bigint` in SQL, JSON integers. Rates are `BigDecimal` with scale 8, `numeric(20,8)` in SQL, strings in JSON. No `Double` or `Float` anywhere.

## 3. Roles and permissions

An API key has one role. A `merchant` key is bound to one `ownerId`.

| Action | service | merchant | operator | auditor |
|---|---|---|---|---|
| Create accounts | yes | no | yes | no |
| Read account, balance, postings, holds | any | own accounts | any | any |
| Transfers, withdrawals, holds (authorise), FX quotes and transfers | yes | no | no | no |
| Capture or release a hold | yes | holds whose `merchantAccountId` is theirs | yes | no |
| Reverse an entry | no | no | yes | no |
| Freeze, unfreeze, close accounts; set owner limits | no | no | yes | no |
| Publish FX rates | no | no | yes | no |
| Import statements, resolve lines, run settlement | no | no | yes | no |
| Read entries, settlements, statements, reconciliation report, trial balance | no | no | yes | yes |
| Manage API keys | no | no | yes | no |

A merchant key asking for an account, balance, posting list or hold that is not its own gets `404 not_found`, the same as a missing id. Role failures on an endpoint the role may never use are `403 forbidden`; that includes `GET /entries/{id}` for `service` and `merchant` keys, which read entries only through the postings of their accounts.

## 4. Domain model

- **Account**: `id`, `ownerId` (UUID of a party, null for system accounts), `type` (`customer_wallet` | `merchant` | `system`), `systemRole?` (`bank_cash` | `payout_clearing` | `fx_position` | `fx_residue` | `fees` | `suspense`), `currency`, `status` (`active` | `frozen` | `closed`), `allowNegative` (true only for system accounts), `depositReference` (unique, `DEP-` + 10 base32 chars; wallets and merchant accounts), `feeBps` (merchant only, 0–1000), `payoutEnabled` (merchant only), `createdAt`. Unique `(ownerId, type, currency)`; unique `(systemRole, currency)`. System accounts for every role and supported currency are created by a migration.
- **AccountBalance** (one per account): `accountId`, `postedMinor`, `heldMinor`, `version` (bigint, +1 on every change), `allowNegative` (copy). `available = posted − held`. Checks: `held_minor >= 0`; `allow_negative OR posted_minor - held_minor >= 0`.
- **JournalEntry**: `id`, `sequence` (bigint identity), `kind` (`deposit` | `withdrawal` | `transfer` | `capture` | `fx_transfer` | `settlement` | `bank_match` | `payout_return` | `suspense` | `reversal`), `reversesEntryId?` (unique), `reason?`, `actorKeyId`, `requestId`, `createdAt`.
- **Posting**: `entryId`, `lineNo`, `accountId`, `amountMinor` (signed, non-zero; positive increases the account's balance), `currency` (must equal the account's). Unique `(entryId, lineNo)`.
- **Hold**: `id`, `accountId`, `merchantAccountId`, `amountMinor` (> 0), `capturedMinor`, `currency`, `status` (`active` | `captured` | `released` | `expired`), `expiresAt`, `authorizedOn` (UTC date, for limits), `captureEntryId?`, `version`, timestamps.
- **OwnerLimit**: `ownerId`, `currency`, `dailyOutMinor`. **OwnerDailyUsage**: `ownerId`, `currency`, `day` (UTC date), `usedMinor` (>= 0); unique `(ownerId, currency, day)`.
- **FxRate**: `id`, `sellCurrency`, `buyCurrency`, `midRate` (buy units per one sell unit, major units), `spreadBps`, `publishedAt`, `publishedBy`. Append-only; the current rate for a pair is the row with the greatest `publishedAt`.
- **FxQuote**: `id`, `ownerId`, `rateId`, `sellCurrency`, `buyCurrency`, `sellMinor`, `buyMinor`, `midBuyMinor`, `midRate`, `customerRate`, `expiresAt`, `usedEntryId?`.
- **IdempotencyKey**: `apiKeyId`, `key`, `fingerprint`, `state` (`in_progress` | `completed`), `responseStatus?`, `responseBody?` (jsonb), `createdAt`; unique `(apiKeyId, key)`.
- **BankExpectation**: `id`, `kind` (`withdrawal` | `payout`), `reference` (unique), `accountId` (the debited wallet or merchant account), `amountMinor`, `currency`, `sourceEntryId`, `status` (`open` | `matched` | `returned` | `cancelled`), `matchedLineId?`, `createdAt`.
- **SettlementBatch**: `id`, `businessDate`, `currency`, `status` (`processing` | `completed`), `cutoffAt`, timestamps; unique `(businessDate, currency)`. **SettlementItem**: `batchId`, `merchantAccountId`, `outcome` (`paid` | `skipped_zero` | `skipped_below_minimum` | `skipped_frozen` | `skipped_disabled`), `amountMinor`, `entryId?`, `expectationId?`; unique `(batchId, merchantAccountId)`.
- **Statement**: `id`, `bankAccountCode`, `currency`, `statementDate`, `openingMinor`, `closingMinor`, `fileSha256` (unique), `lineCount`, `importedBy`, `importedAt`. **StatementLine**: `id`, `statementId`, `lineNo`, `bankLineId`, `bookingDate`, `amountMinor` (signed; positive is money arriving in the bank account), `reference`, `description`, `status` (`pending` | `matched` | `unmatched` | `amount_mismatch` | `duplicate` | `resolved`), `matchedExpectationId?`, `entryId?`, `note?`. Unique `(statementId, lineNo)`.
- **Outbox**: `id` (bigint identity), `eventId` (UUID, unique), `topic`, `partitionKey`, `payload` (jsonb, the full envelope), `createdAt`, `publishedAt?`, `attempts`, `lastError?`.
- **ApiKey**: `id`, `name`, `keyHash` (unique), `role`, `ownerId?`, `revokedAt?`.

Database invariants (Flyway SQL):

- `journal_entries` and `postings` reject `UPDATE` and `DELETE` through triggers.
- A deferred constraint trigger on `postings` verifies at commit that, for each entry touched, the postings of every currency sum to zero and the entry has at least two postings.
- A trigger on `postings` insert rejects a posting whose currency differs from the account's.
- The balance checks above; `holds.captured_minor <= amount_minor`; `owner_daily_usage.used_minor >= 0`.
- Partial unique index on `statement_lines (bank_account_code, bank_line_id)` for rows whose status is not `duplicate` (the column is denormalised onto the line).

## 5. Domain rules

### 5.1 Posting

All money movement goes through one function, `LedgerService.post(entry)`, called inside the caller's transaction:

1. Validate in memory: at least two postings, no zero amounts, per-currency sums are zero, at most 20 postings.
2. Lock the `account_balances` rows of every account involved with one `SELECT … FOR UPDATE` ordered by `account_id`. Any further account rows the operation needs (for a hold, the wallet) are part of the same ordered lock set; an operation never locks a second batch of accounts later in the transaction.
3. Check account status per posting: a `closed` account accepts nothing (`422 account_closed`); a `frozen` account accepts credits but no debits (`422 account_frozen`), except the debit of a capture, and debits made by `reversal` entries.
4. Apply deltas to the locked rows, `version + 1` per account. A debit that would make `posted − held < 0` on an account without `allowNegative` fails with `422 insufficient_funds` and `details: { accountId, availableMinor }`. The check constraint is the backstop; a violation of it is mapped to the same error.
5. Insert the entry and postings, then one `entry.posted` outbox row and one `account.balance_changed` row per account.

Balances are never recomputed from postings on the write path, and never written from values read before the lock.

### 5.2 Request idempotency

Every `POST` requires `Idempotency-Key` (8–128 visible ASCII chars), else `400 idempotency_key_required`. The fingerprint is SHA-256 over method, path template with path variables substituted, and the canonical JSON of the validated body (keys sorted, no insignificant whitespace; for the statement upload, the SHA-256 of the raw bytes plus the query string).

Flow, inside the operation's transaction: insert the key row with `ON CONFLICT DO NOTHING`. If inserted, run the operation inside a savepoint. On success store status and body and commit. On a `DomainException` with status `403`, `404`, `409` or `422`, roll back to the savepoint, store that error response on the key row, and commit. On anything else roll the whole transaction back, so no key row remains. If the insert found an existing row: a different fingerprint is `422 idempotency_key_reused`; the same fingerprint returns the stored status and body with header `Idempotent-Replay: true`. Body validation (`400`) and authentication happen before the key is touched. Keys are scoped to the API key that sent them. A purge job removes rows older than 7 days, whatever their state.

Two endpoints differ. `POST /settlements` commits once per merchant, so its key row is committed as `in_progress` before the run and completed with the response afterwards; a repeat while the run is going is `409 invalid_state` (not stored), and a failure that is not a `DomainException` deletes the key. `POST /api-keys` stores its response without the `key` field: the secret is returned once by the live response and never kept, so a replay returns the key's metadata only.

Request bodies are read strictly: an absent or null value for a required number or boolean is `400 validation_failed`, never a default.

### 5.3 Transfers and withdrawals

- Transfer: `fromAccountId != toAccountId` (`422 same_account`); both accounts exist; `currency` equals both accounts' currency (`422 currency_mismatch`); `amountMinor > 0`. Source must be `customer_wallet` or `merchant`; system accounts are never a source or destination of an API transfer (`422 invalid_account_type`). Entry kind `transfer`: source −A, destination +A.
- Withdrawal: wallet or merchant account −A, `payout_clearing` +A, kind `withdrawal`; creates a `BankExpectation` (`withdrawal`, reference `WDR-` + 12 base32 chars) in the same transaction.
- Both count against the owner's daily limit (5.5).

### 5.4 Holds

- **Authorise** (`POST /holds`): lock wallet balance; require `available >= amount`; `held += amount`; insert hold `active` with `expiresAt = now + expiresInSeconds` (60 to 604,800, default 604,800). The merchant account must be `active`, type `merchant`, same currency. Counts against the daily limit. No journal entry.
- **Capture** (`POST /holds/{id}/capture`, `{ amountMinor }`): lock the hold row, then post. Allowed only when `status = active` and `now < expiresAt` (else `409 hold_not_active` / `409 hold_expired`), `0 < amountMinor <= hold.amountMinor` (`422 capture_exceeds_hold`). One capture per hold. In one transaction: `held −= hold.amountMinor` (the whole hold, so any uncaptured remainder is released), entry kind `capture` with wallet −C, merchant +(C − fee), `fees` +fee; hold becomes `captured` with `capturedMinor = C`. `fee = roundHalfEven(C × feeBps / 10000)`; a zero fee posts no fee line.
- **Release**: `active` → `released`, `held −= amount`. Releasing a non-active hold is `409 hold_not_active`.
- **Expiry**: the job (section 7) turns `active` holds with `expiresAt <= now` into `expired` and lowers `held`. A hold whose `expiresAt` has passed cannot be captured even if the job has not processed it yet; it can still be released.
- Captures and releases are honoured on a `frozen` wallet. The capture's credit requires the merchant account not to be `closed`.
- Lock order for hold operations: hold row first, then account balance rows in id order.

### 5.5 Daily outbound limit

`OwnerLimit.dailyOutMinor` caps, per owner, currency and UTC day, the sum of: transfers out, withdrawals, and authorised holds. Default when no row exists: `DEFAULT_DAILY_OUT_MINOR` per currency from configuration. Transfers between two accounts of the same owner and FX transfers do not count.

- The check and the increment happen in the same transaction as the movement: upsert the `owner_daily_usage` row for `(ownerId, currency, today)` and lock it before locking account balances; fail with `422 daily_limit_exceeded` (`details.remainingMinor`) if `used + amount > limit`. Exactly at the limit is allowed.
- A hold adds its full amount on the day it is authorised (`authorizedOn`). Release or expiry subtracts the full amount from that day's row; capture subtracts the uncaptured remainder from that day's row. The row touched is always the authorisation day's, whatever today is.
- A reversal does not give limit back.
- Lock order across the whole service: hold row, then usage row, then account balance rows in id order.

### 5.6 FX

- `POST /fx/rates` appends a rate for an ordered pair. Quotes use the latest row for exactly `(sellCurrency, buyCurrency)`; there is no inversion or triangulation (`422 rate_unavailable`). A latest rate older than `FX_RATE_MAX_AGE_SECONDS` (default 3600) gives `422 rate_stale`.
- `customerRate = midRate × (10000 − spreadBps) / 10000`, scale 8, `RoundingMode.DOWN`.
- Quote with `sellAmountMinor` S: `buyMinor = floor(S × customerRate × 10^(expBuy − expSell))`, `midBuyMinor = floor(S × midRate × 10^(expBuy − expSell))`. Quote with `buyAmountMinor` B: `sellMinor = ceil(B / (customerRate × 10^(expBuy − expSell)))`, then `midBuyMinor` from that S as above and `buyMinor = B`. Exactly one of the two amounts is supplied. A quote whose `buyMinor` or `sellMinor` is 0 is refused (`422 amount_too_small`). All arithmetic in `BigDecimal`; conversion to `Long` uses `longValueExact`.
- A quote stores both rates and all three amounts and expires `FX_QUOTE_TTL_SECONDS` (default 30) after creation. It is usable while `now < expiresAt`.
- `POST /fx/transfers` `{ quoteId, fromAccountId, toAccountId }`: both accounts belong to `quote.ownerId`, currencies match the quote's sides. The quote is consumed by a conditional update (`used_entry_id IS NULL`) in the posting transaction; zero rows → `409 quote_already_used`; expired → `422 quote_expired`. Entry kind `fx_transfer`: wallet(sell) −S; `fx_position`(sell) +S; `fx_position`(buy) −midBuy; wallet(buy) +buy; `fx_residue`(buy) +(midBuy − buy). The residue line is computed by subtraction and omitted when zero. Amounts come from the quote, never recomputed from a current rate.

### 5.7 Reversal

`POST /entries/{id}/reverse` `{ reason }` (1–200 chars) creates a `reversal` entry whose postings negate the original's, with `reversesEntryId` set.

- Reversible kinds: `transfer`, `capture`, `fx_transfer`, `suspense`, and `withdrawal` while its expectation is `open` (the expectation becomes `cancelled` in the same transaction). Others → `422 not_reversible`. A `reversal` entry cannot be reversed.
- An entry is reversed at most once: the unique index decides; the loser gets `409 already_reversed`.
- The normal overdraft rule applies: if the reversal would take a non-negative account below zero available, it fails with `422 insufficient_funds` and nothing is posted.
- Reversing a capture does not reopen the hold. Reversing into a `closed` account fails with `422 account_closed`.
- Nothing in the system edits or deletes an entry or posting.

### 5.8 Account lifecycle

`active ⇄ frozen` by operator. `closed` is terminal and requires `postedMinor = 0`, `heldMinor = 0` and no `open` expectation for the account, checked under the balance lock (`422 account_not_empty`). A frozen merchant account still receives captures and can be reversed against; it is skipped by settlement.

### 5.9 Settlement

For business date D and currency C, `cutoffAt` is `D + 1` at 00:00 UTC. The batch may run only when `now >= cutoffAt` (`422 settlement_too_early`).

1. Insert the batch (`processing`); on unique conflict load the existing one. A `completed` batch returns as is.
2. For each merchant account in C, ordered by id, in its own transaction: skip if an item already exists; lock the balance; compute `asOf = Σ postings of the account whose entry.createdAt < cutoffAt`; `payable = min(asOf, available now)`.
3. Outcomes: `payoutEnabled = false` → `skipped_disabled`; `frozen` or `closed` → `skipped_frozen`; `payable <= 0` → `skipped_zero`; `payable < MIN_PAYOUT_MINOR[C]` → `skipped_below_minimum`; else `paid`: entry kind `settlement` (merchant −payable, `payout_clearing` +payable), a `payout` expectation with reference `STL-<yyyyMMdd>-<first 12 hex of account id>`, and the item, all in that transaction.
4. When every merchant account has an item, mark the batch `completed` and emit `settlement.batch_completed`.

A failure on one merchant is logged and leaves the batch `processing`; a later run continues from the missing items. Two runs for the same `(D, C)` at once produce one item per merchant. Settlement does not count against daily limits.

### 5.10 Statement import

`POST /statements?bankAccountCode=…` with `Content-Type: text/csv`, body at most 5 MB (`413`), UTF-8.

```
#HEADER,<bankAccountCode>,<currency>,<statementDate yyyy-MM-dd>,<opening>,<closing>
bank_line_id,booking_date,amount,reference,description
…data lines…
#TRAILER,<data line count>
```

- Amounts are signed decimal strings with exactly the currency's exponent digits (`-12.50`, `1200` for JPY, `0.125` for KWD); anything else is `422 statement_invalid` with `details.lines: [{ lineNo, message }]` listing every bad line (max 50 reported).
- Checks: header code equals the query parameter; trailer count equals data lines; at most 50,000 data lines; `opening + Σ amounts = closing` (`422 statement_unbalanced`); `opening` equals the `closingMinor` of the latest earlier statement for that bank account by `statementDate` when one exists (`422 statement_gap`); `statementDate` is later than that statement's.
- `reference` is trimmed and upper-cased on import.
- The whole file is stored in one transaction or not at all. A file whose SHA-256 already exists returns the existing statement with `200` and stores nothing.
- A data line whose `(bankAccountCode, bankLineId)` already exists on an earlier, non-duplicate line is stored with status `duplicate` and takes no further part; the balance check still counts it. Other lines start `pending`.

### 5.11 Reconciliation

The reconcile job (section 7) processes `pending` lines, each in its own transaction with the line row locked.

- **Credit line (`amount > 0`)**:
  - reference equals an account's `depositReference`: post kind `deposit` (`bank_cash` −A, account +A); line `matched`. If the account is `closed`, post to `suspense` instead and mark `unmatched` with a note.
  - reference is `RET-` + the reference of a `matched` or `open` expectation with the same amount and currency: post kind `payout_return`. If the expectation was `matched`: `bank_cash` −A, account +A. If it was still `open`: `payout_clearing` −A, account +A. Expectation → `returned`; line `matched`.
  - otherwise: line `unmatched`, nothing posted.
- **Debit line (`amount < 0`)**:
  - reference equals an `open` expectation's and `|amount|` and currency are equal: post kind `bank_match` (`payout_clearing` −A, `bank_cash` +A); expectation `matched` (conditional on `open`); line `matched`.
  - reference found but the amount differs: line `amount_mismatch`, nothing posted, `reconciliation.discrepancy_found` emitted.
  - expectation already `matched`, `returned` or `cancelled`, or no such reference: line `unmatched`.
- A statement in another currency than the matched account or expectation is treated as no match.
- Operator resolution of an `unmatched` or `amount_mismatch` line (`POST /statement-lines/{id}/resolve`): `deposit_to_account` (credit lines only; posts a `deposit` to the named account), `to_suspense` (posts kind `suspense` between `bank_cash` and `suspense` for the line amount, either sign), or `dismiss` (no posting; requires `note`). The line becomes `resolved`; resolving twice is `409 invalid_state`.
- The report for a date range lists: unmatched and mismatched lines; `open` expectations older than `EXPECTATION_OVERDUE_DAYS` (default 3) as `overdue`; and, per bank account, the difference between the latest statement's closing balance and `−(bank_cash posted balance)` for that currency with the open-item totals that explain it.

### 5.12 Trial balance

`GET /trial-balance` returns per currency: the sum of all `postedMinor` (must be 0), the sum of all postings (must be 0), and the list of accounts whose `postedMinor` differs from the sum of their postings (must be empty), plus accounts whose `heldMinor` differs from the sum of their `active` holds. It reads in one `REPEATABLE READ` read-only transaction.

## 6. API and event surface

Prefix `/v1`. `camelCase` JSON. Lists use `?after=<cursor>&limit=` (default 50, max 200), ordered by a unique key.

| Method & path | Notes |
|---|---|
| `POST /accounts`, `GET /accounts/{id}`, `GET /accounts?ownerId=` | Create returns `depositReference` |
| `GET /accounts/{id}/balance` | `{ postedMinor, heldMinor, availableMinor, currency, version }` |
| `GET /accounts/{id}/postings` | Ordered by `(entry.sequence, lineNo)`; cursor is that pair |
| `POST /accounts/{id}/freeze`, `/unfreeze`, `/close` | 5.8 |
| `PUT /owners/{ownerId}/limits/{currency}` | `{ dailyOutMinor }`; not a `POST`, no idempotency key |
| `POST /transfers`, `POST /withdrawals` | 5.3; `201` with the entry |
| `POST /holds`, `GET /holds/{id}`, `POST /holds/{id}/capture`, `POST /holds/{id}/release` | 5.4 |
| `POST /fx/rates`, `GET /fx/rates?sell=&buy=` | 5.6 |
| `POST /fx/quotes`, `POST /fx/transfers` | 5.6 |
| `GET /entries/{id}`, `POST /entries/{id}/reverse` | Entry with postings |
| `POST /settlements` `{ businessDate, currency }`, `GET /settlements/{id}` | 5.9; runs synchronously |
| `POST /statements`, `GET /statements/{id}`, `GET /statements/{id}/lines?status=` | 5.10 |
| `POST /statement-lines/{id}/resolve` | 5.11 |
| `GET /reconciliation/report?from=&to=` | 5.11 |
| `GET /trial-balance` | 5.12 |
| `POST /api-keys`, `DELETE /api-keys/{id}` | Key value returned once and not stored (5.2) |
| `GET /outbox/stats` | operator: unpublished count, oldest unpublished age |

Error codes beyond those named above: `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `invalid_state`, `internal_error`.

Events use the envelope of CONVENTIONS §12.4 in `camelCase`. The Kafka record key is the partition key; the value is the envelope; headers `eventId` and `eventType` repeat the envelope fields.

| Topic | `type` | Partition key | `sequence` | `data` |
|---|---|---|---|---|
| `ledger.entries` | `entry.posted` | entry id | entry `sequence` | `entryId`, `kind`, `reversesEntryId?`, `postings: [{ lineNo, accountId, amountMinor, currency }]` |
| `ledger.accounts` | `account.balance_changed` | account id | balance `version` | `accountId`, `currency`, `postedMinor`, `heldMinor`, `availableMinor`, `causeType` (`entry` \| `hold`), `causeId` |
| `ledger.accounts` | `account.status_changed` | account id | balance `version` (status changes bump it) | `accountId`, `status`, `previousStatus` |
| `ledger.accounts` | `hold.authorized`, `hold.captured`, `hold.released`, `hold.expired` | account id | hold `version` | `holdId`, `accountId`, `merchantAccountId`, `amountMinor`, `capturedMinor`, `currency`, `expiresAt`, `captureEntryId?` |
| `ledger.settlement` | `payout.created`, `payout.matched`, `payout.returned` | merchant or wallet account id | 1, 2, 3 by status | `expectationId`, `kind`, `reference`, `accountId`, `amountMinor`, `currency` |
| `ledger.settlement` | `settlement.batch_completed` | batch id | 1 | `batchId`, `businessDate`, `currency`, `paidCount`, `paidTotalMinor` |
| `ledger.settlement` | `reconciliation.discrepancy_found` | statement id | line `lineNo` | `statementId`, `lineId`, `reference`, `lineAmountMinor`, `expectedAmountMinor`, `currency` |

`account.balance_changed` is emitted for every balance row change, including hold-only changes. Events for one account are written while that account's balance row is locked.

## 7. Jobs and relay

All run in the `worker` profile on fixed delays; each has a `runOnce(now)` used by tests. Every loop tolerates other instances running the same loop.

| Job | Interval | Behaviour and failure semantics |
|---|---|---|
| Outbox relay | 200 ms | In one transaction: take `pg_try_advisory_xact_lock(<constant>)`; if not obtained, return. Read up to 200 rows with `published_at IS NULL` ordered by `id`. Send each in order with `kafkaTemplate.send(topic, key, payload).get(5 s)`. On the first failure stop the batch, record `attempts + 1` and `last_error` on that row, and leave it and all later rows unpublished. Mark the successfully sent prefix `published_at = now` and commit. After a failed pass the next pass waits `min(30 s, 2^consecutiveFailures × 200 ms)`. Delivery is at-least-once; consumers dedupe on `eventId` |
| Hold expiry | 30 s | Select ids of `active` holds with `expires_at <= now` (batch 200, no locks). Each hold is then processed in its own transaction that locks the hold row, re-checks `active` and `expires_at <= now`, and applies 5.4 and 5.5. One failure is logged and does not stop the batch |
| Reconcile | 10 s | Ids of `pending` lines ordered by `(statementDate, lineNo)`, batch 500; each line in its own transaction per 5.11, re-checking `pending` under the lock. An unexpected error leaves the line `pending`, increments `attempts`; after 5 attempts the line becomes `unmatched` with the error as note |
| Settlement trigger | cron `0 15 0 * * *` UTC | For yesterday and each supported currency, run 5.9. Also re-runs any batch still `processing` from earlier dates |
| Idempotency purge | hourly | Deletes keys older than 7 days, `completed` or still `in_progress`, 1,000 rows per pass |
| Outbox purge | hourly | Deletes rows published more than `OUTBOX_RETENTION_HOURS` (default 72) ago |

The API process never touches Kafka. If Kafka is down, API writes still succeed and the backlog shows in `/outbox/stats`.

## 8. Edge cases

1. An entry whose postings do not sum to zero in one of its currencies is rejected in code; inserted directly by SQL it fails at commit.
2. Two concurrent transfers out of one wallet that together exceed the available balance: exactly one succeeds, the other is `422 insufficient_funds`; the balance never goes negative.
3. Concurrent transfers A→B and B→A complete without deadlock.
4. A transfer of the full available balance succeeds; one minor unit more fails.
5. An active hold reduces what a transfer can spend: posted 100.00, held 60.00, transfer 40.01 fails, 40.00 succeeds.
6. Concurrent authorise and transfer on one wallet never leave `posted − held < 0`.
7. Capture for less than the hold releases the remainder in the same transaction; `held` drops by the full hold amount. Capture for more than the hold is `422`; a second capture of the same hold is `409 hold_not_active`.
8. Concurrent capture and release of one hold: exactly one wins; `held` is lowered once.
9. Capture at exactly `expiresAt` is `409 hold_expired`; one millisecond earlier succeeds, even if the expiry job has not run for a long time.
10. Expiry job and capture racing on one hold: one outcome, `held` lowered once, usage adjusted once.
11. A hold authorised on day 1 and released on day 3 gives the limit back on day 1's usage row, not day 3's.
12. Two concurrent transfers by one owner from two different accounts in the same currency, each within the limit but together over it: one fails with `daily_limit_exceeded`.
13. Limit exactly reached is allowed; holds count toward it while active and the captured part still counts after capture.
14. Transfer between two accounts of the same owner does not consume the limit.
15. Capture with `feeBps = 250`: on 0.60 USD the fee is 0.02 (1.5 rounds to 2); on 1.00 it is 0.02 (2.5 rounds to 2); on 0.20 it is 0 (0.5 rounds to 0) and no fee line is posted.
16. Same `Idempotency-Key` and body sent twice in sequence: one entry; second response is identical with `Idempotent-Replay: true`.
17. Same key and body sent concurrently: one entry; both callers get the same response.
18. Same key with a different body, or the same body on a different path: `422 idempotency_key_reused`.
19. A request that failed with `422 insufficient_funds` replays as the same `422` after the wallet is funded; a new key succeeds.
20. A request that failed with a `500` leaves no key row; the retry executes.
21. Two API keys using the same key string do not collide.
22. `amountMinor: 10.5`, `1e3` or `"100"` in a request is `400 validation_failed`; `0` and negatives are `400`; so is a body with an unknown field.
23. FX USD→JPY: 10.00 USD at mid 151.23456789 with 50 bps spread buys 1504 JPY, `midBuyMinor` 1512, residue 8.
24. FX with a buy amount fixed: the sell amount is rounded up; the residue line is omitted when `midBuyMinor = buyMinor`.
25. A quote used twice, sequentially or concurrently, posts once; the other call is `409 quote_already_used`.
26. A quote used at exactly `expiresAt` is `422 quote_expired`.
27. A new rate published after the quote does not change the amounts posted with the quote.
28. A quote between accounts of different owners, or with mismatched currencies, is refused.
29. Reversing a transfer whose recipient has since spent the money fails with `insufficient_funds` and posts nothing.
30. Concurrent double reversal: one `201`, one `409 already_reversed`.
31. Reversing a `settlement`, `bank_match`, `deposit` or `reversal` entry is `422 not_reversible`.
32. Reversing a withdrawal cancels its open expectation; once the expectation is matched the withdrawal is no longer reversible.
33. A frozen wallet: transfer out fails, incoming transfer succeeds, an existing hold can be captured, a new hold fails.
34. Closing an account with a non-zero balance, an active hold or an open expectation is refused.
35. Settlement run twice for the same date and currency pays each merchant once.
36. Two settlement runs started concurrently pay each merchant once and finish `completed`.
37. A capture after the cutoff is not included in that date's payout; a reversal after the cutoff that lowers the current balance below the as-of amount lowers the payout to what is available.
38. A settlement that fails half-way resumes on the next run without paying the first merchants again.
39. Importing the same file twice stores one statement; a file that differs by one byte is a different statement and its lines with known `bankLineId`s become `duplicate`.
40. A statement whose lines do not add up to the closing balance, or whose opening differs from the previous closing, is rejected and stores nothing.
41. An amount with the wrong number of decimals for the currency (`12.5` USD, `1200.00` JPY) rejects the file.
42. A credit line with a known `depositReference` (any case, surrounding spaces) funds the wallet once.
43. A debit line matching an open payout by reference and amount clears it; the same reference appearing on a later line with a new `bankLineId` is `unmatched`.
44. A debit line with the right reference and a different amount posts nothing and is reported.
45. A `RET-` credit for a matched payout returns the money to the merchant account from `bank_cash`; for a still-open payout it comes from `payout_clearing`.
46. Two reconcile jobs running at once process each line once.
47. Kafka unavailable for a period: API calls succeed; when it returns, events are published in id order with none missing.
48. Relay crash after sending and before marking: the event is sent again with the same `eventId`.
49. Two relay instances: for any account, `account.balance_changed` events are produced in increasing `sequence`.
50. After any mix of the operations above, the trial balance reports zero sums and no drifting accounts.
51. `GET /entries/{id}` with a `service` or `merchant` key is `403 forbidden`, whoever owns the entry's accounts.
52. `POST /api-keys` replayed with the same `Idempotency-Key` returns the key's metadata without `key`; no stored row contains the secret.
53. An `in_progress` idempotency key left by a settlement run that never finished is removed by the purge once it is 7 days old.
54. `PUT /owners/{id}/limits/{currency}` with `{}`, or `POST /fx/rates` without `spreadBps`, is `400 validation_failed`.

## 9. Non-goals

Card networks, real bank or PSP integrations, KYC, interest, chargebacks, partial refunds of a capture (use a new transfer), multiple captures per hold, FX rate inversion or triangulation, revaluation of FX positions, Kafka consumers, schema registry/Avro, multi-tenant platforms, rate limiting, UI.

## 10. Acceptance criteria

- For every currency at all times, all posted balances sum to zero and each balance equals the sum of its postings; `heldMinor` equals the sum of the account's active holds.
- No sequence of concurrent requests makes a non-system account's available balance negative or exceeds an owner's daily limit.
- Every `POST` is safe to retry with the same key and executes at most once.
- No entry or posting is ever modified; corrections are reversals.
- Every committed change has its events in the outbox, and the relay publishes them at least once in per-key order.
- Settlement pays each merchant at most once per date and currency; reconciliation posts each bank line at most once.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (no Spring context):
- `Money`/currency exponent parsing and formatting, including JPY and KWD; statement amount parsing.
- Entry validation (sum to zero per currency, minimum lines, zero amounts).
- Fee rounding table; FX quote arithmetic for both quote directions and the residue; canonical JSON fingerprint.
- Statement parser: header/trailer, counts, balance check, bad lines collected.
- Settlement payable calculation; relay back-off schedule.

Integration (Testcontainers Postgres, `MockMvc`, mutable clock):
- Posting: balances and versions after transfer; DB-level rejection of unbalanced entries and of updates/deletes.
- Concurrency: overdraft race, opposite-direction transfers, authorise vs transfer, capture vs release, capture vs expiry, per-owner limit across two accounts, double reversal, quote double use.
- Holds: partial capture, expiry boundary with a stale job, limit give-back on the authorisation day.
- Idempotency: replay, concurrent duplicates, fingerprint mismatch, stored `422`, `500` not stored, key scoping.
- FX: quote snapshot survives a rate change; expiry boundary; residue omitted when zero.
- Reversal rules per kind; frozen and closed account behaviour.
- Settlement: cutoff, minimums, rerun, concurrent runs, resume after injected failure.
- Statement import and reconciliation: every branch of 5.10 and 5.11, duplicate file and duplicate lines, concurrent reconcile runs, operator resolution.
- Outbox: rows written with each operation and absent after rollback; relay with a recording publisher publishes in order, stops at a failure, resumes; two relay instances; one test against Testcontainers Kafka that reads back key, headers and envelope.
- Permission matrix per role; merchant `404` on foreign ids.
- Trial balance after a scripted mixed scenario.

## 12. Commit plan

1. `chore`: Gradle build, application skeleton and profiles, config properties, logging, request id filter, error advice and envelope, compose, `.env.example`.
2. `feat`: Flyway schema for accounts, balances, entries, postings with triggers and checks; system accounts.
3. `feat`: domain money types and `LedgerService.post` with balance locking; account endpoints; API-key auth and roles.
4. `feat`: request idempotency (key store, fingerprinting, replay) wired into controllers.
5. `feat`: transfers and withdrawals with owner daily limits.
6. `feat`: holds: authorise, capture with fees, release, expiry job.
7. `feat`: FX rates, quotes and FX transfers.
8. `feat`: reversals and account lifecycle (freeze, close).
9. `feat`: outbox table, event envelope, relay to Kafka, purge, stats endpoint.
10. `feat`: end-of-day settlement batches and payout expectations.
11. `feat`: statement import and parsing.
12. `feat`: reconciliation job, operator resolution, report, trial balance.
13. `test`: concurrency and invariant suites, permission matrix.
14. `docs`/`ci`: seed profile, README, CI workflow.
