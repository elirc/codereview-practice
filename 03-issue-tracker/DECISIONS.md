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
