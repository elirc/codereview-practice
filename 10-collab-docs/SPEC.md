# 10 — Collaborative Docs

## 1. Purpose

A real-time collaborative plain-text document editor for teams. People in a workspace create documents, share them with a role or by link, edit together over WebSockets with live presence, leave comments anchored to ranges of text, and browse and restore earlier versions. Document content is a Yjs CRDT persisted as an update log plus snapshots in Postgres; several server instances stay in step through Redis pub/sub. Read `../CONVENTIONS.md` first, including section 12.

Conventions pointer: doc comments and comments say what a function does and returns. They never name the race, replay, lost message or stale permission a piece of code is there for, and never describe the locking, ordering, catch-up or authorisation design (CONVENTIONS §4 and §12.1).

## 2. Stack and fixed decisions

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript 5.7 (`strict`, ESM), run with `tsx` 4.19.2 |
| HTTP | Fastify 5.2.0, `@fastify/cookie` 11.0.1. Request schemas with zod 3.24.1 (`.strict()` objects), parsed in a small `validate` helper; no type provider |
| WebSocket | `ws` 8.18.0 (`@types/ws` 8.5.13) in `noServer` mode, attached to Fastify's underlying `server` `upgrade` event. `maxPayload` 300,000 bytes. No `@fastify/websocket`, no `y-websocket` |
| CRDT | `yjs` 13.6.20, `y-protocols` 1.0.6 (`sync`, `awareness`), `lib0` 0.2.98 (`encoding`, `decoding`). Document content is one `Y.Text` named `content`. Garbage collection stays enabled (`doc.gc = true`) |
| DB | PostgreSQL 16 (compose host port 5462), Kysely 0.27.5 with `pg` 8.13.1. Plain SQL migrations in `server/migrations/NNNN_name.sql` applied by a runner that records files in `schema_migrations`. Kysely table types hand-written in `server/src/db/types.ts` |
| Pub/sub | Redis 7 (compose host port 6391), `ioredis` 5.4.1; one publishing connection and one subscribing connection per instance |
| Logging | Fastify's pino logger; WebSocket logs carry `connectionId`, `docId`, `userId`. Request logs record the path with the value of the `link` query parameter replaced, so a link token never appears in a log |
| Tests | Vitest 2.1.8. Integration tests use real Postgres and Redis, `fastify.inject` for HTTP and real `ws` clients against servers listening on port 0. Multi-instance tests start two app instances in one process. Tests wait on promises resolved by received frames, never on timers |
| Frontend | React 18.3.1, Vite 6.0.5, react-router-dom 6.28.1, `yjs`/`y-protocols`/`lib0` as above. Plain `<textarea>` editor; one stylesheet |
| Auth | Email + password (`crypto.scrypt`), opaque session token in cookie `cd_session`, SHA-256 stored, 14-day expiry |
| CSRF | Mutating HTTP requests need `Content-Type: application/json` and an `Origin` equal to `APP_ORIGIN`. WebSocket upgrades need the same `Origin` |

