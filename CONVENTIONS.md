# Shared conventions for all projects

These rules apply to every project folder (`01-clinic-booking` … `13-workflow-engine`). Projects 09–13 (wave 2) also follow section 12, which adds to and in a few named places overrides the earlier sections. Each project's `SPEC.md` is the source of truth for business rules; this file is the source of truth for how the work is done. Where the two conflict, the SPEC wins for domain behaviour and this file wins for process.

The finished codebases are used for code-reading and code-review practice. A reader will compare each commit against the SPEC, and later a separate agent will plant bugs on a branch. That has two consequences that drive most of the rules below: the baseline must be the correct version, and the code must not point at its own hard parts.

## 1. Boundaries

- Work only inside your project folder and your one CI file, `.github/workflows/NN-<slug>.yml` (for example `.github/workflows/03-issue-tracker.yml`). Never read from, import from, or edit another project's folder, the repo root files, or another project's workflow.
- Work on your own branch in your own git worktree. Branch name: `build/NN-<slug>`. Do not merge, rebase onto, or push other branches.
- Projects share nothing: no root package manager workspace, no shared libraries, no shared docker-compose.

## 2. You cannot run anything

Do not install packages, download files, run package managers, start databases, or run generators. Everything is written by hand. Consequences:

- **Pin exact dependency versions** in the manifest (`package.json`, `pyproject.toml`, `Gemfile`, `go.mod`). Use the versions named in your SPEC. Do not use ranges (`^`, `~`, `>=`) for direct dependencies. Do not write lockfiles, `go.sum`, or `Gemfile.lock`; the README's setup section says how to generate them.
- **Write against the exact API of the pinned version.** If you are not sure an API exists in that version, use a simpler one you are sure of. A boring call that exists beats a clever one that might not.
- **Generated artefacts are hand-written as if generated**, and only where the stack normally commits them: Prisma migration SQL (`prisma/migrations/<timestamp>_<name>/migration.sql`), Drizzle migration SQL plus `meta/_journal.json`, Alembic revision files, Rails `db/schema.rb`, Django migration modules, sqlc output in project 07. They must be consistent with their sources (schema file, models, `.sql` queries). Do not hand-write artefacts that are normally git-ignored (`node_modules`, `.next`, `.svelte-kit`, Prisma client output, `__pycache__`).
- **Do not fabricate vendored third-party files** (for example a minified `htmx.min.js`). Reference the expected path, and give the fetch command in the README.
- Since nothing is executed, re-read your own code for import paths, names and types that do not line up. Type-level and wiring consistency is your substitute for a compiler.

## 3. Baseline correctness

- Every feature in the SPEC is implemented fully. No `TODO`, `FIXME`, `NotImplemented`, placeholder handlers, or "left as an exercise" for anything the SPEC describes.
- The numbered edge cases in the SPEC are requirements. Each one must be handled in code, and each one in the "Required tests" list must have a test.
- If the SPEC is ambiguous or you find a contradiction, make the conservative choice, implement it, and record it in `DECISIONS.md` in your project folder (one short entry: what was unclear, what you chose, why). Do not silently invent business rules, and do not expand scope.
- Out-of-scope items listed under "Non-goals" stay out.

## 4. Comments and naming

- Write the comments a good team would write: brief "why" notes where a decision is not obvious from the code, doc comments on public functions where the stack expects them, and nothing else.
- Do not narrate the hard parts. No comments such as "this lock prevents double-booking", "half-open interval so adjacent slots don't overlap", "important: check tenant here", "idempotency!", or banner comments around tricky sections. The reader is practising finding these; the code should look like ordinary production code.
- A neutral "why" is fine: `// Postgres reports exclusion violations as 23P01` is acceptable; `// catch the race condition where two patients book at once` is not.
- Doc comments say what a function does and what it returns. They do not say which failure, attack or race the function guards against, and they do not describe the locking, deduplication or authorisation design. "Loads an appointment the caller may see" is fine; "…so foreign ids are indistinguishable from missing ones" and "holds a share lock until commit so the row cannot be deleted" are not.
- No references to the SPEC's edge-case numbers in source code or test names. Test names describe behaviour.
- No mention of AI, builders, specs-for-review, or planted bugs anywhere in the project.

