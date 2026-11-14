# Decisions

Points the SPEC leaves open, with the choice made and the reason.

1. **Link tokens on HTTP.** The API table shows `?link=` only on `GET /docs/:id` and `GET /docs/:id/threads`. Section 3 makes a link a role source for signed-in users, so every document-scoped endpoint accepts an optional `link` query parameter; only those two GETs work without a session. Links never grant management rights.
2. **No-op updates.** Yjs always sends the whole delete set in a SyncStep2, so "no structs and no deletions" would almost never hold for a reconnecting client that has deleted text. An update is dropped when, diffed against the room's state vector, it has no structs and every deletion it lists is already applied in the room. Anything else is stored as received.
3. **Presence state shape.** The stored state is `{ user: { id, name, color? }, cursor?: { anchor, head } }`. Every other field is dropped. A colour that is not a string of at most 16 characters, or a cursor without integer `anchor` and `head`, is dropped rather than closing the socket.
4. **Shared awareness client ids.** If another local connection in the room has already announced the same awareness client id, the outcome depends on whose it is. For a different user, the new connection is closed `4403`. For the same user (a client reconnecting before its old socket has closed), the id moves to the new connection and the old one is closed with `1000`. The check only sees connections on the same instance.
5. **Empty awareness updates.** An awareness update with zero entries is malformed (`4400`).
6. **Connection limit for anonymous viewers.** `MAX_CONNECTIONS_PER_USER_PER_DOC` counts signed-in users. Anonymous viewer-link connections share a separate per-document limit on each instance, `MAX_ANONYMOUS_CONNECTIONS_PER_DOC` (default 50).
7. **Upgrade statuses other than 404/429.** A foreign or missing `Origin` gets `403`, an upgrade during shutdown gets `503`, and an unexpected failure gets `500`. Unknown paths, bad ids and no access all get the same `404`.
8. **Duplicate registration.** There is no dedicated code, so registering an existing email returns `409 invalid_state`.
9. **Shares.** Sharing with the current owner returns `422 invalid_state`. A `POST` for a user who already has a share changes that share's role.
10. **Document transfer.** The new owner's share on the document is deleted. The previous owner gets no automatic share and keeps whatever other sources grant.
11. **Restore past the size cap.** `422 invalid_state`; nothing is written.
12. **Member management.** Admins and the owner remove members. Removing an admin, appointing one or demoting one is owner-only. There is no self-leave endpoint.
13. **Repeated state changes.** Resolving a resolved thread, reopening an open one, trashing a trashed document, restoring one that is not trashed, and editing or deleting a deleted comment each return `409 invalid_state`.
14. **Listing a workspace's documents.** Non-members see only documents shared with them. If there are none, the workspace answers `404`. The trash list shows only documents the caller can restore.
15. **Link expiry in the past.** `400 validation_failed` on `expiresAt`.
16. **Idle rooms.** Rooms close from a sweep that runs every `min(ROOM_IDLE_MS, 5 s)`, through `RoomRegistry.sweepIdle(now)`, not from a timer per room.
17. **Frames during shutdown.** Once shutdown starts, a frame arriving on a socket closes that socket with `1001` and is not processed. Frames already accepted finish first.
18. **Unresolvable thread anchors.** These are reported with `range: { start: 0, end: 0 }` and `detached: true`.
19. **Own bus messages.** A service notification takes effect on the instance that made the change first, then goes out on Redis. Every message carrying the instance's own id is ignored when it comes back.
20. **Logger dependency.** `pino` 9.6.0 is a direct dependency for the worker, migrate and seed processes. It is the same major version Fastify 5.2 uses for the server.
21. **Comment bodies.** Bodies are stored as typed, with no trimming. The 1–4000 limit counts UTF-16 code units.
22. **Stored update size.** The 262,144-byte limit applies to updates arriving over WebSocket. Stored updates are bounded by the document cap instead, because a restore can write a larger server-generated update.
23. **Updates that do not apply.** An inbound update that decodes but fails to apply to an empty document is closed `4400`. Rebuilding a document from its log skips any stored update that fails to apply, the same way an open room does.
