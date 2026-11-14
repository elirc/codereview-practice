# Decisions

Points where the spec was open or ambiguous, and what was chosen.

1. **Where post authorisation runs.** Every server action authenticates with `requireUser()`; post-level policy checks (`authorizePost`) run inside the service transaction, after the post row is locked, so ownership, status and `firstPublishedAt` are checked against the same state the change is applied to. Non-post actions (`createPost`, `createUser`, `updateUser`, upload) call the policy in the action or route.

2. **Order of checks.** Input validation, then authentication, then (under the row lock) visibility (`not_found`), permission (`forbidden`), `expectedVersion` (`version_conflict`), workflow state (`invalid_state`), then action-specific checks (`invalid_revision`, `schedule_in_past`, ...). A crafted call by an author therefore gets `forbidden` even with a stale version.

3. **Re-scheduling.** The transition table lists `schedule` only from `draft`, `in_review` and `published`, but the rules say "re-scheduling replaces both fields" and an edge case moves a schedule to the future. `schedule` is therefore also allowed from `scheduled`; manual `publish` from `scheduled` stays illegal.

4. **Schedule horizon.** "Max one year ahead" is implemented as 365 × 24 h from now and rejected with a new code, `schedule_too_far` (422), since the spec names no code.

5. **Error codes not named in the spec.** `invalid_credentials` (401) for failed login, `email_taken` (409) for duplicate users, `schedule_too_far` (422). `invalid_state`, `version_conflict`, `slug_taken` and `media_in_use` map to 409; `invalid_revision`, `schedule_in_past` and `invalid_media_reference` to 422.

6. **Creating a post.** `createPost` takes `slug` and `title` and creates revision 1 with that title and an empty excerpt and body, so a post always has a latest revision.

7. **Restore always creates a revision.** The no-op rule is stated for saves; restoring a revision whose content equals the latest still creates a new revision, as an explicit record of the restore. Restores validate media references like saves.

8. **Cover media is not a foreign key.** Revisions are immutable and admins may delete media referenced only by drafts, so `revisions.cover_media_id` has no FK; `revision_media` (with `ON DELETE CASCADE`) carries the reference. A restore, publish or schedule of a revision whose media was deleted is rejected with `invalid_media_reference`. If the pinned revision of an already scheduled post loses its media, the scheduler logs a warning and leaves that post scheduled; the rest of the batch is still published.

9. **Slug uniqueness across posts and redirects** is enforced in the service under transaction-scoped advisory locks on the slugs involved, in addition to the unique index on `posts.slug` and the primary key on `slug_redirects.old_slug`.

10. **Which changes count as public.** A post is public when `publishedRevisionId` is set (which includes a `scheduled` post that is still live). Archive, delete and slug change invalidate when the post was public; publish always invalidates.

11. **Cached slug lookups.** `getPublishedPostBySlug` caches the slug → post id lookup under `post-slug:<slug>` (including misses) and the published content under `post:<id>` and `post-slug:<slug>`. The content step re-checks that the requested slug is the post's current slug or one of its redirects, so a stale lookup can never serve a post under a slug it does not own.

12. **Media access without a session.** Media that is not referenced by a published revision returns `404` (not `401`) to visitors, so its existence is not revealed.

13. **Upload size accounting.** The request body is read as a stream and aborted once it exceeds 10 MiB plus 64 KiB of multipart overhead; the parsed file is then checked against exactly 10 MiB. Both failures return `413 file_too_large`. A `Content-Length` above the same bound is rejected before reading.

14. **CSRF for the upload route.** The spec names no mechanism. Server actions rely on Next.js's built-in Origin check and the `SameSite=Lax` session cookie; `POST /api/media` additionally rejects requests whose `Origin` does not match the host.

15. **Login and logout** are the only actions that do not call `requireUser()`: login creates the session, and logout clears any session cookie it is given.

16. **Admin may delete published posts.** The table gives admins "yes" for delete without a state restriction; deleting a published post invalidates its public cache entries.

17. **Migration snapshots.** Migrations are SQL plus `meta/_journal.json` as the spec asks; drizzle-kit snapshot JSON files are not included. The revision-immutability trigger is a separate custom migration.

18. **App port.** The spec fixes database and MinIO ports only; the app runs on 3006.