Processes: `server` (HTTP + WebSocket, any number of instances; ports 8100 and 8101 in the README's two-instance recipe), `worker` (compaction, automatic versions, trash purge), `migrate`, `seed`. Vite dev server on 5180 proxies `/api` and `/ws`.

Layout: `server/src/http` (routes, auth, errors), `server/src/ws` (upgrade, connection, protocol codec, limits), `server/src/collab` (room, room registry, doc store, bus, awareness filter), `server/src/domain` (pure: roles and effective-role resolution, text diff, anchor resolution, token bucket), `server/src/services` (docs, sharing, comments, versions, workspaces), `server/src/worker`, `server/src/db`, `server/src/config`, `web/src` (pages, `collab/provider.ts`, `collab/textareaBinding.ts`).

## 3. Roles and permissions

Workspace roles: `owner` (exactly one), `admin`, `member`. Document roles, ordered: `viewer` < `commenter` < `editor` < `owner`.

**Effective document role** for a principal is the highest of:

1. `owner` if the user is `docs.owner_id`;
2. `editor` if the user is workspace `owner` or `admin`;
3. the role on the user's `doc_shares` row;
4. `docs.workspace_access` (`none` | `viewer` | `commenter` | `editor`) if the user is a workspace member;
5. the role of a presented link token that is not revoked and has `now < expiresAt` (or no expiry). A link with role `commenter` or `editor` counts only for a logged-in user; a `viewer` link also works anonymously.

No source applies → no access. A trashed document gives no access to anyone except through the trash endpoints.

| Action | viewer | commenter | editor | doc owner | workspace admin/owner |
|---|---|---|---|---|---|
| Read document, connect, see presence and comments | yes | yes | yes | yes | yes |
| Send presence | yes (not anonymous) | yes | yes | yes | yes |
| Create threads and replies; edit or delete own comment | no | yes | yes | yes | yes |
| Resolve or reopen a thread | no | own threads | yes | yes | yes |
| Send content updates | no | no | yes | yes | yes |
| Rename; list, create and restore versions | no | no | yes | yes | yes |
| Manage shares, links and `workspace_access` | no | no | no | yes | yes |
| Trash, restore from trash, transfer ownership | no | no | no | yes | yes |
| Create documents | any workspace member | | | | |
| Manage members, workspace settings | workspace `admin`/`owner`; only the `owner` changes admins or transfers the workspace | | | | |

Relationship constraints:

- A document's owner must be a member of its workspace. Ownership can be transferred only to a workspace member.
- A share may name a non-member only when the workspace has `allowExternalSharing = true` (`422 external_sharing_disabled`). A share never grants `owner`. Sharing with the current owner is refused.
- Removing a member, in one transaction: deletes their shares on the workspace's documents unless external sharing is on, transfers documents they own to the workspace owner, and bumps the permission epoch (5.6). The workspace owner cannot be removed or demoted; transfer the workspace first.
- Turning `allowExternalSharing` off deletes existing shares held by non-members.

HTTP: no access to a document → `404 not_found`; access with too low a role → `403 forbidden`.

## 4. Domain model

- **User**: `id`, `email` (unique, lower-case), `name`, `passwordHash`. **Session**: `id`, `userId`, `tokenHash` (unique), `expiresAt`.
- **Workspace**: `id`, `name`, `allowExternalSharing`, `permEpoch` (bigint). **WorkspaceMember**: `workspaceId`, `userId`, `role`; unique pair; partial unique index on `(workspaceId) WHERE role = 'owner'`.
- **Doc**: `id`, `workspaceId`, `title` (1–200), `ownerId`, `workspaceAccess`, `headSeq` (bigint, default 0), `snapshotSeq` (bigint, default 0), `logBytes` (bytes of updates after the snapshot), `snapshotBytes`, `permEpoch` (bigint), `trashedAt?`, `trashedBy?`, timestamps.
- **DocShare**: `docId`, `userId`, `role` (`viewer` | `commenter` | `editor`); unique pair.
- **DocLink**: `id`, `docId`, `tokenHash` (unique; token is 32 random bytes, base64url, shown once), `role`, `expiresAt?`, `revokedAt?`, `createdBy`.
- **DocUpdate**: `docId`, `seq`, `update` (bytea), `userId?`, `createdAt`; primary key `(docId, seq)`.
- **DocSnapshot**: `docId`, `uptoSeq`, `state` (bytea, a full Yjs state update), `createdAt`; primary key `(docId, uptoSeq)`.
- **DocVersion**: `id`, `docId`, `seq`, `state` (bytea), `kind` (`auto` | `named` | `pre_restore`), `label?` (1–100, required for `named`), `createdBy?`, `createdAt`.
- **CommentThread**: `id`, `docId`, `anchorStart`, `anchorEnd` (bytea, encoded Yjs relative positions), `quotedText` (max 200), `status` (`open` | `resolved`), `createdBy`, `resolvedBy?`, `resolvedAt?`, `createdAt`. **Comment**: `id`, `threadId`, `authorId`, `body` (1–4000, plain text), `createdAt`, `editedAt?`, `deletedAt?`.

Checks: `head_seq >= snapshot_seq >= 0`; `doc_updates.seq > 0`; octet length of `update` bounded by `MAX_DOC_BYTES` (5.5); partial unique index on `doc_versions (doc_id, seq) WHERE kind = 'auto'`.

## 5. Domain rules

### 5.1 Wire protocol

`GET /ws/docs/:docId[?link=<token>]`, binary frames only. Each frame starts with a `lib0` varUint message type:

| Type | Direction | Body |
|---|---|---|
| `0` sync | both | A `y-protocols/sync` message: SyncStep1 (state vector), SyncStep2 (update) or Update |
| `1` awareness | both | varUint8Array holding a `y-protocols/awareness` update |
| `2` control | server → client | varString holding JSON: `{ "type": "hello", "role", "connectionId", "userId" }`, `{ "type": "role", "role" }`, `{ "type": "meta", "title" }`, `{ "type": "comments_changed" }` |

Close codes: `4400` malformed or disallowed frame, `4401` session ended, `4403` access lost or operation not allowed for the role, `4404` document trashed or deleted, `4413` message or document too large, `4429` rate limited, `1001` server shutting down. A text frame, an unknown type, a client-sent control frame or trailing bytes after a message → `4400`.

### 5.2 Connecting

On `upgrade`, before the handshake completes: check `Origin`; resolve the session cookie (a missing or expired session means anonymous); resolve the effective role (section 3) including the `link` query token. No access, unknown document or trashed document → plain HTTP `404` response on the socket and no upgrade. More than `MAX_CONNECTIONS_PER_USER_PER_DOC` (default 8) on this instance for one user → HTTP `429`. Anonymous connections are not counted per user; they share one per-document limit on each instance, `MAX_ANONYMOUS_CONNECTIONS_PER_DOC` (default 50), with the same `429`.

After the upgrade the server joins the connection to the document's room (5.4), then sends, in order: `hello`; for roles `editor` and `owner` a SyncStep1 with the room's state vector; and the current awareness states. It answers a client's SyncStep1 with a SyncStep2 containing what the client lacks. Read-only connections (`viewer`, `commenter`) are never sent a SyncStep1.

The connection records the role, `userId`, `sessionId`, `sessionExpiresAt`, the link id and `linkExpiresAt` if a link contributed, and the `(doc.permEpoch, workspace.permEpoch)` pair it was authorised under.

### 5.3 Inbound messages

Every inbound frame, in this order:

1. **Rate**: a token bucket per connection (`WS_RATE_PER_SEC` default 50, burst 100, driven by the injected clock) → `4429` when empty.
2. **Expiry**: if `now >= sessionExpiresAt` → `4401`. If a link contributed to the role and it has expired, the role is recomputed without it.
3. **Decode** per 5.1.
4. **Sync frames**:
   - SyncStep1: reply with SyncStep2. Allowed for every role.
   - SyncStep2 or Update from a read-only connection → `4403`, whatever the payload.
   - SyncStep2 or Update from an editor: payload over `MAX_UPDATE_BYTES` (262,144) → `4413`; this limit is for inbound frames only, and updates the server writes itself (5.8) are bounded by the document cap. The payload must parse with `Y.decodeUpdate` and apply cleanly to an empty `Y.Doc`; failure of either → `4400`, and nothing is stored. An update with no structs and no deletions is dropped without further work. Otherwise it goes to the append path (5.5).
5. **Awareness frames**: anonymous connections may not send them (`4403`). The update is decoded entry by entry (client id, clock, JSON state). Every entry must use the single awareness client id this connection first announced; another id → `4403`. If another connection in the room on this instance already holds the announced id: when it belongs to the same user (a client that reconnected before its old socket closed) the id moves to the new connection and the old one is closed with `1000`; when it belongs to another user the new connection is closed `4403`. State JSON over 2,048 bytes, or not an object or `null` → `4400`. The server replaces `state.user` with `{ id, name }` of the authenticated user (keeping only a `color` string of at most 16 chars and a `cursor` object with integer `anchor` and `head` from the client), re-encodes, applies it to the room's `Awareness`, sends it to the room's other local connections and publishes it on the bus. Awareness is never persisted.

When a connection closes for any reason, its awareness state is removed and the removal is broadcast and published, unless its client id has moved to another connection.

### 5.4 Rooms and multi-instance fan-out

A **room** is an instance's in-memory state for one open document: a `Y.Doc`, an `Awareness`, the local connections, `appliedSeq` (every update with `seq <= appliedSeq` has been applied), a buffer of updates with higher seqs, and a serial task queue.

- **Opening**: concurrent first connections share one load. The room subscribes to the document's Redis channel first, then loads in a single `REPEATABLE READ` read-only transaction: the snapshot with the greatest `uptoSeq` (if any) and all updates with `seq > uptoSeq` in order. `appliedSeq` is the greatest seq read (or the snapshot's). Bus messages that arrived during the load are integrated afterwards.
- **Integrating `(seq, update)`** (same routine for local appends, bus messages and catch-up rows): `seq <= appliedSeq` → ignore. `seq = appliedSeq + 1` → apply, advance, then drain the buffer while it continues contiguously. Otherwise buffer it and run a catch-up.
- **Catch-up**: in one `REPEATABLE READ` read-only transaction read `docs.snapshot_seq`; if it is greater than `appliedSeq`, read that snapshot and apply its state and set `appliedSeq` to it; then read updates with `seq > appliedSeq` in order and integrate them. A stored update that fails to apply is logged and skipped, and `appliedSeq` moves past it; every other place that rebuilds a document from snapshot and log (versions, restore, comments, compaction) skips it in the same way, so all of them produce the same state. A catch-up also runs for every open room when the subscriber connection becomes ready again after a disconnect, and every `CATCHUP_INTERVAL_MS` (default 10,000) for rooms whose `docs.head_seq` (one query for all open rooms) is ahead of `appliedSeq`.
- **Broadcast**: the room listens to the `Y.Doc` `update` event and sends each resulting delta as a sync Update frame to every local connection except the one given as the transaction origin. Nothing else sends content to clients.
- **Bus**: channel `doc:<docId>` carries JSON `{ kind, instanceId, … }` with kinds `update` (`seq`, `update` base64), `awareness` (`update` base64), `perm`, `meta` (`title`), `comments`, `trashed`. An instance ignores every message carrying its own `instanceId`: the instance that makes a change applies it to its own rooms first (the update or awareness state, or the `perm`, `meta`, `comments` or `trashed` effect on its local connections) and then publishes, so its own clients are told even when Redis is unavailable. Channel `control` carries `{ kind: "workspace_perm", workspaceId }` and `{ kind: "session_ended", sessionId }`.
- **Closing**: a room with no connections is destroyed after `ROOM_IDLE_MS` (default 30,000); it unsubscribes last. A connection arriving while it is closing gets a fresh room.
- Awareness states received from other instances that are not refreshed for 30 s are dropped by the `Awareness` timeout, which covers an instance that died.