## 5. Production habits (all required)

**Migrations.** Schema changes only through the stack's migration tool. Constraints that protect invariants (unique, check, foreign key, exclusion) live in the database as well as in application code. No schema creation at application start.

**Validation at the boundary.** Every request body, query string, path parameter, form, uploaded file, webhook payload and CSV row is parsed and validated by a schema at the edge (zod, TypeBox, Pydantic, DRF serializers, Rails strong parameters plus model validations, Go request structs with explicit validation). Domain code receives typed, already-validated values. Unknown fields are rejected or stripped, never passed through to persistence.

**One error envelope per project.** All JSON error responses use this shape:

```json
{ "error": { "code": "slot_taken", "message": "Human readable sentence.", "details": {}, "requestId": "..." } }
```

- The four keys `code`, `message`, `details` and `requestId` are literal in every project. They are exempt from the per-language key casing in section 7, so Python, Ruby and Go projects also emit `requestId`.
- `code` is a stable `snake_case` identifier from the SPEC; `details` is optional structured data; validation failures use `code: "validation_failed"` with `details.fields: [{ "path": "...", "message": "..." }]`.
- Status mapping: `400` malformed or schema-invalid input; `401` not authenticated; `403` authenticated but not allowed; `404` not found, and also used where the SPEC says existence must not be revealed; `409` state or concurrency conflict; `413`/`415` for upload limits and types; `422` well-formed input that breaks a business rule; `429` rate limited; `500` unexpected.
- One central place maps domain errors to responses. Handlers do not build error JSON ad hoc. Unexpected errors are logged with the stack trace and returned as a generic `internal_error`; internals are never leaked to the client.
- Server-rendered flows (Rails, Go/htmx, SvelteKit forms, Next server actions) re-render with field errors or a flash message using the same error codes; any JSON endpoint in those projects still uses the envelope.

**Structured logging.** JSON logs through the stack's standard structured logger (pino, structlog, `Rails.logger` with tagged JSON formatter, `log/slog`). Every request gets a request id (accept inbound `X-Request-Id`, otherwise generate) that appears in logs and in the error envelope. Log at job start, finish and failure with job id and attempt. Never log passwords, session tokens, webhook secrets, full card or payment payloads, or receipt/file contents.

**Tests.** Unit tests for pure domain logic and integration tests that go through the HTTP layer and a real database (Postgres service container in CI, a temp file for SQLite). The SPEC's "Required tests" list is the minimum. Tests must be deterministic: no sleeping, no dependence on the wall clock or the machine's time zone.

**Clock and randomness.** Domain code never calls the system clock directly. Pass a clock (or `now`) in, so tests can fix time. The same goes for id and token generation where a test needs to predict it.

**Seed data.** One idempotent seed command that creates a realistic small dataset including at least one user per role (credentials listed in the README) and enough records to exercise every screen.

**Configuration.** All configuration from environment variables, read and validated once at start-up in one module; the process fails fast on missing or invalid values. Commit `.env.example` with every variable and a safe dev default or placeholder. No secrets in the repo.

**README.** Sections in this order: what it is (two or three sentences); setup; run (web, worker, any scheduler); test; architecture (directory map and request/job flow); "Where the hard parts live" (a table of topic → file paths, no explanations of the solutions); seed accounts.

**CI.** One workflow at `.github/workflows/NN-<slug>.yml` with:

```yaml
on:
  push:
    paths: ["NN-<slug>/**", ".github/workflows/NN-<slug>.yml"]
  pull_request:
    paths: ["NN-<slug>/**", ".github/workflows/NN-<slug>.yml"]
defaults:
  run:
    working-directory: NN-<slug>
```

Jobs: install, lint/format check, type check (where the stack has one), migrate, test. Use service containers for Postgres/Redis/MinIO where needed.

**Local infrastructure.** A `docker-compose.yml` (or `compose.yaml`) in the project folder for Postgres and any other backing service is expected. Use the host port given in the SPEC so projects do not collide.

