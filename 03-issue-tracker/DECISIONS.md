# Decisions

Points where the spec left room for interpretation, and what was chosen.

## CSRF rejection code and empty bodies

The spec requires `Content-Type: application/json` and a matching `Origin` on every mutating
request but names no error code. Failures return `403 csrf_rejected`. Because the content type is
mandatory, body-less mutations (logout, archive, deletes) send `{}`; the web client does this
automatically.

## Order of checks

Authentication (`401`) and the CSRF check run in `onRequest`; schema validation (`400`) runs
before the tenant `preHandler` named in the spec. A non-member sending a malformed body therefore
gets `400`, which is identical for existing and non-existing organisations and so reveals nothing.

## Renaming an org

"Rename" is read as changing the display name. `PATCH /orgs/:orgSlug` accepts `name` only; the
slug is immutable because it is part of every URL and of the frontend cache keys.

## Member list order

The spec asks for cursor pagination on members without naming an order. Memberships carry a
`created_at` (join time) and the list is ordered `created_at asc, user_id asc`, with cursor sort
`joined`.

## Demoting an assignee to viewer

Viewers cannot be assignees. Changing a member's role to `viewer` therefore unassigns their issues
in the same transaction, bumping each issue's `version`, exactly as removal does.

## Leaving versus removing

`DELETE /members/me` and `DELETE /members/<own id>` are both treated as leaving, which any role
may do subject to the last-owner rule.
