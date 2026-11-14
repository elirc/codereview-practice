# 06 — CMS with Drafts and Publishing

## 1. Purpose

A small editorial CMS: authors write posts as a series of immutable revisions, editors review, publish or schedule them, and a cached public site serves the published revision. Media is uploaded to S3-compatible storage. Read `../CONVENTIONS.md` first.

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript 5.7 (`strict`) |
| Web | Next.js 15.1.3 App Router, React 19.0.0. `params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` are async. Caching via `unstable_cache` with tags and `revalidateTag` / `revalidatePath` (single-argument forms) |
| DB | PostgreSQL 16 (compose host port 5456), drizzle-orm 0.38.3 with `postgres` 3.4.5, drizzle-kit 0.30.1. Migrations in `drizzle/` as SQL files plus `meta/_journal.json`, applied by `src/db/migrate.ts` |
| Storage | `@aws-sdk/client-s3` 3.716.0 against MinIO locally (compose ports 9006/9007), `forcePathStyle: true`. Private bucket |
| Upload sniffing | file-type 19.6.0 |
| Markdown | marked 15.0.4 rendered then sanitised with sanitize-html 2.14.0 (allow-list in one module) |
| Validation | zod 3.24.1 |
| Logging | pino 9.6.0 |
| Tests | Vitest 2.1.8; integration against real Postgres; S3 behind a `MediaStorage` interface with an in-memory fake |
| Auth | Email + password (`crypto.scrypt`); opaque session token in cookie `cms_session`, SHA-256 stored in `sessions`; 14-day expiry. No self-registration; admins create users |
| Scheduler | `scripts/scheduler.ts` (run with tsx 4.19.2): every 30 s it POSTs `/api/internal/cron/publish` with header `Authorization: Bearer $CRON_SECRET`. The publishing work runs inside the Next process so that cache invalidation works |

Layout: `src/app/(public)` (site), `src/app/admin` (CMS UI), `src/app/api` (route handlers: media, internal cron, preview), `src/actions` (server actions, `"use server"`), `src/services` (transactions and rules, framework-free), `src/auth` (session, `requireUser`, policy), `src/cache` (tag names, cached readers, invalidation helper), `src/media`, `src/db`.