### 5.5 Append path

All work for one room's appends runs through the room's serial queue. For one update from connection C:

1. One transaction:
   - `UPDATE docs SET head_seq = head_seq + 1, log_bytes = log_bytes + <len> WHERE id = $1 AND trashed_at IS NULL RETURNING head_seq, perm_epoch, workspace_id, snapshot_bytes, log_bytes`. No row → roll back, close `4404`.
   - If either epoch differs from the pair on the connection, recompute the effective role from the database inside this transaction and store the new role and epochs on the connection. Role below `editor` → roll back, close `4403`.
   - If `snapshot_bytes + log_bytes > MAX_DOC_BYTES` (5,242,880) → roll back, close `4413`.
   - Insert the `doc_updates` row with the returned seq and `userId`.
2. After commit: integrate `(seq, update)` into the room with C as origin, then publish the `update` bus message.

If the transaction fails for another reason, the connection is closed with `1011` and nothing is applied or broadcast. An update is never applied to the room, sent to another client or published before its row has committed. A failed publish is logged; other instances recover through catch-up.

Server-generated updates (version restore, 5.8) use the same path with no origin connection and are integrated into the local room only if one is open.

### 5.6 Permission changes while connected

Every change that can alter someone's effective role bumps an epoch in the same transaction as the change: `docs.perm_epoch` for share create/update/delete, link create/revoke, `workspace_access` change, ownership transfer, trash and restore; `workspaces.perm_epoch` for member add/remove/role change, `allowExternalSharing` change and workspace transfer. After commit the service re-evaluates the affected connections on its own instance, then publishes `perm` on the document channel or `workspace_perm` on `control`. Logout deletes the session, closes that session's sockets on its own instance and publishes `session_ended`.

