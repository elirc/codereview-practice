# 03 — Multi-tenant Issue Tracker

## 1. Purpose

A small Linear/Jira-style tracker. Users belong to one or more organisations; each organisation has projects, issues, comments and labels. Tenants must be fully isolated from each other. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Backend | Node 22, TypeScript 5.7 (`strict`, ESM), Fastify 5.2.0, `@fastify/cookie` 11.0.1, `@fastify/type-provider-typebox` 5.1.0, `@sinclair/typebox` 0.34.13 |
| DB | PostgreSQL 16 (compose host port 5453), Kysely 0.27.5 with `pg` 8.13.1. Plain SQL migrations in `server/migrations/NNNN_name.sql`, applied by a small runner script that records applied files in `schema_migrations` |
| Auth | Email + password (`crypto.scrypt`). Opaque session token in cookie `it_session`, SHA-256 stored in `sessions`, 14-day expiry |
| CSRF | Mutating requests must carry `Content-Type: application/json` and an `Origin` equal to `APP_ORIGIN` |
| Logging | Fastify's pino logger, request id from `X-Request-Id` or generated |
| Tests | Vitest 2.1.8; `fastify.inject` against a real Postgres |
| Frontend | React 18.3.1, Vite 6.0.5, @tanstack/react-query 5.62.8, react-router-dom 6.28.1, Vitest 2.1.8 + @testing-library/react 16.1.0 |

Layout: `server/src/{app.ts,plugins,modules/<area>/{routes,service,repo,schemas}.ts,db,lib}`, `server/migrations`, `server/test`, `web/src`.

Database types for Kysely are hand-written in `server/src/db/types.ts` and must match the migrations.

## 3. Roles and permissions

Membership roles per organisation: `owner`, `admin`, `member`, `viewer`. A user with no membership in an org cannot learn that the org exists.

| Action | viewer | member | admin | owner |
|---|---|---|---|---|
| Read projects, issues, comments, labels, members | yes | yes | yes | yes |
| Create issue; edit any issue's fields; add/remove labels on issues | no | yes | yes | yes |
| Comment | no | yes | yes | yes |
| Edit own comment | – | yes | yes | yes |
| Delete comment | – | own | any | any |
| Delete issue | no | no | yes | yes |
| Create/edit/archive project; create/edit/delete label | no | no | yes | yes |
| Add/remove members, set role to `viewer`/`member`/`admin` | no | no | yes (cannot modify an owner) | yes |
| Grant/revoke `owner`, rename or delete org | no | no | no | yes |

Response rules:

- Not authenticated → `401`.
- Authenticated but not a member of `:orgSlug`, or the org does not exist → `404 not_found` (indistinguishable).
- Member, resource id not in this org or not existing → `404 not_found`.
- Member, resource exists in this org, role insufficient → `403 forbidden`.

## 4. Domain model

Every tenant-owned table carries `org_id` and all foreign keys between tenant tables are composite on `(org_id, <id>)` so a row cannot reference a row in another org.

- **users**: `id`, `email` (unique, lower-case), `name`, `password_hash`.
- **sessions**: `id`, `user_id`, `token_hash` (unique), `expires_at`.
- **orgs**: `id`, `slug` (unique, `^[a-z0-9][a-z0-9-]{1,38}$`), `name`.
- **memberships**: `(org_id, user_id)` PK, `role`. Invariant: every org has at least one `owner`.
- **projects**: `id`, `org_id`, `key` (2–6 upper-case letters, unique per org), `name`, `next_issue_number` (int, starts 1), `archived_at?`. Unique `(org_id, id)`.
- **issues**: `id`, `org_id`, `project_id`, `number` (unique per project), `title` (1–200), `description` (≤ 20,000, plain text/markdown source, rendered as text), `status` (`backlog` | `todo` | `in_progress` | `done` | `cancelled`), `priority` (0 none … 4 urgent), `assignee_id?`, `reporter_id`, `version` (int, starts 1), `created_at`, `updated_at`, `search` (generated `tsvector` from title weight A and description weight B, GIN indexed). FK `(org_id, assignee_id)` → `memberships(org_id, user_id)`.
- **labels**: `id`, `org_id`, `name` (1–40, unique per org case-insensitively), `color` (`#rrggbb`).
- **issue_labels**: `(org_id, issue_id, label_id)` with composite FKs to both sides.
- **comments**: `id`, `org_id`, `issue_id`, `author_id`, `body` (1–10,000), `created_at`, `edited_at?`.

