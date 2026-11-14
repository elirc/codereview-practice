# Decisions

Points where the specification left room for interpretation, and what was chosen.

## Error code for CSRF rejections

The spec requires mutating handlers to check `Content-Type` and `Origin` but names no error code. Both failures return `403 csrf_failed`, so clients can tell a policy rejection apart from a role failure (`403 forbidden`).

## Duplicate registration

Registering an email that already exists returns `409 email_taken`. Self-registration necessarily reveals that an email is in use; login failures still never do.

## Malformed path ids

A path id that is not a UUID cannot exist, so it returns `404 not_found` exactly like a missing row. This keeps "foreign id" and "unknown id" responses identical without a separate `400` shape for appointment ids.
