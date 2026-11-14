# Shared conventions for all eight projects

These rules apply to every project folder (`01-clinic-booking` … `08-volunteer-scheduler`). Each project's `SPEC.md` is the source of truth for business rules; this file is the source of truth for how the work is done. Where the two conflict, the SPEC wins for domain behaviour and this file wins for process.

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