On such a message, and independently every `PERM_SWEEP_MS` (default 15,000) for all open rooms (comparing stored epochs with one query, and checking that the sessions of open connections still exist and are unexpired), the instance re-evaluates each affected connection from the database:

- no access → close `4403`; document trashed → `4404`; session gone or expired → `4401`;
- role changed → update the connection, send `{ "type": "role" }`; a connection that becomes `editor` is sent a SyncStep1.

The epoch comparison in 5.5 applies regardless of whether a bus message or a sweep has been seen.

### 5.7 Compaction

The worker compacts a document when `head_seq − snapshot_seq >= COMPACT_MIN_UPDATES` (default 200) or `log_bytes >= COMPACT_MIN_BYTES` (default 1,048,576). Per document, in one transaction:

1. `SELECT … FROM docs WHERE id = $1 FOR UPDATE`; re-check the thresholds; let `H = head_seq`.
2. Read the latest snapshot and the updates with `uptoSeq < seq <= H`; build the merged state by applying them to a fresh `Y.Doc` and encoding the full state.
3. Insert the snapshot `(docId, H, state)`; delete updates with `seq <= H`; delete older snapshots of the document; set `snapshot_seq = H`, `snapshot_bytes = length(state)`, `log_bytes = 0`.

Candidates are picked with `FOR UPDATE SKIP LOCKED` one at a time so several workers do not wait on each other. Trashed documents are not compacted. Compaction never changes `head_seq` and never sends anything to clients.