Server actions are thin: parse input with zod, authenticate, authorise, call a service, invalidate cache, return `{ ok: true, data }` or `{ ok: false, error: { code, message, details } }` (the error envelope's inner object). They never throw business errors to the client. Route handlers use the full JSON envelope.

## 3. Roles and permissions

`author`, `editor`, `admin`. Unauthenticated visitors see only the public site.

| Action | author | editor | admin |
|---|---|---|---|
| Create post | yes | yes | yes |
| View post in admin, list revisions, diff, preview | own | all | all |
| Save a new revision, restore an old revision | own, unless the post is `archived` | all | all |
| Submit for review / withdraw from review | own | all | all |
| Publish, schedule, cancel schedule, unpublish, archive | no | yes | yes |
| Change slug | own while never published | yes | yes |
| Delete post | own, only if never published | no | yes |
| Upload media | yes | yes | yes |
| Delete media | own, if unreferenced | any, if unreferenced | any, if not referenced by a published or scheduled revision |
| Manage users | no | no | yes |

Every server action and route handler calls `requireUser()` and the policy function itself. Layout or middleware checks are for redirects only and are not relied on. A post the caller may not view yields `not_found` (and `notFound()` in pages), never `forbidden`.

## 4. Domain model

- **users**: `id`, `email` (unique lower-case), `name`, `passwordHash`, `role`, `active`.
- **sessions**: `id`, `userId`, `tokenHash` (unique), `expiresAt`.
- **posts**: `id`, `slug` (unique, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1–120), `authorId`, `status` (`draft` | `in_review` | `scheduled` | `published` | `archived`), `latestRevisionId?`, `publishedRevisionId?`, `scheduledRevisionId?`, `scheduledFor?`, `firstPublishedAt?`, `publishedAt?`, `version` (int), `createdAt`, `updatedAt`. Checks: `status = 'scheduled'` ⇔ `scheduledFor` and `scheduledRevisionId` are both non-null; `status = 'published'` ⇒ `publishedRevisionId` non-null.
- **revisions** (immutable): `id`, `postId`, `number` (1-based, unique per post), `title` (1–200), `excerpt` (≤ 500), `body` (markdown, ≤ 200,000 chars), `coverMediaId?`, `createdBy`, `createdAt`, `restoredFromNumber?`. No update or delete path exists in the application; a DB trigger rejects `UPDATE`.
- **slug_redirects**: `oldSlug` (PK), `postId`. A slug in this table cannot be used as a new post's slug unless it belongs to the same post.
- **media**: `id`, `storageKey` (unique), `originalFilename`, `contentType`, `sizeBytes`, `sha256`, `width?`, `height?`, `uploadedBy`, `createdAt`.
- **revision_media**: `(revisionId, mediaId)` — media referenced by a revision (cover plus any `media:<uuid>` references in the body, extracted at save time).

## 5. Domain rules

### 5.1 Revisions

- Every save creates a new revision with `number = max + 1`, allocated under a row lock on the post (`SELECT … FOR UPDATE`) in the same transaction; `latestRevisionId` moves to it. Revisions are never edited or deleted (except when the whole post is deleted).
- Save requires `expectedVersion`; mismatch → `version_conflict` (details: current version, latest revision number, who saved it). `version` is bumped by every mutation of the post row.
- A save whose title, excerpt, body and cover are all identical to the latest revision creates nothing and returns the latest revision.
- Restore of revision N creates a new revision copying N's content with `restoredFromNumber = N`. It never moves `publishedRevisionId`.
- The public site serves `publishedRevisionId` only. Saving new revisions on a published post does not change the public content until an editor publishes again.
- Diff view compares any two revisions of the same post (line diff of body computed server-side with a small LCS implementation in `src/services/diff.ts`; no library).
- Referenced media: on save, `coverMediaId` and every `media:<uuid>` reference in the body must exist (`invalid_media_reference`); they are recorded in `revision_media`.

### 5.2 Workflow

| From | Action | To | Who |
|---|---|---|---|
| `draft` | submit | `in_review` | author (own), editor, admin |
| `in_review` | withdraw / request changes | `draft` | author (own, withdraw), editor, admin |
| `draft`, `in_review`, `published` | publish revision R | `published` | editor, admin |
| `draft`, `in_review`, `published` | schedule revision R at T | `scheduled` | editor, admin |
| `scheduled` | cancel schedule | `published` if `publishedRevisionId` is set, else `draft` | editor, admin |
| `scheduled` | scheduler fires | `published` | system |
| `published` | unpublish | `draft` | editor, admin |
| any except `archived` | archive | `archived` | editor, admin |
| `archived` | unarchive | `draft` | editor, admin |

- Authors may save revisions on their own posts in any status except `archived`. While `in_review` or `scheduled`, an author's saves are allowed and do not change status or what is scheduled.
- Publish takes `revisionId` (must belong to the post; `invalid_revision`) and `expectedVersion`. Sets `publishedRevisionId`, `publishedAt = now`, `firstPublishedAt` only if null, clears schedule fields.
- Schedule takes `revisionId`, `scheduledFor` (must be `>= now + 60 s`, `schedule_in_past` otherwise; max one year ahead) and `expectedVersion`. The revision is pinned in `scheduledRevisionId`; later saves do not change it. Re-scheduling replaces both fields. A currently published post stays publicly visible with its old revision while `scheduled`.
- Unpublish and archive clear `publishedRevisionId`, `publishedAt` and schedule fields; `firstPublishedAt` is kept.
- Slug change: allowed per section 3. If the post has ever been published (`firstPublishedAt` set), the old slug is inserted into `slug_redirects`; the public route for an old slug issues a permanent redirect to the current slug. Changing back to a slug that redirects to the same post removes that redirect row.
- All transitions run in a transaction that locks the post row and checks `expectedVersion` and the current status under the lock; illegal transition → `invalid_state`.

### 5.3 Scheduled publishing

`POST /api/internal/cron/publish`:

- Requires `Authorization: Bearer <CRON_SECRET>` compared in constant time (`crypto.timingSafeEqual` on equal-length buffers); otherwise `401`. Not callable via session.
- Loop: in a transaction, select up to 20 posts `WHERE status = 'scheduled' AND scheduled_for <= now ORDER BY scheduled_for FOR UPDATE SKIP LOCKED`; for each, publish `scheduledRevisionId` exactly as a manual publish would (with `publishedAt = now`, not `scheduledFor`), commit, then invalidate caches for those posts. Repeat until no rows or 200 posts handled in this call.
- Responds `{ published: [postId…] }`. Overlapping calls (two scheduler instances, slow run) never publish a post twice and never block each other.
- A post whose schedule was cancelled or changed to the future before the tick is not selected. A failure on one batch rolls back that batch only; the next tick retries. Cache invalidation happens only after commit.
- The scheduler script logs non-2xx responses and network errors and keeps ticking; it does not overlap its own requests (waits for the previous response before the next tick).

### 5.4 Caching

Public reads go through cached readers in `src/cache/readers.ts` built with `unstable_cache`:

| Reader | Tags |
|---|---|
| `getPublishedPostBySlug(slug)` (returns post + published revision + rendered HTML, or a redirect target, or null) | `post-slug:<slug>` and, when found, `post:<id>` |
| `listPublishedPosts(page)` | `posts:list` |

Tag names come from one module. Invalidation is one helper, `invalidatePost({ id, slugs: [...] })`, called after the transaction commits:

| Event | Invalidate |
|---|---|
| Publish (manual or scheduled), unpublish, archive, delete of a published post | `post:<id>`, `post-slug:<current slug>`, `posts:list` |
| Slug change of a published post | `post:<id>`, `post-slug:<old>`, `post-slug:<new>`, `posts:list` |
| Save/restore revision, submit, withdraw, schedule, cancel schedule | none (public content unchanged) |
| Media delete | none (media referenced by a published or scheduled revision cannot be deleted, see 5.5) |

Admin pages and preview are dynamic and never cached (`export const dynamic = "force-dynamic"` or reading cookies). Cached readers never read cookies or sessions and never return draft content. A null result (unknown slug) is cached under `post-slug:<slug>` so that a later publish under that slug invalidates it.

Preview: `GET /api/preview?postId=&revisionId=` requires a session with view permission on the post, enables `draftMode()`, and redirects to `/preview/[postId]/[revisionId]`, a dynamic page that re-checks session and permission on every request and renders with `robots: noindex`.

### 5.5 Media uploads

`POST /api/media` (`multipart/form-data`, field `file`, session required):

- Size limit 10 MiB, enforced by counting bytes while reading the stream and aborting at the limit (`413 file_too_large`). `Content-Length` is used only for early rejection, never as proof of size.
- Type is determined by `fileTypeFromBuffer` on the content. Allow-list: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `application/pdf`. Undetectable or other types (including SVG and HTML) → `415 unsupported_media_type`. The client's declared type and the filename extension are ignored for this decision.
- Storage key is generated by the server: `media/<yyyy>/<mm>/<uuid>.<ext>` with `ext` from the sniffed type. No part of the key comes from user input.
- `originalFilename` is metadata only: take the final path segment after splitting on `/` and `\`, normalise to NFC, remove control characters, trim, cap at 200 characters, fall back to `file` if empty.
- Stored object gets `ContentType` = sniffed type. `sha256` computed during upload. Image dimensions are read from the header bytes for PNG/JPEG/GIF/WebP by a small parser; failure leaves them null.
- If the DB insert fails after the object was stored, the object is deleted (best effort, logged).

`GET /media/[id]`: public for media referenced by any currently published revision; otherwise requires a session (any role). Streams the object with `Content-Type` from the DB, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Content-Disposition`: `inline` for images, `attachment` for PDF, with the filename encoded per RFC 5987 (`filename*=UTF-8''…`) plus an ASCII fallback. The id must be a UUID; the object is looked up by DB row, never by a client-supplied key.

Delete: refused with `media_in_use` if any revision that is some post's `publishedRevisionId` or `scheduledRevisionId` references it (all roles); authors and editors are additionally refused if any revision references it.

### 5.6 Rendering

Markdown → HTML with marked, then sanitize-html with an explicit allow-list (headings, paragraphs, lists, emphasis, links with `http`/`https`/`mailto` schemes and `rel="noopener noreferrer"`, images whose `src` is a `/media/<uuid>` path, code, blockquote, tables). `media:<uuid>` references are rewritten to `/media/<uuid>` before sanitising. Raw HTML in markdown does not survive unless allow-listed. The same renderer serves public pages and preview.

## 6. Surface

Server actions (`src/actions`): `createPost`, `saveRevision`, `restoreRevision`, `submitForReview`, `withdrawFromReview`, `publishPost`, `schedulePost`, `cancelSchedule`, `unpublishPost`, `archivePost`, `unarchivePost`, `changeSlug`, `deletePost`, `deleteMedia`, `createUser`, `updateUser`, `login`, `logout`. Each takes a plain object validated by zod; ids are UUIDs; all post mutations take `expectedVersion`.

Route handlers: `POST /api/media`, `GET /media/[id]`, `GET /api/preview`, `POST /api/internal/cron/publish`, `GET /api/health`.

Pages: public `/` (paginated list, 10 per page), `/posts/[slug]`; admin `/admin/login`, `/admin/posts` (filters by status, author), `/admin/posts/[id]` (editor with markdown textarea, cover picker, status bar and actions shown per policy), `/admin/posts/[id]/revisions` (list, diff, restore, publish/schedule a specific revision), `/admin/media` (upload, grid, delete), `/admin/users`; `/preview/[postId]/[revisionId]`.

## 7. Background jobs

Only the scheduled-publish tick (5.3). Failure semantics: at-least-once ticks, exactly-once publish per schedule through row locking and the status check; a missed tick is caught up by the next; publishing late uses the actual time as `publishedAt`. If the Next process is down, nothing is published until it is back; nothing is lost.

## 8. Edge cases

1. Two saves with the same `expectedVersion`: one creates revision N+1, the other gets `version_conflict`; no duplicate revision numbers.
2. Identical-content save creates no revision and does not bump `version`.
3. Restore of revision 2 on a post at revision 7 creates revision 8 with `restoredFromNumber = 2`; published content unchanged.
4. Author saves revision 9 while revision 8 is scheduled: the scheduler publishes revision 8.
5. Author calls `publishPost` directly (crafted request) → `forbidden`; nothing changes.
6. Author calls `saveRevision` with another author's post id → `not_found`.
7. Deactivated user's existing session is rejected on the next action.
8. Publish with a `revisionId` belonging to another post → `invalid_revision`.
9. Schedule for now + 59 s → rejected; now + 60 s → accepted.
10. Cancel schedule on a post that was published before scheduling → returns to `published` with the old revision still live; on a never-published post → `draft`.
11. Two overlapping cron calls: each due post published once; one invalidation per publish.
12. Cron call with a missing, wrong, or different-length secret → `401` without timing-dependent comparison errors.
13. Schedule moved to the future a moment before the tick → not published.
14. Manual publish of a `scheduled` post is not a legal transition (cancel first) → `invalid_state`.
15. Publish invalidates the post page, the list, and the slug tag; the public page shows the new revision on next request.
16. A slug requested before any post had it (cached as not found) resolves after a post is published with that slug.
17. Slug change of a published post: old URL redirects permanently; both slug tags invalidated; changing back removes the redirect.
18. New post cannot take a slug that is another post's redirect (`slug_taken`), nor an existing slug.
19. Unpublish: public URL returns 404 after invalidation; `firstPublishedAt` retained so the author can no longer change slug or delete.
20. Draft content never appears through a cached reader: saving a revision on a published post leaves the public page unchanged even after cache expiry.
21. Preview URL opened without a session or by an author who does not own the post → 404.
22. Upload of `photo.jpg` containing HTML → `415`. Upload of a PNG named `x.pdf` is stored as `image/png` with a `.png` key.
23. SVG upload → `415`.
24. Upload of 10 MiB exactly succeeds; one byte more fails, including when sent chunked without `Content-Length`.
25. Filename `../../../etc/passwd`, `..\\..\\x.png`, or one containing CR/LF or `"`: storage key unaffected; stored name is the sanitised last segment; download header is well-formed.
26. `GET /media/<non-uuid>` → 404 without touching storage.
27. Media referenced only by drafts is not publicly fetchable; after the referencing revision is published it is.
28. Deleting media referenced by a published or scheduled revision → `media_in_use` for every role.
29. Markdown containing `<script>`, `onerror=` attributes, `javascript:` links or an external image → none survive rendering.
30. Body referencing `media:<uuid>` that does not exist → save rejected.
31. Deleting a never-published own post as author removes its revisions; as author on a once-published post → `forbidden`.
32. Archive of a published post removes it from the public list and page, with invalidation.

## 9. Non-goals

Comments, categories/tags, multi-language, rich-text editor, image resizing/CDN, collaborative editing, autosave, full-text search, RSS, self-registration, password reset, audit log.

## 10. Acceptance criteria

- Revision history is complete, immutable and correctly numbered under concurrent saves.
- Only editors/admins can change what is public, regardless of how the request is made.
- The public site always reflects the latest publish/unpublish/slug change after the action returns, and never serves draft content.
- Scheduled posts publish once, with the pinned revision.
- Uploads are constrained by sniffed type and true size, and user-supplied names never influence storage keys or headers unsafely.
- All edge cases in section 8 hold.

## 11. Required tests

Unit:
- Policy table: every action × role × ownership × relevant post state.
- Workflow transition table (legal and illegal).
- Filename sanitiser and Content-Disposition builder with hostile inputs.
- Storage key generation never includes input.
- Type sniffing wrapper with fixture byte headers (JPEG, PNG, WebP, GIF, PDF, HTML, SVG, empty).
- Markdown renderer/sanitiser XSS cases and `media:` rewriting.
- Line diff.
- Constant-time secret check with unequal lengths.

Integration (Postgres; `next/cache` mocked to record `revalidateTag`/`revalidatePath` calls; in-memory storage):
- Save/restore numbering and version conflicts, including concurrent saves; no-op save.
- Each server action called as each role (direct invocation with a stubbed session) — asserts both the result and that state is unchanged on refusal.
- Publish / schedule / cancel / unpublish / archive transitions and their exact invalidation tag sets; no invalidation on draft saves.
- Cron handler: auth, due selection, pinned revision, concurrent invocations, rescheduled-away post, catch-up of several overdue posts.
- Slug change redirects and tag invalidation; slug uniqueness against redirects.
- Upload route: size boundary (streamed), type rejection, key shape, DB failure cleans up object.
- Media GET authorisation (draft-only vs published), headers; delete rules.
- Preview authorisation.

## 12. Commit plan

1. `chore`: scaffold (Next config, tsconfig, lint, env module, logger, compose with Postgres + MinIO, `.env.example`).
2. `feat`: Drizzle schema, initial migration (constraints, revision trigger), migrate script.
3. `feat`: auth — sessions, login/logout actions, `requireUser`, policy module with tests, user management.
4. `feat`: posts and revisions services — create, save, restore, diff — with tests.
5. `feat`: workflow services and server actions — submit, publish, schedule, unpublish, archive, slug change.
6. `feat`: cache layer — tags, cached readers, invalidation — and public site pages, markdown rendering.
7. `feat`: scheduled publishing — cron route and scheduler script — with tests.
8. `feat`: media — storage interface, upload route, serving route, delete, tests.
9. `feat`: admin UI — post list, editor, revisions/diff, media library, users.
10. `feat`: preview mode.
11. `test`: authorisation matrix for all actions and invalidation assertions.
12. `docs`/`ci`: seed, README, CI workflow.
