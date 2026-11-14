# Issue Tracker

A small multi-tenant issue tracker in the style of Linear or Jira. Users belong to one or more
organisations; each organisation has projects, issues, comments and labels, and organisations are
fully isolated from one another. A Fastify + PostgreSQL API serves a React single-page app.

## Setup

Requirements: Node 22, Docker (for PostgreSQL 16).

```sh
docker compose up -d                 # PostgreSQL on localhost:5453 (databases issues and issues_test)

cd server
cp .env.example .env
npm install                          # generates package-lock.json
npm run migrate
npm run seed

cd ../web
npm install
```

## Run

```sh
cd server && npm run dev             # API on http://127.0.0.1:3003
cd web && npm run dev                # app on http://localhost:5303, proxies /api to the API
```

`APP_ORIGIN` must equal the origin the browser loads the app from (the Vite dev server in
development). There are no background workers. Expired sessions are removed by
`npm run purge-sessions`, which is meant to run from cron (hourly is plenty).

## Test

```sh
cd server && npm test                # unit + integration tests against issues_test
cd web && npm test                   # hook and component tests in jsdom
```

Server tests use `TEST_DATABASE_URL` (default
`postgres://issues:issues@localhost:5453/issues_test`), apply migrations once, and truncate all
tables before each test. Lint, format and type checks: `npm run lint`, `npm run format:check`,
`npm run typecheck` in either package.

## Architecture

```
server/
  migrations/              plain SQL, applied in order and recorded in schema_migrations
  scripts/                 migrate, seed, purge-sessions
  src/app.ts               Fastify factory: hooks, error handler, route registration
  src/config.ts            environment parsing and validation
  src/db/                  Kysely instance, hand-written table types, SQL helpers, migrator
  src/lib/                 errors, permissions, cursors, identifiers, passwords, tokens, schemas
  src/plugins/             CSRF check, session auth, tenant resolution, error envelope
  src/modules/<area>/      routes.ts (HTTP + schemas), service.ts (rules), repo.ts (queries)
  test/                    integration suites, test/unit for pure logic, test/support helpers
web/
  src/api/                 fetch client, endpoint functions, DTO types, query keys
  src/auth/                session queries and sign-in/out mutations
  src/issues/              optimistic issue edits, comment hooks, cache helpers
  src/org/                 per-org queries shared by pages
  src/pages/               route components
```

Request flow: `onRequest` hooks assign a request id (from `X-Request-Id` when present), reject
mutating requests that are not JSON from `APP_ORIGIN`, and resolve the `it_session` cookie to a
user. Routes under `/api/orgs/:orgSlug` share a `preHandler` that resolves the organisation and
the caller's membership into `request.tenant`, answering `404` when either is missing. TypeBox
schemas validate params, query strings and bodies (unknown properties are rejected) and declare
responses so serialisation drops anything undeclared. Handlers call services, which check the
role, apply the business rules and call org-scoped repository functions; errors become the JSON
envelope in one error handler.

Pagination is keyset-based. Under `sort=created` the order is stable, so issues created between
page fetches never cause a row to be skipped or repeated. Under `sort=updated` an issue edited
between fetches moves ahead of the cursor and may not appear on later pages; reload the list to
see it in its new position.

## Where the hard parts live

| Topic | Files |
|---|---|
| Tenant resolution | `server/src/plugins/tenant.ts`, `server/src/modules/orgs/repo.ts` |
| Org-scoped queries | `server/src/modules/*/repo.ts` |
| Composite tenant keys | `server/migrations/0003_projects_labels.sql`, `server/migrations/0004_issues_comments.sql` |
| Role checks | `server/src/lib/permissions.ts`, `server/src/modules/*/service.ts` |
| Issue numbering | `server/src/modules/issues/repo.ts`, `server/src/modules/issues/service.ts` |
| Optimistic concurrency | `server/src/modules/issues/service.ts`, `server/src/modules/issues/repo.ts` |
| Last-owner rule | `server/src/modules/members/service.ts`, `server/src/modules/members/repo.ts` |
| Cursor pagination | `server/src/lib/cursor.ts`, `server/src/db/sql.ts`, `server/src/modules/issues/repo.ts` |
| Search | `server/src/lib/identifier.ts`, `server/src/modules/issues/service.ts`, `server/src/modules/issues/repo.ts` |
| Sessions and CSRF | `server/src/plugins/auth.ts`, `server/src/plugins/csrf.ts`, `server/src/modules/auth/service.ts` |
| Error envelope | `server/src/plugins/error-handler.ts`, `server/src/lib/errors.ts` |
| Optimistic UI | `web/src/issues/useIssueMutation.ts`, `web/src/issues/useComments.ts`, `web/src/issues/cache.ts` |
| Cache scoping | `web/src/api/keys.ts`, `web/src/auth/session.ts` |

## Seed accounts

All seeded users share the password `tracker-demo-1`. The seed is idempotent.

| Email | Role |
|---|---|
| `owner@acme.test` | owner of Acme Inc. (`acme`) |
| `admin@acme.test` | admin of `acme` |
| `member@acme.test` | member of `acme` and of Globex Corporation (`globex`) |
| `viewer@acme.test` | viewer of `acme` |
| `owner@globex.test` | owner of `globex` |

`acme` has projects ENG and OPS plus an archived project OLD, three labels, issues in every
status and a few comments. `globex` has its own ENG project whose ENG-1 overlaps Acme's.