Indexes support the keyset orders in 5.3: `(org_id, project_id, created_at desc, id desc)`, `(org_id, project_id, updated_at desc, id desc)`, `(org_id, project_id, priority desc, id desc)`.

## 5. Domain rules

### 5.1 Tenant scoping

- All tenant routes are under `/api/orgs/:orgSlug`. A Fastify `preHandler` on that prefix resolves the org and the caller's membership once and attaches `request.tenant = { orgId, role, userId }`. If either is missing the request ends with `404`.
- Every repository function for a tenant table takes `orgId` as its first parameter and includes `org_id = $orgId` in the `WHERE` clause of every select, update and delete, including lookups by primary key and by child id. There is no repository function that fetches a tenant row by id alone.
- Ids supplied in bodies (assignee, label ids, project id on move) are resolved within the org; a foreign or unknown id yields `422 invalid_reference` naming the field (not `404`, since the route resource itself exists), and yields the same error whether the id exists elsewhere or not at all.
- Nested routes verify the full chain: `/projects/:projectKey/issues/:number/comments/:commentId` must fail with `404` if the comment belongs to a different issue, even in the same org.
- Responses never include `org_id` of another org, other orgs' counts, or user emails for people who are not members of the current org.

### 5.2 Issues

- Identifier shown to users is `KEY-number` (e.g. `ENG-42`). Numbers are allocated by `UPDATE projects SET next_issue_number = next_issue_number + 1 WHERE org_id = … AND id = … RETURNING next_issue_number - 1` in the same transaction as the insert. Numbers are never reused; gaps are acceptable only from rolled-back transactions.
- Issues cannot be created in an archived project (`422 project_archived`); existing issues there remain readable and are read-only.
- `PATCH` is a partial update and requires `version`. The update statement is `… WHERE org_id = … AND id = … AND version = $version`, sets `version = version + 1`, `updated_at = now`. Zero rows affected and the issue exists → `409 version_conflict` with `details.current` holding the current issue. A PATCH that changes nothing still requires a matching version and does not bump it.
- Assignee must be a member of the org with role other than `viewer` (`422 invalid_reference`). Removing a member unassigns their issues in the same transaction.
- Label set changes are via `PUT …/labels` with the full list of label ids (max 20); it requires and bumps `version` like PATCH.
- Moving an issue to another project in the same org is a PATCH with `projectKey`: it allocates a new number in the target project; the old identifier stops resolving.
- Deleting an issue deletes its comments and label links.

### 5.3 Cursor pagination

Applies to issue lists, comment lists and member lists.

- Parameters: `limit` (1–100, default 25), `cursor` (opaque), and for issues `sort` ∈ `created` (default), `updated`, `priority`; direction is always descending with `id` descending as tie-breaker. Comments are ordered `created_at asc, id asc`.
- Keyset predicate uses row comparison: `(sort_col, id) < ($lastValue, $lastId)` (or `>` for ascending). No `OFFSET`.
- The server fetches `limit + 1` rows; `nextCursor` is present only when the extra row exists and is derived from the last returned row.
- Cursor format: base64url of JSON `{ "s": sort, "v": lastValue, "id": lastId }`. Timestamps in cursors keep microsecond precision (read the column as text for the cursor; do not round-trip through a JS `Date`).
- A cursor that fails to decode, fails schema validation, or whose `s` differs from the request's `sort` → `400 invalid_cursor`. Cursors carry no tenant or filter information and are always combined with the request's own org scope and filters.
- Response shape: `{ items: [...], nextCursor: string | null }`.

### 5.4 Filtering and search

`GET …/issues` accepts `projectKey`, `status` (repeatable), `assigneeId` (or `none`), `labelId` (repeatable; issue must have all), `q`.

- `q` (1–200 chars after trim): if it matches `^[A-Za-z]{2,6}-\d+$`, it is an identifier lookup returning that issue if it exists in the org (list of zero or one). Otherwise it is full-text: `search @@ websearch_to_tsquery('english', $q)`.
- Search results use the same sort and keyset pagination as the list (not relevance ranking), so cursors remain stable.
- `q` is always a bound parameter. A `q` that produces an empty tsquery (only stop words or punctuation) returns an empty list.
- Search is across all projects of the org the caller can see (all of them), never across orgs.

### 5.5 Comments

- Body edits allowed for the author only, any time; sets `edited_at`. Admin/owner may delete but not edit others' comments.
- Adding, editing or deleting a comment does not bump the issue's `version` but does set the issue's `updated_at`.