### 5.8 Versions

- A version stores the full state at some `seq`. `named` versions are created by `POST /docs/:id/versions` (`{ label }`); the state is read from the database in one `REPEATABLE READ` transaction (snapshot + log) and `seq` is the head read there.
- The worker creates an `auto` version for a document when `head_seq` is greater than the `seq` of its newest version and that version (or the document, if none) is at least `AUTO_VERSION_MINUTES` (default 10) old. It keeps the newest 50 `auto` versions per document; `named` and `pre_restore` versions are kept until the document is purged.
- **Restore** (`POST /docs/:id/versions/:versionId/restore`): load the current state from the database into a temporary `Y.Doc` at head `H`; if the current text equals the version's text, return `200` with `changed: false` and write nothing. Otherwise compute the single replaced range between current and target text by common prefix and suffix over UTF-16 code units, never splitting a surrogate pair; apply delete + insert in one Yjs transaction; capture the resulting update. In one database transaction insert a `pre_restore` version (state at `H`) and append the update through 5.5 (attributed to the restoring user). This update may be larger than `MAX_UPDATE_BYTES`; only the document cap applies, and a restore that would exceed it is `422 invalid_state` with nothing written. The restored text is merged like any edit: concurrent edits by others survive where they do not overlap the replaced range.
- History is never rewritten; restoring adds to it. Version states are immutable.

### 5.9 Comments

- A thread anchors to a non-empty range. The client sends `anchor: { start, end }` as base64 of `Y.encodeRelativePosition`, created with `Y.createRelativePositionFromTypeIndex(content, startIndex, 0)` and `(content, endIndex, -1)`.
- On create the server decodes both, resolves them against the document's current state (the open room if this instance has one, otherwise a state loaded from the database) with `Y.createAbsolutePositionFromRelativePosition`. Either unresolvable → `409 anchor_unknown` (the client's edit has not reached the server yet; the client retries). Both must belong to `content`; `start < end` after resolution else `422 empty_anchor`. `quotedText` is taken by the server from the resolved range (first 200 code units), not from the client.
- `GET /docs/:id/threads` resolves every thread against current state and returns `range: { start, end }` and `detached`. A thread is `detached` when an anchor cannot be resolved or `start >= end` (its text was deleted); it is still returned with its `quotedText`. Threads are never deleted by edits.
- Text inserted inside the range extends it; text inserted immediately before the first or after the last anchored character is outside it.
- Replies: 1–4000 chars. A deleted comment keeps its row with `body` blanked and `deletedAt`; a thread whose first comment is deleted stays. Replying to a `resolved` thread reopens it.
- Every comment mutation, after commit, sends `comments_changed` to the room on its own instance and publishes `comments` on the document channel; other instances send `comments_changed` to their rooms and clients refetch. The UI also refetches on reconnect.

### 5.10 Trash

Trash sets `trashedAt`; open connections are closed `4404` (via `trashed` bus message and the sweep). Restore clears it. The worker purges documents trashed more than `TRASH_RETENTION_DAYS` (default 30) ago, deleting updates, snapshots, versions, threads, shares and links with the document in one transaction. An update that reaches the append path after trashing is not stored.

