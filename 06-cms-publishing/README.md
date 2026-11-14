# Field Notes — CMS with drafts and publishing

A small editorial CMS. Authors write posts as a series of immutable revisions; editors review, publish or schedule a specific revision; a cached public site serves only the published revision. Media is uploaded to S3-compatible storage (MinIO locally) and served through the app.

## Setup

Requirements: Node 22, Docker (for Postgres 16 and MinIO).

```sh
cp .env.example .env
docker compose up -d            # Postgres on 5456, MinIO on 9006 (console 9007), creates the cms-media bucket
npm install                     # generates package-lock.json; commit it if you want reproducible installs
npm run db:migrate              # applies drizzle/*.sql
npm run db:seed                 # idempotent; creates the seed accounts below and sample posts/media
```

The compose init script also creates a `cms_test` database for the integration tests.

Schema changes: edit `src/db/schema.ts`, then `npm run db:generate` and review the generated SQL. The repository ships migrations without drizzle-kit snapshot files, so the first `db:generate` after cloning should be checked against the existing SQL before committing (see `DECISIONS.md`).

## Run

```sh
npm run dev          # web app on http://localhost:3006 (admin at /admin)
npm run scheduler    # separate process: POSTs /api/internal/cron/publish every 30 s
```

Production: `npm run build && npm start`, plus `npm run scheduler` with `APP_URL` pointing at the app. The scheduler only needs `APP_URL`, `CRON_SECRET`, `SCHEDULER_INTERVAL_MS` and `LOG_LEVEL`. Scheduled posts are published inside the Next process so cache invalidation reaches the data cache.

Set `STORAGE_DRIVER=memory` to run without MinIO (uploads then live only as long as the process).

## Test

```sh
npm run lint && npm run format:check && npm run typecheck
npm run test:unit            # pure logic, no services needed
npm run test:integration     # needs Postgres; uses TEST_DATABASE_URL (default cms_test on 5456)
```

Integration tests apply migrations to the test database, truncate tables before each test, stub `next/headers` (cookies, headers, draft mode) and `next/cache` (a tag-aware fake that JSON round-trips like the real data cache), and use the in-memory media storage.

## Architecture

```
src/
  app/
    (public)/            home page (paginated) and /posts/[slug]
    admin/               login, posts list, editor, revisions/diff, media library, users
    preview/[postId]/[revisionId]/   draft preview page (dynamic, noindex)
    api/media/           POST upload
    api/preview/         GET: checks access, enables draft mode, redirects to the preview page
    api/internal/cron/publish/   POST: scheduled publishing tick (bearer secret)
    api/health/          GET
    media/[id]/          GET: streams a stored object
  actions/               server actions ("use server"): parse -> requireUser -> service -> invalidate
  services/              transactions and domain rules (posts, revisions, workflow, slugs, media, users)
  auth/                  password hashing, sessions, requireUser, policy, page guards
  cache/                 tag names, cached public readers, invalidation helper
  media/                 storage interface (S3 + memory), sniffing, keys, filenames, upload handling
  db/                    Drizzle schema, client, migrator
  http/                  error envelope, request ids, cron secret check, same-origin check
drizzle/                 SQL migrations + meta/_journal.json
scripts/                 scheduler and seed
tests/unit, tests/integration
```

Request flow for an editorial change: a client form calls a server action with a plain object → the action validates it with zod and loads the session user → the service opens a transaction, locks the post row, checks the policy, `expectedVersion` and the workflow table, writes, and commits → the action invalidates cache tags if public content changed → the result `{ ok, data | error }` goes back to the form.

Public reads go through `src/cache/readers.ts` (`unstable_cache` with `post:<id>`, `post-slug:<slug>` and `posts:list` tags). The scheduler process calls the cron route, which publishes due posts in batches and invalidates each batch after it commits.

## Where the hard parts live

| Topic | Files |
|---|---|
| Revision numbering and version checks | `src/services/revisions.ts`, `src/services/post-guards.ts` |
| Workflow transitions | `src/services/workflow-rules.ts`, `src/services/workflow.ts` |
| Authorisation | `src/auth/policy.ts`, `src/services/post-guards.ts`, `src/actions/*.ts` |
| Sessions | `src/auth/session.ts`, `src/auth/current-user.ts`, `src/actions/auth.ts` |
| Slugs and redirects | `src/services/slugs.ts`, `src/services/posts.ts`, `src/services/public-posts.ts` |
| Caching and invalidation | `src/cache/readers.ts`, `src/cache/invalidate.ts`, `src/cache/tags.ts` |
| Scheduled publishing | `src/services/scheduled-publishing.ts`, `src/app/api/internal/cron/publish/route.ts`, `src/http/cron-auth.ts`, `scripts/scheduler.ts` |
| Upload validation | `src/media/upload.ts`, `src/media/sniff.ts`, `src/media/keys.ts`, `src/media/filename.ts`, `src/media/dimensions.ts` |
| Media serving and deletion | `src/app/media/[id]/route.ts`, `src/media/headers.ts`, `src/services/media.ts` |
| Markdown sanitising | `src/services/markdown.ts` |
| Preview | `src/app/api/preview/route.ts`, `src/app/preview/[postId]/[revisionId]/page.tsx`, `src/services/preview.ts` |
| Database invariants | `drizzle/0000_initial_schema.sql`, `drizzle/0001_revisions_immutable.sql` |
| Error envelope | `src/http/errors.ts`, `src/services/errors.ts`, `src/actions/result.ts` |

## Seed accounts

All seed accounts use the password `field-notes-dev-password`.

| Email | Role |
|---|---|
| admin@example.com | admin |
| editor@example.com | editor |
| author@example.com | author |
| author2@example.com | author |

The seed creates published, scheduled, in-review, draft and archived posts, a published post with unpublished edits, a renamed post whose old slug (`/posts/getting-started`) redirects, and one cover image.