## 6. Security baseline

- Passwords hashed with the algorithm named in the SPEC; never logged or returned.
- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` when `NODE_ENV`/equivalent is production. Session tokens are random (at least 128 bits) and stored hashed (SHA-256) in the database in projects 01, 02, 03, 06 and 08. The exceptions follow their framework's standard mechanism:
  - 04 uses DRF token authentication (`rest_framework.authtoken`), which stores the token itself.
  - 05 uses the Rails 8 authentication shape: a `sessions` row per login, identified by its id in a signed, permanent cookie; there is no separate bearer token to hash.
  - 07 uses scs with `pgxstore`, which keys the `sessions` table by the raw session token.
- Authentication and authorisation are checked on the server for every request and every server action, in the handler or service that performs the work. UI hiding is not a control.
- SQL only through parameterised queries or the ORM/query builder. No string-concatenated SQL from user input.
- Output is escaped by the template engine; any raw HTML rendering is sanitised as the SPEC states.
- State-changing requests are protected against CSRF using the mechanism named in the SPEC.

## 7. Data conventions

- Primary keys are UUIDs unless the SPEC says otherwise.
- Instants are stored in UTC (`timestamptz` in Postgres, integer epoch milliseconds or ISO-8601 UTC text in SQLite as the SPEC states). Civil dates are stored as `date`. Wall-clock times without a date are stored as text `HH:MM` together with an IANA zone on the owning record.
- Time ranges are half-open, `[start, end)`, everywhere: storage, queries, overlap checks, API.
- Money is an integer count of minor units plus an ISO-4217 code. No floats anywhere in a money path, including the frontend.
- JSON APIs use `camelCase` keys in TypeScript projects and `snake_case` in Python, Ruby and Go projects. Instants in JSON are ISO-8601 with `Z`.

## 8. Commits

- Build the project as **8–12 commits** on your branch, following the "Commit plan" in your SPEC (you may merge or split a step if it reads better, staying within 8–12).
- Each commit is PR-sized and coherent: it has one purpose, it leaves the tree in a consistent state (code in a commit does not import files that arrive in a later commit), and tests for a feature arrive with or immediately after that feature.
- Conventional-commit subjects with the project slug as scope: `feat(clinic-booking): slot generation and availability rules`. Types: `chore`, `feat`, `fix`, `test`, `docs`, `ci`, `refactor`. Subject in the imperative, 72 characters or fewer. A body of two to six lines says what the commit contains and any decision worth knowing; it does not list the edge cases handled.
- No fix-up commits for your own earlier mistakes; amend the work before committing so the history reads as a clean series. Do not rewrite history after a commit has been reported as done.
- Commit only files in your project folder and your CI file.

## 9. Size and style

- Target 3,000–7,000 lines of source per project: application code, migrations and templates. Tests, generated-looking artefacts and seed data do not count towards the target. If you are heading over, cut UI polish and breadth, not domain rules or tests.
- UI is functional and plain: forms, tables, clear error states. No design system, no animation, minimal CSS (one stylesheet, or Tailwind only if the SPEC names it).
- Idiomatic for the stack: follow the framework's standard layout and naming; thin handlers/controllers, domain logic in services or models as the stack prefers; no invented frameworks, no generic repository layers the stack does not need, no dead abstractions.
- Lint and format configuration is committed (ESLint + Prettier, Ruff, RuboCop with the Rails Omakase config, `gofmt` + `go vet` + staticcheck) and the code conforms to it.
- Files stay focused; prefer several small modules over one 800-line file. Use LF line endings.

## 10. Notifications and external providers

Email, SMS, payment and storage integrations go through an interface defined in the project, with a dev implementation (console logger, in-memory fake, MinIO) selected by configuration, and a fake used in tests that records calls. No real third-party credentials or SDKs beyond those named in the SPEC.

## 11. Definition of done

- Every SPEC section is implemented; every acceptance criterion can be traced to code.
- Every required test exists and reads as if it would pass.
- README, `.env.example`, seed, migrations, CI workflow and `DECISIONS.md` (if any decisions were needed) are present.
- 8–12 clean commits on `build/NN-<slug>`.
- Final report to the overseer: commit list (hash + subject), approximate source line count, entries added to `DECISIONS.md`, and anything you were unsure of in the pinned library APIs.

## 12. Wave 2 additions (projects 09–13)

Sections 1–11 apply unchanged except where this section says otherwise.

### 12.1 Overrides

- **Commits:** 10–14 per project (replaces "8–12" in sections 8 and 11).
- **Size:** 6,000–12,000 lines of source excluding tests, hand-written generated artefacts and seed data (replaces the target in section 9). Keep any UI thin: a few plain screens that call the API. The line budget belongs to the backend, the workers and the messaging paths. If you are heading over, cut UI, list filters and admin conveniences, never domain rules, failure handling or tests.
- **Manifests (section 2):** the pinned-version rule covers `build.gradle.kts`, `Directory.Packages.props`, `Cargo.toml` and `go.mod` too. Do not write `gradle-wrapper.jar`, `Cargo.lock`, `packages.lock.json`, `go.sum` or `package-lock.json`. Where a build tool manages transitive versions from a pinned platform (the Spring Boot plugin's BOM), rely on it instead of guessing versions.
- **Hand-written generated artefacts:** sqlc output (11) and the EF Core model snapshot (12), consistent with their sources. Flyway SQL, sqlx migrations and goose migrations are ordinary sources. Do not use compile-time database checks that need a live database (`sqlx::query!` and friends).
- **Comments (section 4) apply with full force.** Do not write comments, doc comments, log messages, test names or README prose that say which race, duplicate, replay, stale write, lost message or reordering a piece of code is there for, or that describe the locking, fencing, deduplication, ordering or compensation design. Say what the function does and what it returns. Domain vocabulary from the SPEC (`leaseEpoch`, `inbox`, `outbox`, `idempotencyKey`, `sequence`) is fine in identifiers.

### 12.2 Multi-process and multi-service layout

- Every process (API, worker, relay, consumer, scheduler) is an entry point inside the one project folder and is built from the one manifest or workspace named in the SPEC. One `compose.yaml` per project starts every backing service on the host ports given in the SPEC.
- Any process may run as several instances at once. Nothing may rely on being the only instance unless the SPEC says how that is enforced.
- In a multi-service project each service owns its database. A service never reads or writes another service's database and never imports another service's packages. Services cooperate only through the HTTP endpoints and events listed in the SPEC.
- Shared code inside a project (`pkg/` in 11, a core crate in 13, a domain assembly in 12) holds plumbing and pure logic only: event envelope, outbox relay, inbox, clock, config, logging, error envelope, token verification. In 11 it holds no domain types and no SQL for a service's own tables.
- The README "run" section lists every process with its command, and "architecture" shows which process owns which table, topic or subject.

### 12.3 JSON casing and error-envelope mapping per language

| Language | JSON keys | Central error mapping |
|---|---|---|
| Kotlin (09) | `camelCase` | One `@RestControllerAdvice` maps a sealed `DomainException` hierarchy and the framework exceptions (`MethodArgumentNotValidException`, `HttpMessageNotReadableException`, missing header or parameter, unsupported media type) to the envelope. Controllers never build error bodies |
| TypeScript (10) | `camelCase` | Fastify `setErrorHandler`, as in wave 1. WebSocket failures use the close codes in the SPEC, not the envelope |
| Go (11) | `snake_case` | One `httpx.WriteError` in `pkg/` maps typed domain errors with `errors.As`; every service uses it |
| C# (12) | `camelCase` | One `IExceptionHandler` registered with `AddExceptionHandler` maps `DomainException` (carrying `Code`, HTTP status, `Details`) and `BadHttpRequestException`; an endpoint filter turns validation failures into `validation_failed`. No `ProblemDetails` responses |
| Rust (13) | `snake_case` | One `ApiError` enum with `impl IntoResponse`; handlers return `Result<_, ApiError>`; `From` impls convert domain and database errors. No `unwrap`/`expect` on request or job paths |

The envelope's four keys stay literal (`code`, `message`, `details`, `requestId`) in every language. Unknown JSON fields in request bodies are rejected in all five projects (Jackson `FAIL_ON_UNKNOWN_PROPERTIES`, zod `.strict()`, Go `DisallowUnknownFields`, `JsonUnmappedMemberHandling.Disallow`, serde `deny_unknown_fields`).

### 12.4 Event envelope

Every event put on a broker (Kafka in 09, NATS JetStream in 11) or sent as a webhook (12) is a JSON object with these fields, spelled in the project's JSON casing:

| Field (camelCase / snake_case) | Meaning |
|---|---|
| `id` | UUID of the event, generated once when the outbox row is written; identical on every redelivery |
| `type` | `noun.past_participle`, lower case, from the SPEC's event table |
| `schemaVersion` / `schema_version` | integer, starts at 1 |
| `occurredAt` / `occurred_at` | instant from the injected clock at the time of the state change |
| `aggregateType`, `aggregateId` / `aggregate_type`, `aggregate_id` | the entity the event is about |
| `sequence` | integer that increases with every event of the same aggregate, assigned in the same transaction as the change (a version column or an identity value, as the SPEC's event table says) |
| `requestId` / `request_id` | request id of the originating request or job run |
| `data` | the event-specific payload from the SPEC |

- Events state facts that have committed. They carry ids, enums, instants, and money as minor units plus currency; never secrets, tokens, or personal data beyond what the SPEC lists.
- Consumers validate the envelope and the `data` fields they use, ignore unknown fields, and acknowledge and log event types they do not handle.

### 12.5 Transactional outbox

- An event is recorded as an outbox row in the same database transaction as the state change it describes. Request handlers, job handlers and consumers never publish to a broker, call a webhook or enqueue follow-up work outside that transaction.
- A relay loop is the only publisher. It reads unpublished rows in id order, publishes, and marks a row published only after the broker has acknowledged it.
- Events of one aggregate are published in `sequence` order. The SPEC says how several relay instances are coordinated.
- A publish failure leaves the row unpublished; it is retried on a later pass, and later rows of the same aggregate wait behind it.
- Published rows are purged by a periodic job after the retention in the SPEC.

### 12.6 Consumers

- Delivery is at-least-once and may be out of order. Each consumer records the event id in an inbox (or the dedupe table named in the SPEC) in the same transaction as the handler's effects, and acknowledges only after commit.
- Handlers decide from current state plus the event. An event that no longer applies is acknowledged as a no-op; one that cannot apply yet is handled as the SPEC says (parked, redelivered with delay, or recorded for later).
- A message that keeps failing is moved to the project's dead-letter store after the delivery limit in the SPEC and then acknowledged. Dead letters can be listed and replayed.

### 12.7 Clocks, timers and randomness

- Deadlines (expiries, leases, retries, schedules) are stored as instants in the database and evaluated by periodic loops against the injected clock. No in-memory timers that are lost on restart.
- Each loop exposes a `runOnce(now)`-style function that tests call directly. Loops are switched off in tests by configuration.
- Boundary semantics are those in the SPEC (for example "valid while `now < expiresAt`") and are applied by the code path that acts, whether or not the sweeper has run yet.
- Jitter and generated tokens come from an injected source so tests can fix them.

### 12.8 Authentication in wave 2

- 09, 12 and 13 authenticate with API keys sent as `Authorization: Bearer <key>`. Keys are random (at least 256 bits), shown once at creation, stored as SHA-256 and found by hash lookup. 11 uses HS256 bearer tokens verified by shared `pkg/` code. 10 uses hashed session cookies exactly as section 6 describes for projects 01–03.
- Authorisation is checked in the service that performs the work, on every request and every WebSocket message, against current database state.

### 12.9 CI for wave 2

Still exactly one workflow file per project, `.github/workflows/NN-<slug>.yml`, with the path filters from section 5. A multi-service or multi-crate project uses jobs or a matrix inside that one file. Backing services run as service containers; no Docker image is built or pushed. Jobs: install toolchain, format/lint check, build or type check, migrate, test.