### 5.6 Membership

- `POST …/members` with `{ email, role }` adds an existing user (no invitations). Unknown email → `422 user_not_found`. Already a member → `409 already_member`.
- An admin cannot change or remove an owner, and cannot grant `owner`.
- Removing or demoting the last owner → `422 last_owner`. The check and the write happen in one transaction that locks the org's owner membership rows (`SELECT … FOR UPDATE`).
- A user may leave an org (`DELETE …/members/me`) subject to the last-owner rule.

### 5.7 Optimistic UI (frontend)

- Issue field edits (status, priority, assignee, title) and label changes apply optimistically with React Query: `onMutate` cancels in-flight queries for the affected keys, snapshots the issue detail cache entry and every cached list page containing the issue, and writes the optimistic value; `onError` restores the snapshots; `onSettled` invalidates.
- The mutation sends the `version` from the cache as it was before the optimistic write. On success the cache takes the server's issue (with new version). On `409 version_conflict` the UI rolls back, replaces the cache with `details.current`, and shows a non-blocking "changed by someone else" notice; it does not retry automatically.
- While a mutation for an issue is in flight, further edits to that issue are queued (one mutation at a time per issue, via a mutation scope/key) so that versions are sent in order.
- Posting a comment appends an optimistic comment with a temporary id and `pending` flag, replaced on success, removed with an inline error and the text restored to the input on failure.
- Query keys always include the org slug; switching org never shows cached data from another org. Logging out clears the query cache.

## 6. API surface

Prefix `/api`. `camelCase` JSON.

| Method & path | Min role | Notes |
|---|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | – | `me` returns user and memberships (`orgSlug`, `orgName`, `role`) |
| `POST /orgs` | authenticated | Creator becomes owner. Slug taken → `409 slug_taken` |
| `GET /orgs/:orgSlug`, `PATCH`, `DELETE` | viewer / owner / owner | |
| `GET /orgs/:orgSlug/members`, `POST`, `PATCH /members/:userId`, `DELETE /members/:userId` | viewer / admin | 5.6 |
| `GET /orgs/:orgSlug/projects`, `POST`, `PATCH /projects/:projectKey`, `POST /projects/:projectKey/archive` | viewer / admin | Key is immutable |
| `GET /orgs/:orgSlug/labels`, `POST`, `PATCH /labels/:labelId`, `DELETE` | viewer / admin | |
| `GET /orgs/:orgSlug/issues` | viewer | 5.3, 5.4 |
| `POST /orgs/:orgSlug/projects/:projectKey/issues` | member | `{ title, description?, status?, priority?, assigneeId?, labelIds? }` |
| `GET /orgs/:orgSlug/projects/:projectKey/issues/:number` | viewer | Includes labels, assignee summary, `version` |
| `PATCH …/issues/:number` | member | `{ version, title?, description?, status?, priority?, assigneeId?, projectKey? }` |
| `PUT …/issues/:number/labels` | member | `{ version, labelIds }` |
| `DELETE …/issues/:number` | admin | |
| `GET …/issues/:number/comments`, `POST` | viewer / member | |
| `PATCH …/comments/:commentId`, `DELETE` | author / author-or-admin | |

All bodies, params and query strings have TypeBox schemas with `additionalProperties: false`; response schemas are declared so Fastify serialisation strips anything undeclared.

Pages: login/register; org switcher; issue list with filters, search box, sort and "load more" (infinite query); issue detail with inline editing, labels, comments; project and label settings; members.

## 7. Background jobs

None. A `scripts/purge-sessions.ts` script deletes expired sessions and is documented as a cron candidate.

## 8. Edge cases