### 5.11 Client behaviour (thin)

- `provider.ts`: opens the socket, sends SyncStep1 on open, applies inbound sync and awareness frames, sends local document updates only when the last announced role is `editor` or `owner`, reconnects with back-off `min(30 s, 500 ms × 2^n)` plus up to 20% jitter, and on reconnect sends its state vector again. Close codes `4401`, `4403` and `4404` stop reconnection and show a message.
- When `hello` or `role` announces a read-only role, the editor becomes read-only and unsent local edits are discarded by rebuilding the local `Y.Doc` from the server.
- `textareaBinding.ts`: turns each `input` event into one delete + insert by prefix/suffix diff, and remote changes into a value update that preserves the caret through relative positions.

## 6. API surface

Prefix `/api`, `camelCase` JSON, error envelope. `401 unauthenticated` without a session except where a `link` token is allowed.

| Method & path | Notes |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/logout`, `GET /auth/me` | Register creates a personal workspace with the user as `owner` |
| `GET/POST /workspaces`, `PATCH /workspaces/:id` | `name`, `allowExternalSharing` |
| `GET/POST /workspaces/:id/members`, `PATCH/DELETE /workspaces/:id/members/:userId` | Add by email of an existing user |
| `POST /workspaces/:id/transfer` | `{ userId }`, target must be a member |
| `GET /workspaces/:id/docs?trashed=`, `POST /workspaces/:id/docs` | List shows documents the caller can access, with their effective role |
| `GET /docs/:id[?link=]`, `PATCH /docs/:id` | `title`, `workspaceAccess`; returns `role` |
| `POST /docs/:id/transfer`, `POST /docs/:id/trash`, `POST /docs/:id/restore` | |
| `GET/POST /docs/:id/shares`, `PATCH/DELETE /docs/:id/shares/:userId` | By email; unknown email → `422 user_not_found` |
| `GET/POST /docs/:id/links`, `DELETE /docs/:id/links/:linkId` | Create returns the token once; delete revokes |
| `GET /docs/:id/threads[?link=]`, `POST /docs/:id/threads` | 5.9 |
| `POST /threads/:id/comments`, `PATCH/DELETE /comments/:id`, `POST /threads/:id/resolve`, `/reopen` | |
| `GET /docs/:id/versions`, `POST /docs/:id/versions`, `GET /versions/:id` (text preview), `POST /docs/:id/versions/:versionId/restore` | 5.8 |
| `GET /ws/docs/:docId` | WebSocket, 5.1–5.6 (outside `/api`) |

Error codes: `validation_failed`, `unauthenticated`, `invalid_credentials`, `forbidden`, `not_found`, `external_sharing_disabled`, `user_not_found`, `not_a_member`, `owner_required`, `anchor_unknown`, `empty_anchor`, `invalid_state`, `internal_error`.

Pages: `/login`, `/register`, `/w/:workspaceId` (document list, members), `/d/:docId` (editor, presence names, comment sidebar, share dialog, version list with preview and restore).

## 7. Background work

| Loop | Process | Interval | Behaviour and failure semantics |
|---|---|---|---|
| Compaction | worker | 30 s | 5.7. A failure rolls back that document and is logged; the document is retried on the next pass |
| Automatic versions | worker | 60 s | 5.8; one transaction per document; insert is skipped if a version with the same `(docId, seq)` already exists |
| Trash purge | worker | hourly | 5.10; batch of 50 |
| Session purge | worker | hourly | Deletes expired sessions |
| Catch-up | server | 10 s | 5.4 |
| Permission sweep | server | 15 s | 5.6 |
| Socket liveness | server | 30 s | Ping every connection; one that has not answered the previous ping is terminated |

All worker loops are safe to run on several workers. Each loop has a `runOnce(now)` for tests.

Shutdown (`SIGTERM`): stop accepting upgrades and HTTP requests, let every room's queue drain, close sockets with `1001`, close Redis and the pool. An update that was accepted from a socket is either committed and published or its connection was closed with an error; none is dropped silently.

## 8. Edge cases

1. A viewer sending an Update or SyncStep2, even an empty one, is closed `4403`; nothing is stored or broadcast.
2. A commenter can create threads over HTTP but its content updates are refused.
3. An anonymous `viewer`-link connection can read and sync but its awareness frames are refused; a `commenter` link presented without a session gives no access.
4. A link used after `expiresAt` or after revocation gives no access on connect; a connection opened through it loses access at the next frame or sweep.
5. A user with both a `viewer` share and an `editor` link has `editor`; when the link is revoked they drop to `viewer` and are told with a `role` message, not disconnected.
6. An editor whose share is deleted while connected: the next update they send is not stored, and the socket closes `4403`, even if the bus message was lost and the sweep has not run.
7. A member removed from the workspace loses every connection in that workspace's documents; documents they owned now belong to the workspace owner.
8. A viewer promoted to editor while connected receives `role` and a SyncStep1 and can edit without reconnecting.
9. Logout in one tab closes that user's sockets opened with the same session with `4401`.
10. A WebSocket upgrade with a foreign `Origin` is refused before the handshake.
11. An upgrade for a document the caller cannot access, a trashed document and a non-existent id all get the same `404`.
12. Two editors on different instances type at once: both converge to the same text, and each update has exactly one row.
13. A bus `update` message that is lost: the receiving instance fills the gap from the database on the next message for that document or at the next catch-up, and its clients receive the missing text.
14. Bus messages arriving as seq 7 then seq 6: both are applied once; `appliedSeq` ends at 7.
15. The same bus message delivered twice is applied once.
16. An instance receives its own published update and ignores it.
17. Redis down: editing on one instance keeps working and persisting; on recovery every open room catches up.
18. A client connects while the room is still loading: it receives a complete state and no update is missed between load and subscribe.
19. Two first connections to a cold document at once create one room and one load.
20. A room that was idle-closed and reopened shows all content written meanwhile through another instance.
21. Compaction running while editors type: no update is lost; `head_seq` is unchanged; the merged state equals snapshot + log.
22. A room opening on another instance during compaction reads either the old snapshot with its full log or the new snapshot, never the old snapshot with a truncated log.
23. An instance whose `appliedSeq` is behind the new `snapshot_seq` catches up from the snapshot.
24. Two workers compacting at once: each document is compacted by one of them.
25. A client that was offline with local edits reconnects: its edits are merged, the server stores them once, and other clients see them.
26. A client that reconnects with nothing new sends an update with no content; no row is written and `head_seq` is unchanged.
27. A client that was demoted to viewer while offline reconnects: it is told its role first and its offline edits are not sent.
28. An update of 262,145 bytes is closed `4413`; 262,144 is accepted. A frame over `maxPayload` is closed by `ws` with `1009`.
29. A malformed update, a text frame and a client-sent control frame are each closed `4400` and leave the room's document unchanged.
30. The 101st frame within one second on a fresh connection is closed `4429`.
31. A document at the size cap refuses further updates with `4413` and remains readable.
32. An awareness frame naming a second client id, or carrying another user's `user.id`, never reaches other clients with that identity.
33. A connection that drops without a close frame disappears from presence on all instances.
34. A comment anchored to "world" in "hello world": inserting text before it shifts the range; inserting inside extends it; typing directly after the "d" does not extend it.
35. Deleting all anchored text makes the thread `detached` with its `quotedText` intact; undoing the deletion by retyping the same letters does not reattach it.
36. Creating a thread with an anchor from a state the server has not received returns `409 anchor_unknown`; the same request succeeds after the edit arrives.
37. A thread with `start` and `end` at the same position is refused.
38. A commenter can resolve their own thread but not another's; replying to a resolved thread reopens it.
39. Restoring a version while another user is typing elsewhere in the document keeps that user's new text.
40. Restoring a version identical to the current text writes nothing and creates no `pre_restore` version.
41. Text containing emoji (surrogate pairs) at the edge of the changed range is restored without broken characters.
42. Restore creates one `pre_restore` version; restoring that version brings back the pre-restore text.
43. The automatic-version loop run twice with no new updates creates one version; only the newest 50 `auto` versions remain.
44. Trashing a document closes its sockets on every instance with `4404`; an update in flight is not stored.
45. Sharing with a non-member when external sharing is off is `422`; turning the setting off removes existing external shares and disconnects those users.
46. Transferring a document to a non-member is `422 not_a_member`; removing or demoting the workspace owner is `422 owner_required`.
47. On `SIGTERM` updates already accepted are persisted before sockets close with `1001`.
48. A client that reconnects with the same awareness client id while its previous socket is still registered is accepted; the previous socket is closed `1000` and the client's presence stays visible to others. The same id announced by a different user is closed `4403`.
49. Restoring a version that replaces more than 262,144 bytes of text succeeds and stores one update; an inbound frame of that size is still closed `4413`.
50. A request to `GET /docs/:id?link=<token>` is logged without the token.
51. With Redis down, a title change, a comment, a permission change and a trash made through one instance reach the sockets connected to that instance at once.
52. An update that decodes but cannot be applied is closed `4400` and not stored; a stored update that cannot be applied is skipped by open rooms and by versions, restore, comments and compaction alike.
53. The 51st anonymous connection to one document on an instance is refused with `429`; signed-in users are unaffected.

## 9. Non-goals

Rich text, images, offline-first storage in the browser, email notifications and mentions, full-text search, folders, document templates, import/export, per-range permissions, end-to-end encryption, HTTP rate limiting, password reset, mobile layout.

## 10. Acceptance criteria

- Clients connected to any mix of instances converge to the same text, and the text rebuilt from snapshot + log equals what clients see.
- No update from a principal whose current effective role is below `editor` is ever stored or broadcast.
- Compaction, room loading and catch-up never lose or duplicate content.
- Access changes take effect on live connections as in 5.6.
- Comments keep pointing at their text through edits and are reported `detached` when it is gone.
- All edge cases in section 8 hold.

## 11. Required tests

Unit (pure):
- Effective-role resolution over every source combination, link expiry boundary, anonymous link rules.
- Protocol codec: each frame type, trailing bytes, unknown type.
- Awareness filter: client-id pinning, identity overwrite, size and shape limits.
- Token bucket with a fake clock.
- Room integration logic with a fake store: in order, out of order, duplicate, gap then catch-up, snapshot ahead of `appliedSeq`.
- Prefix/suffix diff including surrogate pairs; anchor resolution after insert before, inside, after and full deletion.

Integration (Postgres + Redis, real sockets):
- Connect matrix by role, link and anonymity; identical `404`s; `Origin` check.
- Per-message authorisation: viewer update, mid-session revoke with and without the bus message, promotion, logout, trash.
- Two instances: convergence, lost bus message recovery (publisher stubbed to drop), duplicate and reordered messages, Redis reconnect catch-up.
- Append path: one row per update, empty update skipped, size limits, document cap, malformed frames.
- Compaction: equivalence of state, concurrent appends, concurrent room load, two workers.
- Reconnect with state vectors: offline edits merged once; demoted-while-offline client.
- Comments: create, anchor validation, `anchor_unknown`, detached, permissions, resolve/reopen.
- Versions: named, automatic with retention, restore with concurrent edit, no-op restore, `pre_restore`.
- Workspace and sharing constraints: member removal cascade, external sharing toggle, ownership transfer rules.
- Shutdown drains queued appends.

Frontend (Vitest): `textareaBinding` diff and caret preservation; provider back-off schedule and close-code handling with a fake socket.

## 12. Commit plan

1. `chore`: server scaffold (Fastify app factory, config, logger, error envelope, migration runner), compose, `.env.example`.
2. `feat`: migrations and Kysely types for users, workspaces, docs, shares, links, log, snapshots, versions, comments.
3. `feat`: auth and sessions; workspaces and members with relationship constraints.
4. `feat`: documents, shares, links, effective-role resolution, permission epochs, trash.
5. `feat`: doc store (load, append) and protocol codec with unit tests.
6. `feat`: WebSocket upgrade, connection lifecycle, rooms, sync handshake, inbound limits.
7. `feat`: Redis bus, multi-instance integration, catch-up loop.
8. `feat`: awareness filtering and presence fan-out.
9. `feat`: live permission enforcement (epoch checks, bus messages, sweep, session end).
10. `feat`: worker with compaction and trash purge.
11. `feat`: comments with anchors.
12. `feat`: versions (named, automatic, restore).
13. `feat`: web client (auth, document list, editor with provider and binding, comments, sharing, versions).
14. `docs`/`ci`: seed, README with two-instance recipe, CI workflow.
