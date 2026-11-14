# Collab Docs

A real-time collaborative plain-text editor for teams. Documents live in workspaces, can be shared by role or by link, and are edited together over WebSockets with live presence, range-anchored comments and version history. Content is a Yjs document stored as an update log plus snapshots in Postgres, and several server instances stay in step through Redis pub/sub.

## Setup

Requirements: Node 22, Docker (for Postgres 16 and Redis 7).

```sh
cp .env.example .env
docker compose up -d          # Postgres on 5462 (databases collab and collab_test), Redis on 6391
npm install                   # generates package-lock.json
npm run migrate
npm run seed
```

No lockfile is committed; the first `npm install` creates it.

## Run

| Process | Command | Notes |
|---|---|---|
| Server (HTTP + WebSocket) | `npm run start:server` | Port from `PORT` (8100). Any number of instances may run. |
| Worker | `npm run start:worker` | Compaction (30 s), automatic versions (60 s), trash purge and session purge (hourly). Several workers may run. |
| Migrations | `npm run migrate` | Applies `server/migrations/*.sql` and records them in `schema_migrations`. |
| Seed | `npm run seed` | Idempotent; does nothing if the seed owner already exists. |
| Web (dev) | `npm run dev:web` | Vite on 5180, proxying `/api` and `/ws` to `API_TARGET` (default `http://localhost:8100`). |

Two-instance recipe (each browser tab talks to a different server; both share Postgres and Redis):

```sh
PORT=8100 APP_ORIGIN=http://localhost:5180 npm run start:server
PORT=8101 APP_ORIGIN=http://localhost:5181 npm run start:server
npm run start:worker
API_TARGET=http://localhost:8100 WEB_PORT=5180 npm run dev:web
API_TARGET=http://localhost:8101 WEB_PORT=5181 npm run dev:web
```

Open the same document at `http://localhost:5180/d/<id>` and `http://localhost:5181/d/<id>`. Each server must have its own dev server's origin as `APP_ORIGIN`. Cookies are scoped to the host, not the port, so one sign-in covers both tabs.

## Test

```sh
npm run lint
npm run format:check
npm run typecheck
npm run test:unit           # pure logic and the web provider/binding, no services needed
npm run test:integration    # needs compose's Postgres (collab_test) and Redis
```

Integration tests read `TEST_DATABASE_URL` and `TEST_REDIS_URL`. They apply migrations themselves, truncate tables between tests, start real server instances on port 0, and drive them with `ws` clients. Background loops are switched off (`LOOPS_ENABLED=false`). Tests call each loop's `runOnce`-style function directly with a fake clock.

## Architecture

```
server/
  migrations/            plain SQL, applied in order by the migration runner
  src/
    config/              environment parsing (one module, fails fast)
    db/                  Kysely setup, table types, migration runner
    domain/              pure logic: roles and effective role, text diff, anchors, token bucket
    services/            auth, workspaces, documents, sharing, comments, versions, access resolution
    http/                Fastify app, request hooks, error envelope, routes
    collab/              rooms, room registry, doc store, Redis bus, awareness filter
    ws/                  upgrade, connections, frame codec and handler, access monitor, limits
    worker/              compaction, automatic versions, trash and session purge, loop runner
    instance.ts          wires one server instance (HTTP + WebSocket + bus)
    main.ts, seed.ts
  test/unit, test/integration, test/helpers
web/
  src/collab/            provider.ts (socket protocol), textareaBinding.ts, diff
  src/pages, src/components
```

**HTTP request:** Fastify `onRequest` hooks check mutating requests (JSON and `Origin`) and resolve the `cd_session` cookie. The route validates input with zod and calls a service. The service resolves the caller's effective role from the database and does the work in a transaction. After commit it notifies the bus. Errors are rendered by the single error handler.

**WebSocket connection:** the `upgrade` handler checks `Origin`, session, link and role before the handshake. The connection joins the document's room, which is loaded once per instance and subscribed to `doc:<id>`. Each inbound frame is rate-limited, checked for expiry, decoded and handled in order. Updates are appended through the room's queue and sent to the other local connections and to the bus once committed.

**Ownership of state:**

| Owner | Tables / channels |
|---|---|
| Server instances (HTTP) | `users`, `sessions`, `workspaces`, `workspace_members`, `docs` metadata, `doc_shares`, `doc_links`, `comment_threads`, `comments`, named and `pre_restore` rows in `doc_versions` |
| Server instances (WebSocket append path) | `doc_updates`, `docs.head_seq`, `docs.log_bytes` |
| Worker | `doc_snapshots`, `docs.snapshot_seq`/`snapshot_bytes`, `auto` rows in `doc_versions`, deletion of purged documents and expired sessions |
| Redis `doc:<docId>` | `update`, `awareness`, `perm`, `meta`, `comments`, `trashed` messages |
| Redis `control` | `workspace_perm`, `session_ended` messages |

## Where the hard parts live

| Topic | Files |
|---|---|
| Effective role resolution | `server/src/domain/roles.ts`, `server/src/services/access.ts` |
| Upgrade checks and connection lifecycle | `server/src/ws/upgrade.ts`, `server/src/ws/server.ts`, `server/src/ws/connection.ts` |
| Per-frame handling and limits | `server/src/ws/handler.ts`, `server/src/ws/codec.ts`, `server/src/domain/tokenBucket.ts`, `server/src/collab/updates.ts` |
| Append path | `server/src/collab/docStore.ts`, `server/src/collab/room.ts` |
| Room loading, integration and catch-up | `server/src/collab/room.ts`, `server/src/collab/registry.ts` |
| Multi-instance fan-out | `server/src/collab/bus.ts`, `server/src/collab/busMessages.ts`, `server/src/collab/registry.ts` |
| Permission changes on live connections | `server/src/ws/accessMonitor.ts`, `server/src/services/sharing.ts`, `server/src/services/workspaces.ts`, `server/src/services/docs.ts` |
| Presence | `server/src/collab/awarenessFilter.ts`, `server/src/collab/room.ts` |
| Compaction | `server/src/worker/compaction.ts` |
| Versions and restore | `server/src/services/versions.ts`, `server/src/domain/textDiff.ts`, `server/src/worker/autoVersions.ts` |
| Comment anchors | `server/src/domain/anchors.ts`, `server/src/services/comments.ts` |
| Shutdown | `server/src/ws/server.ts`, `server/src/instance.ts` |
| Client sync and reconnect | `web/src/collab/provider.ts`, `web/src/collab/textareaBinding.ts` |

## Seed accounts

All passwords are `password123`.

| Email | Role |
|---|---|
| olivia@example.com | Owner of workspace "Acme Product"; owns "Product plan" and the trashed "Old draft" |
| adam@example.com | Admin of "Acme Product" |
| maya@example.com | Member; owns "Meeting notes" |
| cole@example.com | Member; commenter share on "Meeting notes" |
| erin@example.com | Outside the workspace; viewer share on "Product plan" |

"Product plan" gives workspace members `editor` access and has a named version and an open comment thread. "Meeting notes" gives members `viewer` access.