1. User in org A requests `/api/orgs/b-slug/...` → `404`, same body as a non-existent slug.
2. User in orgs A and B requests org A's route with an issue number/project key that exists only in B → `404`.
3. PATCH issue in org A with `assigneeId` of a user who is only in org B → `422 invalid_reference`; same response for a random UUID.
4. `PUT labels` including a label id from another org → `422 invalid_reference`; no partial label changes are applied.
5. Comment id from another issue in the same org under the wrong issue path → `404`.
6. Composite FKs reject a cross-org `issue_labels` or `comments` row even if application checks were bypassed (test by direct insert).
7. Two issues created concurrently in one project get distinct consecutive numbers.
8. Two issues with identical `created_at` paginate without duplicates or gaps (tie-break on id).
9. Under `sort=created`, rows inserted or updated between page fetches never cause an existing row to be skipped or repeated. Under `sort=updated` an issue edited between fetches may legitimately not appear on later pages (it moved ahead of the cursor); this is documented in the README.
10. `limit=100` with exactly 100 rows → `nextCursor: null`; with 101 rows → non-null and page 2 has one item.
11. Tampered cursor (valid base64, wrong shape; or `sort` mismatch) → `400 invalid_cursor`, not `500`.
12. A cursor obtained in org A used on org B's list returns only org B rows.
13. `q` containing `'`, `%`, `:*`, `\`, or unbalanced quotes returns normally.
14. `q=eng-12` (lower-case) resolves the identifier case-insensitively.
15. PATCH with stale `version` → `409` with the current issue; nothing changed.
16. Two concurrent PATCHes with the same version: exactly one succeeds.
17. Viewer attempting any write → `403`; a viewer cannot be an assignee.
18. Admin attempting to demote or remove an owner → `403`.
19. Two owners concurrently demoting each other: at most one succeeds; the org is never left without an owner.
20. Removing a member unassigns their issues and bumps those issues' `version`; their comments remain, attributed to them.
21. Creating an issue in an archived project → `422`; PATCH on an issue in an archived project → `422 project_archived`.
22. Moving an issue to another project: old `KEY-n` path returns `404`, new one resolves; labels and comments are intact.
23. Label names `Bug` and `bug` in one org conflict (`409 label_exists`); the same name in two orgs is fine.
24. Unknown body properties (e.g. `orgId`, `reporterId`, `number`) are rejected with `400`.
25. Expired session → `401`, cookie cleared.
26. Frontend: optimistic status change followed by a `409` shows the server's value, not the stale pre-edit value.
27. Frontend: optimistic update on an issue that appears in two cached list pages (different filters) is rolled back in both.
28. Frontend: two quick edits to one issue are sent sequentially with correct versions.

## 9. Non-goals

Email invitations, notifications, attachments, sub-issues, sprints/cycles, custom workflows, real-time updates (WebSocket/SSE), activity feed, SSO, API tokens, rate limiting, relevance-ranked search.

## 10. Acceptance criteria

- No request by any authenticated user can read, modify, reference or infer the existence of data in an org they are not a member of.
- Lists paginate correctly by keyset under each sort with no duplicates or omissions on static data.
- RBAC matches section 3 exactly, enforced on the server.
- Optimistic updates roll back precisely on failure.
- All edge cases in section 8 hold.

## 11. Required tests

Server (integration, real Postgres, two orgs seeded per test file with overlapping project keys and issue numbers):
- Isolation matrix: for every tenant route, a member of org B calling it for org A's resources gets `404`; and with own org slug + foreign ids gets `404`/`422` as specified.
- Direct-insert test showing composite FKs reject cross-org references.
- RBAC matrix: each role × each write route.
- Issue number allocation under concurrency.
- Pagination: each sort, ties on the sort column, exact-limit boundary, invalid cursor, cursor/sort mismatch, cursor reuse across orgs.
- Search: identifier shortcut, full-text hit on title and description, special characters, stop-word-only query, combination with filters.
- Version conflict (sequential and concurrent), no-op PATCH, label replacement atomicity.
- Membership: last-owner rule including the concurrent case; admin vs owner restrictions; member removal unassigns.
- Schema strictness: unknown properties rejected; response does not leak undeclared fields.

Server (unit): cursor encode/decode, permission table, identifier parsing.

Web:
- Optimistic update hook: success path, error rollback across detail and multiple list caches, conflict path adopting `details.current`, sequential queuing.
- Optimistic comment add and failure restore.
- Query cache cleared on logout; keys include org slug.

## 12. Commit plan

1. `chore`: server scaffold (Fastify app factory, config, logger, error handler/envelope, migration runner), compose, `.env.example`.
2. `feat`: SQL migrations and Kysely types.
3. `feat`: auth and sessions.
4. `feat`: orgs, tenant plugin, memberships and RBAC helper, with isolation tests for these routes.
5. `feat`: projects and labels.
6. `feat`: issues — create, read, patch with versioning, labels, move, delete.
7. `feat`: list, filters, cursor pagination and search.
8. `feat`: comments.
9. `test`: full isolation and RBAC matrices, concurrency tests.
10. `feat`: web scaffold, auth, org switcher, API client, issue list with infinite query.
11. `feat`: web issue detail, optimistic mutations, comments, settings pages, with tests.
12. `docs`/`ci`: seed, README, CI workflow.
